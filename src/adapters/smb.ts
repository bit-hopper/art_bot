import { unflatten } from "devalue";
import { classify, classWeight } from "../classify.js";
import { loadProfile, loadSmbConfig, type FilterProfile, type SmbSourceConfig } from "../config.js";
import { HttpClient } from "../http.js";
import { htmlToText } from "../text.js";
import type { Artwork, IndexRow, MuseumAdapter, RegionGroup, RightsStatus } from "../types.js";

const SITE = "https://search.smb.museum";
const PAGE_SIZE = 300; // server caps `limit` at 300 (M0 spike)

interface SmbNameLine {
  nameLine?: string;
  role?: string;
}

export interface SmbImage {
  license?: string | null;
  photographer?: string | null;
  asset_content?: string | null;
  xl_path?: string | null;
  xl_path_width?: number | null;
  xl_path_height?: number | null;
}

/** The subset of the embedded object record this adapter reads. */
export interface SmbRecord {
  id: string;
  ident?: string | null;
  title?: string | null;
  org_unit?: string | null;
  term?: string | null;
  html_text?: string | null;
  dating?: SmbNameLine[];
  material_desc?: string | null;
  dimensions?: SmbNameLine[];
  geography?: SmbNameLine[];
  provenance?: Array<SmbNameLine | string>;
  permalink?: string | null;
  acq_note?: string | null;
  images?: SmbImage[];
}

interface SearchRow {
  id: string;
  objekttyp?: string | null;
  sammlung?: string | null;
}

interface SearchResponse {
  artworks: SearchRow[];
  total: number;
}

// Nuxt wraps values in reactive helpers; for a read-only payload they all unwrap to the inner value.
const NUXT_REVIVERS: Record<string, (v: unknown) => unknown> = {
  Reactive: (v) => v,
  ShallowReactive: (v) => v,
  Ref: (v) => v,
  ShallowRef: (v) => v,
  EmptyRef: () => undefined,
  EmptyShallowRef: () => undefined,
};

/** Decode `__NUXT_DATA__` with the real devalue parser (the spec forbids regex-scraping fields). */
export function parseObjectPage(html: string): SmbRecord {
  const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("SMB page has no __NUXT_DATA__ payload");
  const root: unknown = unflatten(JSON.parse(m[1]!), NUXT_REVIVERS);

  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    if (!Array.isArray(n) && "ident" in n && "images" in n) return n as SmbRecord;
    stack.push(...(Array.isArray(n) ? n : Object.values(n)));
  }
  throw new Error("SMB payload has no object record");
}

function lines(list: SmbNameLine[] | undefined): string[] {
  return (list ?? []).map((l) => l.nameLine?.trim() ?? "").filter(Boolean);
}

/** `nameLine`s alternate German and "Datierung engl.: ..." variants; keep the first German one. */
function pickDate(dating: SmbNameLine[] | undefined): string | null {
  const first = lines(dating).find((l) => !/^datierung engl\.?:/i.test(l));
  return first ? first.replace(/^historische datierung:\s*/i, "") : null;
}

function pickDimensions(dimensions: SmbNameLine[] | undefined): string | null {
  const ls = lines(dimensions).filter((l) => !/^gewicht:/i.test(l));
  return ls.length > 0 ? ls.join("; ") : null;
}

function geo(rec: SmbRecord, ...roles: string[]): string | null {
  const hit = (rec.geography ?? []).find((g) => g.role && roles.includes(g.role) && g.nameLine);
  return hit?.nameLine?.trim() ?? null;
}

export function licenseRights(license: string | null | undefined, cfg: SmbSourceConfig): RightsStatus {
  if (!license) return "blocked";
  for (const mode of ["open", "attributed", "attributed-nc"] as const) {
    if (cfg.allowed_licenses[mode].includes(license)) return mode;
  }
  return "blocked";
}

const FRONT = /vorder|gesamt|front|overall/i;

/** Spec 3.3 image choice: prefer the primary/front view among postable images, else the first postable one. */
export function chooseImage(images: SmbImage[] | undefined, cfg: SmbSourceConfig): SmbImage | null {
  const postable = (images ?? []).filter((i) => i.xl_path && licenseRights(i.license, cfg) !== "blocked");
  return postable.find((i) => !i.asset_content || FRONT.test(i.asset_content)) ?? postable[0] ?? null;
}

function regionGroupFor(orgUnit: string | null, country: string | null, cfg: SmbSourceConfig): RegionGroup {
  if (cfg.org_units_egypt.includes(orgUnit ?? "")) return "egypt";
  if (country && cfg.egypt_terms.includes(country)) return "egypt";
  if (country && cfg.north_africa_terms.includes(country)) return "north-africa";
  return country ? "sub-saharan" : "unspecified-africa";
}

export function normaliseSmbRecord(rec: SmbRecord, cfg: SmbSourceConfig, profile: FilterProfile): Artwork {
  const numericId = rec.id.replace(/^obj-/, "");
  const image = chooseImage(rec.images, cfg);
  const country = geo(rec, "Land", "Land/Region");
  const provenance = (rec.provenance ?? [])
    .map((p) => (typeof p === "string" ? p : p.nameLine ?? ""))
    .filter(Boolean)
    .join(" ");

  return {
    key: `smb:${numericId}`,
    source: "smb",
    sourceObjectId: numericId,
    accessionNumber: rec.ident?.trim() || null,
    // Most ethnological records carry no title; the object type is the museum's own wording and the fallback.
    title: rec.title?.trim() || rec.term?.trim() || null,
    objectType: rec.term?.trim() || null,
    objectClass: classify(rec.term, profile),
    culture: geo(rec, "Ethnie"),
    country,
    region: geo(rec, "Region"),
    regionGroup: regionGroupFor(rec.org_unit ?? null, country, cfg),
    dateDisplay: pickDate(rec.dating),
    medium: rec.material_desc?.trim() || null,
    dimensions: pickDimensions(rec.dimensions),
    department: rec.org_unit ?? null,
    creditLine: null,
    description: htmlToText(rec.html_text),
    // Record text only, never written by us (spec 7.4). `acq_note` is filled far more often than `provenance`.
    provenanceNote: htmlToText(rec.acq_note) ?? htmlToText(provenance),
    onView: false,
    gallery: null,
    imageUrl: image ? `${SITE}/media${image.xl_path}` : null,
    imageLicense: image?.license ?? null,
    photographer: image?.photographer ?? null,
    rightsStatus: image ? licenseRights(image.license, cfg) : "blocked",
    objectUrl: rec.permalink ?? `${SITE}/en/object/${rec.id}`,
  };
}

/** Index-time region group: from the country terms the object matched (the search rows carry no geography). */
export function regionGroupFromTerms(terms: Iterable<string>, cfg: SmbSourceConfig): RegionGroup {
  const set = new Set(terms);
  if (cfg.egypt_terms.some((t) => set.has(t))) return "egypt";
  if (cfg.north_africa_terms.some((t) => set.has(t))) return "north-africa";
  for (const t of set) if (t !== "Afrika") return "sub-saharan";
  return "unspecified-africa";
}

export class SmbAdapter implements MuseumAdapter {
  readonly id = "smb";
  readonly kind = "scrape" as const;
  readonly rightsMode: SmbSourceConfig["rights_mode"];
  readonly enabled: boolean;

  constructor(
    private readonly cfg: SmbSourceConfig = loadSmbConfig(),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({ minIntervalMs: cfg.min_interval_ms, stopOnBlock: true }),
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
  }

  private async search(params: Record<string, string>): Promise<SearchResponse> {
    const q = new URLSearchParams({ has_images: "true", limit: String(PAGE_SIZE), ...params });
    return this.http.getJson<SearchResponse>(`${SITE}/api/objects/search-expert?${q}`);
  }

  private async drain(params: Record<string, string>): Promise<SearchRow[]> {
    const rows: SearchRow[] = [];
    for (;;) {
      const page = await this.search({ ...params, start: String(rows.length) });
      rows.push(...page.artworks);
      if (page.artworks.length === 0 || rows.length >= page.total) return rows;
    }
  }

  /**
   * Enumerates Africa country by country (the portal's geography filter has no continent hierarchy) plus the whole
   * Egyptian Museum, unions by id, classifies from the object type and yields scored rows. Archive and specimen
   * objects (weight 0) are dropped here, never indexed.
   */
  async *buildIndex(): AsyncIterable<IndexRow> {
    const byId = new Map<string, { cls: ReturnType<typeof classify>; terms: Set<string>; egypt: boolean }>();

    for (const unit of this.cfg.org_units_africa) {
      for (const term of this.cfg.africa_terms) {
        for (const row of await this.drain({ org_units: unit, geographicalReferences: term })) {
          const e = byId.get(row.id) ?? { cls: classify(row.objekttyp, this.profile), terms: new Set<string>(), egypt: false };
          e.terms.add(term);
          byId.set(row.id, e);
        }
      }
    }
    for (const unit of this.cfg.org_units_egypt) {
      for (const row of await this.drain({ org_units: unit })) {
        const e = byId.get(row.id) ?? { cls: classify(row.objekttyp, this.profile), terms: new Set<string>(), egypt: true };
        e.egypt = true;
        byId.set(row.id, e);
      }
    }

    for (const [id, e] of byId) {
      const weight = classWeight(e.cls, this.profile);
      if (weight <= 0) continue;
      const numericId = id.replace(/^obj-/, "");
      yield {
        key: `smb:${numericId}`,
        source: "smb",
        sourceObjectId: numericId,
        objectClass: e.cls,
        regionGroup: e.egypt ? "egypt" : regionGroupFromTerms(e.terms, this.cfg),
        culture: null, // not in search rows; known only after fetchArtwork
        score: weight,
      };
    }
  }

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    const id = sourceObjectId.startsWith("obj-") ? sourceObjectId : `obj-${sourceObjectId}`;
    const html = await this.http.getText(`${SITE}/en/object/${id}`);
    return normaliseSmbRecord(parseObjectPage(html), this.cfg, this.profile);
  }
}

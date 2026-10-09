import { classWeight } from "../classify.js";
import { loadProfile, loadSourceConfig, type FilterProfile, type SourceConfig } from "../config.js";
import { HttpClient } from "../http.js";
import { htmlToText } from "../text.js";
import type { Artwork, IndexRow, MuseumAdapter, RightsStatus } from "../types.js";
import { africanOrigin, classifyRecord, isFlatFragment, nonEmpty, regionGroupFromPlace, scoreFor } from "./common.js";

const API = "https://openaccess-api.clevelandart.org/api/artworks";
const PAGE = 1000;
const LIST_FIELDS = "id,type,title,culture,department,images";

export interface ClevelandSourceConfig extends SourceConfig {
  departments: string[];
  egypt_departments: string[];
  egypt_culture_terms: string[];
  /** Departments filed by period; a record is kept only when its culture field names an African origin (owner 2026-10-09). */
  origin_departments?: string[];
}

/** The subset of an `/api/artworks` record this adapter reads. */
export interface ClevelandArtwork {
  id: number;
  accession_number?: string;
  share_license_status?: string | null;
  title?: string | null;
  type?: string | null;
  culture?: string[];
  creation_date?: string | null;
  technique?: string | null;
  measurements?: string | null;
  department?: string | null;
  creditline?: string | null;
  description?: string | null;
  current_location?: string | null;
  url?: string | null;
  images?: { web?: { url?: string; width?: string; height?: string } | null } | null;
  provenance?: Array<{ description?: string; date?: string }>;
}

const GENERIC_REGION = /^(africa|(north|south|southern|east|west|central|northeast|northwest|southeast|sub-saharan)(ern)?\s+africa)$/i;

/** "Africa, West Africa, Burkina Faso, possibly Bwa-style maker" -> "Burkina Faso, possibly Bwa-style maker". */
function cultureOf(culture: string[] | undefined): string | null {
  const first = nonEmpty(culture?.[0]);
  if (!first) return null;
  const parts = first.split(",").map((p) => p.trim()).filter((p) => p && !GENERIC_REGION.test(p));
  return parts.length > 0 ? parts.join(", ") : first;
}

export function cultureMatches(culture: string[] | undefined, terms: string[]): boolean {
  const text = (culture ?? []).join(" ").toLowerCase();
  return terms.some((t) => new RegExp(String.raw`\b${t.toLowerCase()}`).test(text));
}

function rightsOf(status: string | null | undefined): { rights: RightsStatus; license: string | null } {
  return status === "CC0" ? { rights: "open", license: "CC0" } : { rights: "reserved", license: nonEmpty(status) };
}

export function normaliseClevelandArtwork(r: ClevelandArtwork, profile: FilterProfile, egyptDept: boolean, originDept = false): Artwork {
  const web = r.images?.web?.url ?? null;
  const { rights, license } = rightsOf(r.share_license_status);
  const loc = nonEmpty(r.current_location);
  const prov = r.provenance?.[0];
  const provText = nonEmpty(prov?.description);
  const culture = cultureOf(r.culture);
  return {
    key: `cleveland:${r.id}`,
    source: "cleveland",
    sourceObjectId: String(r.id),
    accessionNumber: nonEmpty(r.accession_number),
    title: nonEmpty(r.title),
    objectType: nonEmpty(r.type),
    objectClass: classifyRecord(r.type, r.title, profile),
    culture,
    country: null, // part of `culture[]` in this API
    region: null,
    regionGroup: regionGroupFromPlace((r.culture ?? []).join(" "), { egyptDept }),
    dateDisplay: nonEmpty(r.creation_date),
    medium: nonEmpty(r.technique),
    dimensions: nonEmpty(r.measurements),
    department: nonEmpty(r.department),
    creditLine: nonEmpty(r.creditline),
    description: htmlToText(r.description),
    provenanceNote: provText ? (prov?.date ? `${provText} (${prov.date})` : provText) : null,
    onView: loc !== null,
    gallery: loc ? `Gallery ${loc.split(/\s+/)[0]}` : null,
    imageUrl: web,
    imageLicense: license,
    photographer: null,
    rightsStatus: web && (!originDept || africanOrigin(...(r.culture ?? []))) ? rights : "blocked",
    objectUrl: r.url || `https://www.clevelandart.org/art/${r.accession_number ?? r.id}`,
  };
}

export class ClevelandAdapter implements MuseumAdapter {
  readonly id = "cleveland";
  readonly kind = "api" as const;
  readonly rightsMode: SourceConfig["rights_mode"];
  readonly enabled: boolean;

  constructor(
    private readonly cfg: ClevelandSourceConfig = loadSourceConfig<ClevelandSourceConfig>("cleveland"),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({ minIntervalMs: cfg.min_interval_ms, stopOnBlock: true }),
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
  }

  private async *pages(department: string): AsyncGenerator<ClevelandArtwork> {
    for (let skip = 0; ; skip += PAGE) {
      const q = new URLSearchParams({ department, has_image: "1", limit: String(PAGE), skip: String(skip), fields: LIST_FIELDS });
      const res = await this.http.getJson<{ data: ClevelandArtwork[] }>(`${API}/?${q}`);
      yield* res.data;
      if (res.data.length < PAGE) return;
    }
  }

  async *buildIndex(): AsyncIterable<IndexRow> {
    const groups: Array<{ dept: string; egypt: boolean; origin?: boolean }> = [
      ...this.cfg.departments.map((d) => ({ dept: d, egypt: false })),
      ...this.cfg.egypt_departments.map((d) => ({ dept: d, egypt: true })),
      ...(this.cfg.origin_departments ?? []).map((d) => ({ dept: d, egypt: false, origin: true })),
    ];
    for (const { dept, egypt, origin } of groups) {
      for await (const r of this.pages(dept)) {
        if (!r.images?.web?.url) continue;
        if (egypt && !cultureMatches(r.culture, this.cfg.egypt_culture_terms)) continue;
        if (origin && !africanOrigin(...(r.culture ?? []))) continue;
        const cls = classifyRecord(r.type, r.title, this.profile);
        const weight = classWeight(cls, this.profile);
        if (weight <= 0) continue;
        yield {
          key: `cleveland:${r.id}`, source: "cleveland", sourceObjectId: String(r.id), objectClass: cls,
          regionGroup: regionGroupFromPlace((r.culture ?? []).join(" "), { egyptDept: egypt }),
          culture: cultureOf(r.culture), score: scoreFor(weight, { longEdge: Math.max(Number(r.images.web.width) || 0, Number(r.images.web.height) || 0) || null, fragment: isFlatFragment(r.type, r.title) }),
        };
      }
    }
  }

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    const { data } = await this.http.getJson<{ data: ClevelandArtwork }>(`${API}/${sourceObjectId}`);
    const dept = data.department ?? "";
    return normaliseClevelandArtwork(data, this.profile, this.cfg.egypt_departments.includes(dept), (this.cfg.origin_departments ?? []).includes(dept));
  }
}

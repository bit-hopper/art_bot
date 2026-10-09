import { classWeight, matchesTerms } from "../classify.js";
import { loadDenylist, loadProfile, loadSourceConfig, type Denylist, type FilterProfile, type SourceConfig } from "../config.js";
import { denyReason } from "../denylist.js";
import { HttpClient, HttpError, StopCrawlError } from "../http.js";
import type { JsonCache } from "../state.js";
import type { Artwork, IndexRow, MuseumAdapter, RegionGroup } from "../types.js";
import { classifyRecord, isFlatFragment, mapLimit, nonEmpty, regionGroupFromPlace, scoreFor } from "./common.js";

const SITE = "https://collections.louvre.fr";
const SITEMAP_INDEX = `${SITE}/sitemap.xml`;
/** An Egyptian object without an image is looked at again after this many days; any other result is kept. */
const NO_IMAGE_RECHECK_DAYS = 30;
const IDS_MAX_AGE_DAYS = 7;
const CHUNK = 200;

export interface LouvreSourceConfig extends SourceConfig {
  /** The Egyptian Antiquities department's `collection` value. */
  egypt_collections: string[];
  /**
   * Departments that hold African-made work among much else (Greek and Roman, Oriental Antiquities with Phoenician/Punic,
   * Islamic Arts, Byzantine): only objects whose place of creation is African are kept (owner 2026-10-09, origin rule).
   */
  origin_collections?: string[];
  /** Ark id prefixes worth fetching (the other prefix holds prints and drawings). */
  ark_prefixes: string[];
  /** A denomination containing one of these is a broken piece and is not posted (owner, 2026-10-08). */
  exclude_terms: string[];
  max_new_per_run: number;
}

/** Bumped when the selection rule changes, so ids rejected under an older rule are fetched again. */
export const CACHE_VERSION = 2;

export interface LouvreCacheEntry {
  day: number;
  v?: number;
  row: IndexRow | null;
  /** Set on an Egyptian object that had no image yet. */
  retry?: true;
}

export interface LouvreIdsEntry {
  day: number;
  ids: string[];
}

interface LouvreImage {
  urlImage?: string;
  copyright?: string;
  type?: string;
  position?: number;
}

/** The subset of `/ark:/53355/{id}.json` this adapter reads. */
export interface LouvreRecord {
  arkId: string;
  url?: string;
  title?: string;
  denominationTitle?: Array<{ type?: string; value?: string }>;
  displayDateCreated?: string;
  dateCreated?: Array<{ text?: string }>;
  currentLocation?: string;
  room?: string;
  isMuseesNationauxRecuperation?: boolean;
  objectNumber?: Array<{ value?: string; type?: string }>;
  collection?: string;
  description?: string;
  dimension?: Array<{ type?: string; displayDimension?: string }>;
  materialsAndTechniques?: string;
  placeOfCreation?: string;
  provenance?: string;
  objectHistory?: string;
  acquisitionDetails?: Array<{ mode?: string; dates?: Array<{ value?: string; startYear?: number }> }>;
  image?: LouvreImage[];
}

const DIMENSION_LABELS: Record<string, string> = {
  hauteur: "H", largeur: "W", longueur: "L", profondeur: "D", "diamètre": "Diam.", "épaisseur": "Thickness", poids: "Weight",
};
const ACQUISITION_MODES: Record<string, string> = {
  achat: "Purchase", don: "Gift", legs: "Bequest", "ancien fonds": "Former collection", "dépôt": "Deposit",
};

/** The JSON gives an empty string, not an empty list, for some absent lists. */
const arr = <T>(x: T[] | string | null | undefined): T[] => (Array.isArray(x) ? x : []);
const lines = (s: string | undefined): string[] => (s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const EGYPTIAN_ANTIQUITIES = "Département des Antiquités égyptiennes";
const strip = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
// Stems on diacritic-stripped text, French and English, plus the ancient and Roman names the Louvre uses in `placeOfCreation`
// ("Cuicul = Djemila"). Only a leading boundary: "egypte", "tunisie", "copte" end in different letters.
const EGYPT_STEMS = "egypt|copt|fayoum|fayum|alexandri|le caire|caire|cairo|fustat|fostat|oxyrhynch|antinoe|hermopolis|karanis";
const NORTH_STEMS =
  "libya|libye|tunis|alger|morocc|maroc|maghreb|mauretan|numid|cartha|cyren|djemila|cuicul|timgad|thamugadi|tipasa|volubilis|leptis|sabratha|utique|utica|hadrumet|thysdrus|el jem|dougga|thugga|cherchel|cirta|kairouan|fes\\b|fez\\b|marrakech|tlemcen";
const OTHER_STEMS = "nubi|kush|meroit|ethiop|sudan|soudan|afri";
const AFRICAN_STEMS = new RegExp(`\\b(${EGYPT_STEMS}|${NORTH_STEMS}|${OTHER_STEMS})`);

/**
 * Region group of a Louvre `placeOfCreation` that is wholly African, else null. Several places separated by ";" are
 * alternatives (or both): all must be African, as for the Met ("Liban (?) ; Syrie (?)" is not). "A = B" gives the same
 * place under two names and counts once. Find-spots are not read: origin decides (owner 2026-10-09).
 */
export function louvreAfricanPlace(place: string | undefined | null): RegionGroup | null {
  const pieces = strip(place ?? "").split(";").map((x) => x.replace(/\(\?\)/g, "").trim()).filter(Boolean);
  if (pieces.length === 0 || !pieces.every((x) => AFRICAN_STEMS.test(x))) return null;
  const text = pieces.join(" ");
  if (new RegExp(`\\b(${EGYPT_STEMS})`).test(text)) return "egypt";
  if (new RegExp(`\\b(${NORTH_STEMS})`).test(text)) return "north-africa";
  return regionGroupFromPlace(text);
}

/** "serviteur funéraire momiforme (fragment)" and the like: every denomination, since `title` leaves the note out. */
export function denominations(r: LouvreRecord): string[] {
  return arr(r.denominationTitle).filter((d) => d.type !== "Titre").map((d) => nonEmpty(d.value)).filter((v): v is string => v !== null);
}

export function isExcludedPiece(r: LouvreRecord, terms: string[]): boolean {
  const text = [...denominations(r), r.title ?? ""].join(" ; ");
  return matchesTerms(text, terms);
}

/** "© 2017 Musée du Louvre, Dist. GrandPalaisRmn / Christian Décamps" -> credit and photographer. */
export function splitCopyright(c: string | undefined): { credit: string | null; photographer: string | null } {
  const text = nonEmpty(c);
  if (!text) return { credit: null, photographer: null };
  const m = /^(.*?GrandPalaisRmn)\s*\/\s*(.+)$/.exec(text);
  return m ? { credit: m[1]!.trim(), photographer: m[2]!.trim() } : { credit: text, photographer: null };
}

/**
 * First image whose credit does not name another institution: "GrandPalaisRmn (Musée d'Orsay)" needs that institution's
 * agreement (terms of use, art. 4.1).
 */
export function pickImage(images: LouvreImage[] | undefined): LouvreImage | null {
  const ok = arr(images).filter((i) => i.urlImage && !/GrandPalaisRmn\s*\(/i.test(i.copyright ?? ""));
  return ok[0] ?? null;
}

function dateOf(r: LouvreRecord): string | null {
  const text = nonEmpty(arr(r.dateCreated)[0]?.text);
  if (text) return text;
  const first = lines(r.displayDateCreated)[0];
  return nonEmpty(first?.replace(/^[^:]*:\s*/, ""));
}

function mediumOf(r: LouvreRecord): string | null {
  const first = lines(r.materialsAndTechniques).find((l) => /^Mat[ée]riau\s*:/i.test(l)) ?? lines(r.materialsAndTechniques)[0];
  return nonEmpty(first?.replace(/^[^:]*:\s*/, "").replace(/\s*\([^)]*\)/g, ""));
}

function dimensionsOf(r: LouvreRecord): string | null {
  const parts = arr(r.dimension).slice(0, 3).flatMap((d) => {
    const v = nonEmpty(d.displayDimension);
    if (!v) return [];
    const label = DIMENSION_LABELS[(d.type ?? "").toLowerCase()] ?? d.type;
    return [label ? `${label} ${v}` : v];
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

function creditOf(r: LouvreRecord): string | null {
  const a = arr(r.acquisitionDetails)[0];
  const mode = nonEmpty(a?.mode);
  if (!mode) return null;
  const label = ACQUISITION_MODES[mode.toLowerCase()] ?? upperFirst(mode);
  const year = arr(a?.dates).find((d) => d.startYear)?.startYear;
  return year ? `${label}, ${year}` : label;
}

function galleryOf(r: LouvreRecord): string | null {
  const m = /^Salle\s+(\S+?)[,\s]/i.exec(`${r.room ?? ""} `);
  return m ? `Room ${m[1]}` : null;
}

export function normaliseLouvreRecord(r: LouvreRecord, profile: FilterProfile, excludeTerms: string[] = [], egyptCollections: string[] = [EGYPTIAN_ANTIQUITIES]): Artwork {
  const names = denominations(r);
  const type = names.join(" ; ") || nonEmpty(r.title);
  const img = pickImage(r.image);
  const { credit, photographer } = splitCopyright(img?.copyright);
  const gallery = galleryOf(r);
  const broken = isExcludedPiece(r, excludeTerms);
  const egyptian = egyptCollections.includes(r.collection ?? "");
  const place = louvreAfricanPlace(r.placeOfCreation);
  const number = arr(r.objectNumber).find((n) => n.type === "Numéro principal") ?? arr(r.objectNumber)[0];
  return {
    key: `louvre:${r.arkId}`,
    source: "louvre",
    sourceObjectId: r.arkId,
    accessionNumber: nonEmpty(number?.value),
    title: nonEmpty(r.title) ?? names[0] ?? null,
    objectType: type,
    objectClass: classifyRecord(type, r.title, profile),
    culture: nonEmpty(r.placeOfCreation),
    country: egyptian ? "Egypt" : nonEmpty(r.placeOfCreation?.split(";")[0]?.replace(/\(\?\)/g, "").split("=")[0]),
    region: null,
    regionGroup: egyptian ? "egypt" : place ?? "unspecified-africa",
    dateDisplay: dateOf(r),
    medium: mediumOf(r),
    dimensions: dimensionsOf(r),
    department: nonEmpty(r.collection),
    creditLine: creditOf(r),
    description: nonEmpty(lines(r.description).join(" ; ")),
    provenanceNote: nonEmpty(r.objectHistory) ?? nonEmpty(r.provenance),
    onView: gallery !== null,
    gallery,
    imageUrl: img?.urlImage ?? null,
    imageLicense: credit,
    photographer,
    // Owner decision 2026-10-08: a non-profit educational feed falls under the terms' teaching use, so the image is
    // posted with the Louvre's credit and permalink (the terms' only condition). No open licence is claimed.
    // Recovered (MNR) works and broken pieces are not posted.
    rightsStatus: !img || r.isMuseesNationauxRecuperation || broken ? "blocked" : "attributed",
    objectUrl: r.url || `${SITE}/ark:/53355/${r.arkId}`,
  };
}

export class LouvreAdapter implements MuseumAdapter {
  readonly id = "louvre";
  readonly kind = "scrape" as const;
  readonly rightsMode: SourceConfig["rights_mode"];
  readonly enabled: boolean;

  constructor(
    private readonly cfg: LouvreSourceConfig = loadSourceConfig<LouvreSourceConfig>("louvre"),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({ minIntervalMs: cfg.min_interval_ms, stopOnBlock: true }),
    private readonly opts: { maxObjects?: number; cache?: JsonCache<LouvreCacheEntry>; idsCache?: JsonCache<LouvreIdsEntry>; deny?: Denylist } = {},
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
    this.deny = opts.deny ?? loadDenylist();
  }

  /** Applied at index time (spec 7.4), so blocked objects (mummy labels are most of the first ids) never take a pick; the selector checks again before posting. */
  private readonly deny: Denylist;

  /** Set when the build stopped early (per-run cap or a block): the index is what the cache holds, and grows next run. */
  incomplete = false;

  private record(id: string): Promise<LouvreRecord> {
    return this.http.getJson<LouvreRecord>(`${SITE}/ark:/53355/${id}.json`);
  }

  /** The search page sits behind a bot challenge, so objects are listed from the sitemaps (about 25 MB each). */
  private async listIds(today: number): Promise<string[]> {
    const cached = this.opts.idsCache?.get("ids");
    if (cached && today - cached.day <= IDS_MAX_AGE_DAYS) return cached.ids;
    const prefixes = this.cfg.ark_prefixes.join("|");
    const wanted = new RegExp(String.raw`<loc>https://collections\.louvre\.fr/ark:/53355/((?:${prefixes})\d+)</loc>`, "g");
    const ids = new Set<string>();
    try {
      const index = await this.http.getText(SITEMAP_INDEX);
      for (const m of index.matchAll(/<loc>([^<]+sitemap\d+\.xml)<\/loc>/g)) {
        const xml = await this.http.getText(m[1]!);
        for (const hit of xml.matchAll(wanted)) ids.add(hit[1]!);
      }
    } catch (e) {
      // A refused or failed refresh keeps the previous list rather than losing the index.
      if (cached && (e instanceof StopCrawlError || e instanceof HttpError)) return cached.ids;
      throw e;
    }
    const list = [...ids].sort();
    this.opts.idsCache?.set("ids", { day: today, ids: list });
    this.opts.idsCache?.save();
    return list;
  }

  /**
   * One record fetch per object, cached: only the Egyptian Antiquities department is wanted and the sitemap does not say
   * which department an id belongs to. A rebuild fetches only new ids; a block stops the build and it resumes next run.
   */
  async *buildIndex(): AsyncIterable<IndexRow> {
    const today = Math.floor(Date.now() / 86_400_000);
    const all = (await this.listIds(today)).slice(0, this.opts.maxObjects ?? Infinity);
    const cache = this.opts.cache;
    const local = new Map<string, LouvreCacheEntry>();
    const known = (id: string) => cache?.get(id) ?? local.get(id);
    const stale = (e: LouvreCacheEntry | undefined) => !e || e.v !== CACHE_VERSION || (e.retry === true && today - e.day > NO_IMAGE_RECHECK_DAYS);
    const remember = (id: string, entry: LouvreCacheEntry) => (cache ? cache.set(id, entry) : void local.set(id, entry));

    let budget = this.cfg.max_new_per_run;
    try {
      for (let i = 0; i < all.length; i += CHUNK) {
        const wanted = all.slice(i, i + CHUNK).filter((id) => stale(known(id)));
        const todo = wanted.slice(0, budget);
        budget -= todo.length;
        if (todo.length < wanted.length) this.incomplete = true;
        await mapLimit(todo, 1, async (id) => {
          let r: LouvreRecord;
          try {
            r = await this.record(id);
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 404)) throw e;
            return remember(id, { day: today, row: null });
          }
          const a = normaliseLouvreRecord(r, this.profile, this.cfg.exclude_terms, this.cfg.egypt_collections);
          const weight = classWeight(a.objectClass, this.profile);
          const wanted = this.wanted(a, r);
          const row: IndexRow | null =
            !wanted || !a.imageUrl || a.rightsStatus === "blocked" || weight <= 0 || denyReason(a, this.deny) !== null
              ? null
              : { key: a.key, source: "louvre", sourceObjectId: a.sourceObjectId, objectClass: a.objectClass, regionGroup: a.regionGroup, culture: a.culture, score: scoreFor(weight, { fragment: isFlatFragment(a.objectType, a.title) }) };
          remember(id, wanted && !a.imageUrl && !r.isMuseesNationauxRecuperation ? { day: today, v: CACHE_VERSION, row, retry: true } : { day: today, v: CACHE_VERSION, row });
        });
        if (budget <= 0) {
          this.incomplete = true;
          break;
        }
        if (i % (CHUNK * 5) === 0) cache?.save();
      }
    } catch (e) {
      cache?.save();
      if (!(e instanceof StopCrawlError)) throw e;
      this.incomplete = true;
    }
    cache?.save();

    for (const id of all) {
      const row = known(id)?.row;
      if (row) yield row;
    }
  }

  /** Egyptian Antiquities in full; the mixed departments only when the place of creation is African. */
  private wanted(a: Artwork, r: LouvreRecord): boolean {
    const dept = a.department ?? "";
    return this.cfg.egypt_collections.includes(dept) || ((this.cfg.origin_collections ?? []).includes(dept) && louvreAfricanPlace(r.placeOfCreation) !== null);
  }

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    const r = await this.record(sourceObjectId);
    const a = normaliseLouvreRecord(r, this.profile, this.cfg.exclude_terms, this.cfg.egypt_collections);
    return this.wanted(a, r) ? a : { ...a, rightsStatus: "blocked" };
  }
}

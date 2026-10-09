import { classWeight } from "../classify.js";
import { loadProfile, loadSourceConfig, type FilterProfile, type SourceConfig } from "../config.js";
import { HttpClient, HttpError, StopCrawlError } from "../http.js";
import type { JsonCache } from "../state.js";
import type { Artwork, IndexRow, MuseumAdapter, RegionGroup } from "../types.js";
import { africanOrigin, classifyRecord, mapLimit, nonEmpty, regionGroupFromPlace, scoreFor } from "./common.js";

const API = "https://collectionapi.metmuseum.org/public/collection";
const PAGE = 500;
const CHUNK = 200;
/** An object without an image is looked at again after this many days (the Met keeps releasing Open Access images). */
const NO_IMAGE_RECHECK_DAYS = 30;

/** `row` is null when the object has no usable image or an unpostable class. `day` = days since the epoch it was checked. */
export interface MetCacheEntry {
  day: number;
  row: IndexRow | null;
}


export interface MetSourceConfig extends SourceConfig {
  concurrency: number;
  max_new_per_run: number;
  /** `origin_check`: the department also holds non-African work, so each record must state an African place of origin. */
  /**
   * Hand-picked objects that depict Africans or draw on African sources but whose record names no African place (owner
   * 2026-10-09; the Met's metadata cannot find these), e.g. the Nimrud ivory 325089. Not origin-checked.
   */
  extra_objects?: Array<{ id: number; region_group: RegionGroup }>;
  departments: Array<{ id: number; geo_location: string | null; egypt: boolean; origin_check?: boolean }>;
}

/** The subset of `/v1/objects/{id}` this adapter reads. */
export interface MetObject {
  objectID: number;
  isPublicDomain?: boolean;
  primaryImageSmall?: string;
  accessionNumber?: string;
  department?: string;
  objectName?: string;
  title?: string;
  culture?: string;
  objectDate?: string;
  medium?: string;
  dimensions?: string;
  creditLine?: string;
  country?: string;
  region?: string;
  classification?: string;
  objectURL?: string;
  GalleryNumber?: string;
  isHighlight?: boolean;
}

interface SearchResponse {
  total: number;
  objectIDs: number[] | null;
}

/** Departments 5 and 10 are African by construction (Africa filter / Egyptian Art); the others are checked per record. */
const SELF_AFRICAN_DEPARTMENTS = new Set(["Egyptian Art", "The Michael C. Rockefeller Wing"]);

export function metOriginOk(o: MetObject): boolean {
  return SELF_AFRICAN_DEPARTMENTS.has(o.department ?? "") || africanOrigin(o.country, o.culture, o.region);
}

export function normaliseMetObject(o: MetObject, profile: FilterProfile, egyptDept: boolean, regionOverride?: RegionGroup): Artwork {
  const country = nonEmpty(o.country);
  const hasImage = Boolean(o.primaryImageSmall) && o.isPublicDomain !== false;
  const gallery = nonEmpty(o.GalleryNumber);
  return {
    key: `met:${o.objectID}`,
    source: "met",
    sourceObjectId: String(o.objectID),
    accessionNumber: nonEmpty(o.accessionNumber),
    title: nonEmpty(o.title) ?? nonEmpty(o.objectName),
    objectType: nonEmpty(o.objectName),
    objectClass: classifyRecord(o.objectName, o.title, profile, o.classification),
    culture: nonEmpty(o.culture),
    country,
    region: nonEmpty(o.region),
    regionGroup: regionOverride ?? regionGroupFromPlace([country, o.region, o.culture, o.department].filter(Boolean).join(" "), { egyptDept }),
    dateDisplay: nonEmpty(o.objectDate),
    medium: nonEmpty(o.medium),
    dimensions: nonEmpty(o.dimensions),
    department: nonEmpty(o.department),
    creditLine: nonEmpty(o.creditLine),
    description: null, // the Met API has none
    provenanceNote: null, // nor a provenance field: only creditLine, which the reply already prints
    onView: gallery !== null,
    gallery: gallery ? `Gallery ${gallery}` : null,
    imageUrl: hasImage ? o.primaryImageSmall! : null,
    // The API serves an image URL only for Open Access objects, which the Met releases under CC0.
    imageLicense: hasImage ? "CC0" : null,
    photographer: null,
    rightsStatus: hasImage ? "open" : "blocked",
    objectUrl: o.objectURL || `https://www.metmuseum.org/art/collection/search/${o.objectID}`,
  };
}

export class MetAdapter implements MuseumAdapter {
  readonly id = "met";
  readonly kind = "api" as const;
  readonly rightsMode: SourceConfig["rights_mode"];
  readonly enabled: boolean;

  constructor(
    private readonly cfg: MetSourceConfig = loadSourceConfig<MetSourceConfig>("met"),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({ minIntervalMs: cfg.min_interval_ms, stopOnBlock: true }),
    private readonly opts: { maxObjects?: number; cache?: JsonCache<MetCacheEntry> } = {},
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
  }

  private async ids(dept: MetSourceConfig["departments"][number]): Promise<number[]> {
    const out: number[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const q = new URLSearchParams({ departmentId: String(dept.id), hasImages: "true", q: "*", limit: String(PAGE), offset: String(offset) });
      if (dept.geo_location) q.set("geoLocation", dept.geo_location);
      const page = await this.http.getJson<SearchResponse>(`${API}/v1.1/search?${q}`);
      const got = page.objectIDs ?? [];
      out.push(...got);
      if (got.length === 0 || out.length >= page.total) return out;
    }
  }

  private object(id: number | string): Promise<MetObject> {
    return this.http.getJson<MetObject>(`${API}/v1/objects/${id}`);
  }

  /** Set when the build stopped early (per-run cap or a WAF block): the index is what the cache holds, and grows next run. */
  incomplete = false;

  /**
   * The search returns bare ids, so each object is fetched once: that is the only way to know its type and whether the
   * API serves an image (it does so only for Open Access objects). Results are cached on disk, so a rebuild fetches only
   * new ids; if the Met's WAF blocks us the build stops, keeps what it has, and continues on the next run.
   */
  async *buildIndex(): AsyncIterable<IndexRow> {
    const egyptById = new Map<number, boolean>();
    const checkById = new Map<number, boolean>();
    for (const dept of this.cfg.departments) {
      for (const id of await this.ids(dept)) {
        egyptById.set(id, (egyptById.get(id) ?? false) || dept.egypt);
        checkById.set(id, (checkById.get(id) ?? true) && !!dept.origin_check);
      }
    }
    const override = new Map((this.cfg.extra_objects ?? []).map((x) => [x.id, x.region_group]));
    for (const id of override.keys()) {
      egyptById.set(id, egyptById.get(id) ?? false);
      checkById.set(id, false);
    }
    const all = [...egyptById.keys()].slice(0, this.opts.maxObjects ?? Infinity);
    const cache = this.opts.cache;
    const today = Math.floor(Date.now() / 86_400_000);
    const local = new Map<number, MetCacheEntry>();
    const known = (id: number) => cache?.get(String(id)) ?? local.get(id);
    const stale = (e: MetCacheEntry | undefined) => !e || (e.row === null && today - e.day > NO_IMAGE_RECHECK_DAYS);

    let budget = this.cfg.max_new_per_run;
    try {
      for (let i = 0; i < all.length; i += CHUNK) {
        const wanted = all.slice(i, i + CHUNK).filter((id) => stale(known(id)));
        const todo = wanted.slice(0, budget);
        budget -= todo.length;
        if (todo.length < wanted.length) this.incomplete = true;
        await mapLimit(todo, this.cfg.concurrency, async (id) => {
          let o: MetObject;
          try {
            o = await this.object(id);
          } catch (e) {
            // The search still lists ids whose object record was removed (404): remember them as unpostable.
            if (!(e instanceof HttpError && e.status === 404)) throw e;
            const gone = { day: today, row: null };
            if (cache) cache.set(String(id), gone);
            else local.set(id, gone);
            return;
          }
          const a = normaliseMetObject(o, this.profile, egyptById.get(id) ?? false, override.get(id));
          const weight = classWeight(a.objectClass, this.profile);
          const row: IndexRow | null =
            !a.imageUrl || weight <= 0 || (checkById.get(id) && !metOriginOk(o))
              ? null
              : {
                  key: a.key, source: "met", sourceObjectId: a.sourceObjectId, objectClass: a.objectClass,
                  regionGroup: a.regionGroup, culture: a.culture, score: scoreFor(weight, { highlight: o.isHighlight }),
                };
          const entry = { day: today, row };
          if (cache) cache.set(String(id), entry);
          else local.set(id, entry);
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

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    const o = await this.object(sourceObjectId);
    const extra = (this.cfg.extra_objects ?? []).find((x) => x.id === o.objectID);
    const a = normaliseMetObject(o, this.profile, o.department === "Egyptian Art", extra?.region_group);
    return extra || metOriginOk(o) ? a : { ...a, rightsStatus: "blocked" };
  }
}

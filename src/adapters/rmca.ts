import { classWeight } from "../classify.js";
import { loadProfile, loadSourceConfig, type FilterProfile, type SourceConfig } from "../config.js";
import { HttpClient } from "../http.js";
import { decodeEntities } from "../text.js";
import type { Artwork, IndexRow, MuseumAdapter } from "../types.js";
import { classifyRecord, nonEmpty, regionGroupFromPlace, scoreFor } from "./common.js";

/**
 * Royal Museum for Central Africa (AfricaMuseum, Tervuren). Its only machine-readable collection is the old human-sciences
 * database (robots.txt allows crawling; the museum's data policy is CC BY-NC-SA 2.0 BE). The listing pages carry everything the
 * index needs; the object page adds materials and dimensions at post time. A blank search lists all ~26,000 records ten at a time.
 */
const BASE = "https://webarch.africamuseum.be/collections/browsecollections/humansciences";
const PAGE = 10;
const LICENSE = "CC BY-NC-SA 2.0 BE";

export interface RmcaSourceConfig extends SourceConfig {
  /** Origin rule (owner 2026-10-08): a place of collecting naming one of these means made outside Africa. */
  non_african_places: string[];
  /** Inventory-number prefixes of real objects (EO ethnographic, MO musical, HO history); everything else is archive material. */
  object_inventory_prefixes: string[];
}

/** One record as the listing shows it. */
export interface RmcaListed {
  objectId: string;
  /** Zoomify base URL of the first picture, or null when the record has none. */
  imageUrl: string | null;
  fields: Record<string, string>;
}

const FIELD = /<i>([^<]+)<\/i><\/td>\s*<td[^>]*>&nbsp;:&nbsp;<\/td>\s*<td>([\s\S]*?)<\/td>/g;
const text = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** `…/collections-pictures/<size>/<path>.jpg` -> `…/collections-pictures/zoomify/<path>`: the full picture as tiles. */
export function zoomifyBase(pictureUrl: string): string | null {
  const m = /^(https?:\/\/[^"'\s]+?\/collections-pictures)\/im_\d+\/([^"'\s]+?)\.(?:jpe?g|png)$/i.exec(pictureUrl);
  return m ? `${m[1]}/zoomify/${m[2]}` : null;
}

/** Records on a results page (groups of objects are skipped), and the total the search reports. */
export function parseListing(html: string): { total: number | null; items: RmcaListed[] } {
  const total = /<h3>\s*(\d+)\s+results/i.exec(html)?.[1];
  const items: RmcaListed[] = [];
  for (const chunk of html.split(/(?=<a\s+href="display_(?:object|group)\?)/)) {
    const id = /^<a\s+href="display_object\?objectid=(\d+)"/.exec(chunk)?.[1];
    if (!id) continue;
    const img = /<img[^>]*\ssrc="([^"]+)"/.exec(chunk)?.[1];
    const fields: Record<string, string> = {};
    for (const m of chunk.matchAll(FIELD)) fields[m[1]!.trim()] = text(m[2]!);
    items.push({ objectId: id, imageUrl: img ? zoomifyBase(img) : null, fields });
  }
  return { total: total ? Number(total) : null, items };
}

/** The object page: `<h3>label</h3><p>value</p>` pairs, and the picture it shows. */
export function parseObjectPage(html: string): { imageUrl: string | null; fields: Record<string, string> } {
  const flat = html.replace(/[\r\n\t]+/g, " ");
  const fields: Record<string, string> = {};
  for (const m of flat.matchAll(/<h3>([^<]+)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)) fields[m[1]!.trim()] = text(m[2]!);
  const pic = /(https?:\/\/[^"'\s]+\/collections-pictures\/im_\d+\/[^"'\s]+?\.(?:jpe?g|png))/i.exec(flat)?.[1];
  return { imageUrl: pic ? zoomifyBase(pic) : null, fields };
}

/** Owner ruling 2026-10-08, origin decides. The place is a path ("Melanesia > Vanuatu"); any part naming a non-African place means made elsewhere. */
export function madeOutsideAfrica(place: string | null, nonAfrican: string[]): boolean {
  const bad = new Set(nonAfrican.map((p) => p.toLowerCase()));
  return (place ?? "").split(/[>;]/).some((p) => bad.has(p.trim().toLowerCase()));
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The museum's types are paths ("cult object > power object > ritual sculpture"); the last part names the object. */
export const titleOf = (type: string | null) => {
  const last = type?.split(">").pop()?.trim();
  return last ? capital(last) : null;
};

/**
 * Owner 2026-11-09: the database also holds the museum's photograph archives (inventory AP, EP, HP, CP, SA: portraits, colonial
 * administration, body art, violence) and drawings. They carry no object type, the photograph rule never sees them, and the person
 * detector missed about a quarter of them in a random sample (it also flags real statuettes, so it is no substitute). A record is
 * therefore an object only when it states a type and its inventory number starts with one of `object_inventory_prefixes`.
 */
export function isObjectRecord(f: Record<string, string>, prefixes: string[]): boolean {
  const prefix = (f["Inventory number"] ?? "").split(".")[0]!.trim().toUpperCase();
  return nonEmpty(f["Object type"]) !== null && prefixes.some((p) => p.toUpperCase() === prefix);
}

export function normaliseRmca(
  objectId: string,
  imageUrl: string | null,
  f: Record<string, string>,
  profile: FilterProfile,
  rules: { nonAfricanPlaces: string[]; objectInventoryPrefixes: string[] },
): Artwork {
  const objectType = nonEmpty(f["Object type"]);
  const title = titleOf(objectType);
  const place = nonEmpty(f["Place of collecting"]);
  const culture = nonEmpty(f["Culture"]);
  const country = nonEmpty(place?.split(">")[0]);
  return {
    key: `rmca:${objectId}`,
    source: "rmca",
    sourceObjectId: objectId,
    accessionNumber: nonEmpty(f["Inventory number"]),
    title,
    objectType,
    objectClass: classifyRecord(objectType, title, profile),
    culture,
    country,
    region: place,
    regionGroup: regionGroupFromPlace([place, culture].filter(Boolean).join(" ")),
    dateDisplay: null, // "Date of acquisition" is when the museum got it, not when it was made
    medium: nonEmpty(f["Materials"]),
    dimensions: nonEmpty(f["Dimensions"]),
    department: null,
    creditLine: null,
    description: null,
    provenanceNote: null,
    onView: false,
    gallery: null,
    imageUrl,
    imageLicense: LICENSE,
    photographer: null,
    rightsStatus:
      !imageUrl || !isObjectRecord(f, rules.objectInventoryPrefixes) || madeOutsideAfrica(place, rules.nonAfricanPlaces) ? "blocked" : "attributed-nc",
    objectUrl: `${BASE}/display_object?objectid=${objectId}`,
  };
}

export class RmcaAdapter implements MuseumAdapter {
  readonly id = "rmca";
  readonly kind = "scrape" as const;
  readonly rightsMode: SourceConfig["rights_mode"];
  readonly enabled: boolean;

  constructor(
    private readonly cfg: RmcaSourceConfig = loadSourceConfig<RmcaSourceConfig>("rmca"),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({ minIntervalMs: cfg.min_interval_ms, timeoutMs: 30_000, stopOnBlock: true }),
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
  }

  /** A failure on any page throws, so the caller keeps yesterday's index (spec 5.3) instead of publishing a partial one. */
  async *buildIndex(): AsyncIterable<IndexRow> {
    const seen = new Set<string>();
    for (let from = 0, total: number | null = null; total === null || from < total; from += PAGE) {
      const page = parseListing(await this.http.getText(`${BASE}/simple_results?search_button=Search&freetext=&b_start:int=${from}`));
      total ??= page.total;
      if (total === null || (page.total === null && page.items.length === 0)) throw new Error(`RMCA results page at ${from} has no total`);
      for (const r of page.items) {
        if (!r.imageUrl || seen.has(r.objectId)) continue;
        seen.add(r.objectId);
        const a = normaliseRmca(r.objectId, r.imageUrl, r.fields, this.profile, this.rules);
        const weight = classWeight(a.objectClass, this.profile);
        if (a.rightsStatus === "blocked" || weight <= 0) continue;
        yield { key: a.key, source: "rmca", sourceObjectId: r.objectId, objectClass: a.objectClass, regionGroup: a.regionGroup, culture: a.culture, score: scoreFor(weight) };
      }
    }
  }

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    const page = parseObjectPage(await this.http.getText(`${BASE}/display_object?objectid=${sourceObjectId}`));
    return normaliseRmca(sourceObjectId, page.imageUrl, page.fields, this.profile, this.rules);
  }

  private get rules() {
    return { nonAfricanPlaces: this.cfg.non_african_places, objectInventoryPrefixes: this.cfg.object_inventory_prefixes };
  }
}

import { classWeight } from "../classify.js";
import { loadProfile, loadSourceConfig, type FilterProfile, type SourceConfig } from "../config.js";
import { HttpClient } from "../http.js";
import { htmlToText } from "../text.js";
import type { Artwork, IndexRow, MuseumAdapter, RightsStatus } from "../types.js";
import { classifyRecord, isFlatFragment, nonEmpty, regionGroupFromPlace, scoreFor } from "./common.js";

const SEARCH = "https://search.artsmia.org";
const PAGE = 100;

export interface MiaSourceConfig extends SourceConfig {
  query: string;
}

/** The subset of a Mia `_source` record this adapter reads. */
export interface MiaRecord {
  id: number;
  title?: string | null;
  medium?: string | null;
  classification?: string | null;
  dimension?: string | null;
  object_name?: string | null;
  continent?: string | null;
  country?: string | null;
  culture?: string | null;
  dated?: string | null;
  room?: string | null;
  text?: string | null;
  creditline?: string | null;
  accession_number?: string | null;
  department?: string | null;
  rights_type?: string | null;
  image?: string | null;
  image_width?: number | null;
  image_height?: number | null;
  public_access?: number | null;
  highlights?: number | null;
  "list:african-art-highlights"?: boolean;
}

export const miaImageUrl = (id: number | string) => `https://1.api.artsmia.org/800/${id}.jpg`;

/** Spec 3.3: the image must be valid and publicly accessible. This is availability, not a licence test. */
export const hasPublicImage = (r: MiaRecord) => r.image === "valid" && r.public_access === 1;

const isHighlight = (r: MiaRecord) => Boolean(r.highlights) || r["list:african-art-highlights"] === true;
const longEdge = (r: MiaRecord) => Math.min(Math.max(r.image_width ?? 0, r.image_height ?? 0), 800) || null;

function rightsOf(type: string | null | undefined): { rights: RightsStatus; license: string | null } {
  return type === "Public Domain" ? { rights: "open", license: "Public Domain" } : { rights: "reserved", license: nonEmpty(type) };
}

function objectType(r: MiaRecord): string | null {
  return nonEmpty(r.object_name?.split(",")[0]) ?? nonEmpty(r.classification?.split(",")[0]);
}

export function normaliseMiaRecord(r: MiaRecord, profile: FilterProfile): Artwork {
  const { rights, license } = rightsOf(r.rights_type);
  const room = nonEmpty(r.room);
  const onView = room !== null && room !== "Not on View";
  const available = hasPublicImage(r);
  return {
    key: `mia:${r.id}`,
    source: "mia",
    sourceObjectId: String(r.id),
    accessionNumber: nonEmpty(r.accession_number),
    title: nonEmpty(r.title),
    objectType: objectType(r),
    objectClass: classifyRecord(r.object_name, r.title, profile, r.classification),
    culture: nonEmpty(r.culture),
    country: nonEmpty(r.country),
    region: nonEmpty(r.continent),
    regionGroup: regionGroupFromPlace([r.country, r.culture].filter(Boolean).join(" ")),
    dateDisplay: nonEmpty(r.dated),
    medium: nonEmpty(r.medium),
    dimensions: nonEmpty(r.dimension),
    department: nonEmpty(r.department),
    creditLine: nonEmpty(r.creditline),
    description: htmlToText(r.text),
    provenanceNote: null, // not in the search index; the GitHub dump has none either (verified on id 1937)
    onView,
    gallery: onView ? `Gallery ${room}` : null,
    imageUrl: available ? miaImageUrl(r.id) : null,
    imageLicense: license,
    photographer: null,
    rightsStatus: available ? rights : "blocked",
    objectUrl: `https://collections.artsmia.org/art/${r.id}`,
  };
}

export class MiaAdapter implements MuseumAdapter {
  readonly id = "mia";
  readonly kind = "api" as const;
  readonly rightsMode: SourceConfig["rights_mode"];
  readonly enabled: boolean;

  constructor(
    private readonly cfg: MiaSourceConfig = loadSourceConfig<MiaSourceConfig>("mia"),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({
      minIntervalMs: cfg.min_interval_ms, timeoutMs: cfg.timeout_ms ?? 30_000, stopOnBlock: true,
    }),
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
  }

  /**
   * A failure on any page throws, so the caller keeps yesterday's index (spec 5.3) instead of publishing a partial one.
   */
  async *buildIndex(): AsyncIterable<IndexRow> {
    for (let from = 0; ; from += PAGE) {
      const url = `${SEARCH}/${encodeURIComponent(this.cfg.query)}?size=${PAGE}&from=${from}`;
      const res = await this.http.getJson<{ hits: { total: { value: number }; hits: Array<{ _source: MiaRecord }> } }>(url);
      for (const { _source: r } of res.hits.hits) {
        if (!hasPublicImage(r)) continue;
        const cls = classifyRecord(r.object_name, r.title, this.profile, r.classification);
        const weight = classWeight(cls, this.profile);
        if (weight <= 0) continue;
        yield {
          key: `mia:${r.id}`, source: "mia", sourceObjectId: String(r.id), objectClass: cls,
          regionGroup: regionGroupFromPlace([r.country, r.culture].filter(Boolean).join(" ")),
          culture: nonEmpty(r.culture), score: scoreFor(weight, { longEdge: longEdge(r), highlight: isHighlight(r), fragment: isFlatFragment(r.object_name, r.title) }),
        };
      }
      if (res.hits.hits.length < PAGE || from + PAGE >= res.hits.total.value) return;
    }
  }

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    return normaliseMiaRecord(await this.http.getJson<MiaRecord>(`${SEARCH}/id/${sourceObjectId}`), this.profile);
  }
}

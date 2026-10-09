import { classWeight } from "../classify.js";
import { loadProfile, loadSourceConfig, type FilterProfile, type SourceConfig } from "../config.js";
import { DEFAULT_USER_AGENT, HttpClient } from "../http.js";
import { htmlToText } from "../text.js";
import type { Artwork, IndexRow, MuseumAdapter, RightsStatus } from "../types.js";
import { classifyRecord, nonEmpty, regionGroupFromPlace, scoreFor } from "./common.js";

const API = "https://api.artic.edu/api/v1/artworks";
const PAGE = 100;
const LIST_FIELDS = "id,title,artwork_type_title,place_of_origin,style_title,image_id";
const FULL_FIELDS = [
  "id", "title", "main_reference_number", "artwork_type_title", "place_of_origin", "style_title", "date_display", "medium_display",
  "dimensions", "credit_line", "department_title", "description", "provenance_text", "is_public_domain", "copyright_notice",
  "image_id", "thumbnail", "gallery_title", "is_on_view",
].join(",");

export interface AicSourceConfig extends SourceConfig {
  departments: string[];
}

/** The subset of an AIC artwork this adapter reads. */
export interface AicArtwork {
  id: number;
  title?: string | null;
  main_reference_number?: string | null;
  artwork_type_title?: string | null;
  place_of_origin?: string | null;
  style_title?: string | null;
  date_display?: string | null;
  medium_display?: string | null;
  dimensions?: string | null;
  credit_line?: string | null;
  department_title?: string | null;
  description?: string | null;
  provenance_text?: string | null;
  is_public_domain?: boolean | null;
  copyright_notice?: string | null;
  image_id?: string | null;
  thumbnail?: { alt_text?: string | null } | null;
  gallery_title?: string | null;
  is_on_view?: boolean | null;
}

/** AIC styles come lower-case and sometimes cut mid-bracket ("kuba (democratic republic of congo style"). */
function cultureOf(style: string | null | undefined): string | null {
  const s = nonEmpty(style?.replace(/\s*\([^)]*$/, ""));
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/** Bracketed notes in AIC provenance are curatorial references, not part of the ownership history. */
function provenanceOf(text: string | null | undefined): string | null {
  return nonEmpty(text?.replace(/\s*\[[^\]]*\]/g, "").replace(/\s+/g, " "));
}

function rightsOf(a: AicArtwork): { rights: RightsStatus; license: string | null } {
  if (a.is_public_domain) return { rights: "open", license: "CC0" };
  return { rights: "reserved", license: nonEmpty(a.copyright_notice) };
}

export const aicImageUrl = (imageId: string) => `https://www.artic.edu/iiif/2/${imageId}/full/843,/0/default.jpg`;

export function normaliseAicArtwork(a: AicArtwork, profile: FilterProfile): Artwork {
  const { rights, license } = rightsOf(a);
  const place = nonEmpty(a.place_of_origin);
  return {
    key: `aic:${a.id}`,
    source: "aic",
    sourceObjectId: String(a.id),
    accessionNumber: nonEmpty(a.main_reference_number),
    title: nonEmpty(a.title),
    objectType: nonEmpty(a.artwork_type_title),
    objectClass: classifyRecord(a.artwork_type_title, a.title, profile),
    culture: cultureOf(a.style_title),
    country: place,
    region: null,
    regionGroup: regionGroupFromPlace(`${place ?? ""} ${a.style_title ?? ""}`),
    dateDisplay: nonEmpty(a.date_display),
    medium: nonEmpty(a.medium_display),
    dimensions: nonEmpty(a.dimensions),
    department: nonEmpty(a.department_title),
    creditLine: nonEmpty(a.credit_line),
    description: htmlToText(a.description),
    provenanceNote: provenanceOf(a.provenance_text),
    onView: Boolean(a.is_on_view),
    gallery: a.is_on_view && nonEmpty(a.gallery_title) ? nonEmpty(a.gallery_title) : null,
    imageUrl: a.image_id ? aicImageUrl(a.image_id) : null,
    imageAlt: nonEmpty(a.thumbnail?.alt_text),
    imageLicense: license,
    photographer: null,
    rightsStatus: a.image_id ? rights : "blocked",
    objectUrl: `https://www.artic.edu/artworks/${a.id}`,
  };
}

export class AicAdapter implements MuseumAdapter {
  readonly id = "aic";
  readonly kind = "api" as const;
  readonly rightsMode: SourceConfig["rights_mode"];
  readonly enabled: boolean;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly cfg: AicSourceConfig = loadSourceConfig<AicSourceConfig>("aic"),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({ minIntervalMs: cfg.min_interval_ms, stopOnBlock: true }),
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
    // AIC asks API users to identify themselves in `AIC-User-Agent` (spec 3.3, 9).
    this.headers = { "AIC-User-Agent": process.env.BOT_USER_AGENT ?? DEFAULT_USER_AGENT };
  }

  /**
   * AIC refuses to page past 1,000 results (HTTP 403), and Arts of Africa has 1,683, so this walks the department in
   * id order with a `range` filter instead of `page`.
   */
  async *buildIndex(): AsyncIterable<IndexRow> {
    for (const dept of this.cfg.departments) {
      let after = 0;
      for (;;) {
        const body = {
          query: { bool: { filter: [{ term: { "department_title.keyword": dept } }, { range: { id: { gt: after } } }] } },
          sort: [{ id: "asc" }],
          fields: LIST_FIELDS.split(","),
          limit: PAGE,
        };
        const res = await this.http.postJson<{ data: AicArtwork[] }>(`${API}/search`, body, this.headers);
        for (const r of res.data) {
          after = Math.max(after, r.id);
          if (!r.image_id) continue;
          const cls = classifyRecord(r.artwork_type_title, r.title, this.profile);
          const weight = classWeight(cls, this.profile);
          if (weight <= 0) continue;
          yield {
            key: `aic:${r.id}`, source: "aic", sourceObjectId: String(r.id), objectClass: cls,
            regionGroup: regionGroupFromPlace(`${r.place_of_origin ?? ""} ${r.style_title ?? ""}`),
            culture: cultureOf(r.style_title), score: scoreFor(weight),
          };
        }
        if (res.data.length < PAGE) break;
      }
    }
  }

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    const { data } = await this.http.getJson<{ data: AicArtwork }>(`${API}/${sourceObjectId}?fields=${FULL_FIELDS}`, this.headers);
    return normaliseAicArtwork(data, this.profile);
  }
}

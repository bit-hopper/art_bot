export type ObjectClass =
  | "mask"
  | "sculpture"
  | "carved-instrument"
  | "pottery"
  | "other-carved-cast"
  | "other"
  | "specimen"
  | "archive";

export type RegionGroup = "sub-saharan" | "north-africa" | "egypt" | "unspecified-africa";

/**
 * `reserved`: no open licence (missing, "all rights reserved", in copyright); still posted, with the museum's own
 * rights statement and credit (owner decision 2026-10-08). `blocked` is only for objects with nothing to post
 * (no image), that the sensitive-object denylist rejects, or whose stated place of manufacture is outside Africa.
 */
export type RightsStatus = "open" | "attributed" | "attributed-nc" | "reserved" | "blocked";

export interface Artwork {
  /** `"{source}:{source_object_id}"`: the dedupe key. */
  key: string;
  source: string;
  sourceObjectId: string;
  /** Display only; not unique. */
  accessionNumber: string | null;
  title: string | null;
  /** The museum's own wording, e.g. "Mask". */
  objectType: string | null;
  objectClass: ObjectClass;
  culture: string | null;
  country: string | null;
  region: string | null;
  regionGroup: RegionGroup;
  dateDisplay: string | null;
  medium: string | null;
  dimensions: string | null;
  department: string | null;
  creditLine: string | null;
  description: string | null;
  /** Provenance text taken from the museum record only (spec 7.4). */
  provenanceNote: string | null;
  onView: boolean;
  gallery: string | null;
  imageUrl: string | null;
  /** The museum's own description of what the image shows (AIC supplies one); preferred for alt text. */
  imageAlt?: string | null;
  imageLicense: string | null;
  photographer: string | null;
  rightsStatus: RightsStatus;
  objectUrl: string;
}

/** Cheap row written to `index/<source>.jsonl` by the daily job. */
export interface IndexRow {
  key: string;
  source: string;
  sourceObjectId: string;
  objectClass: ObjectClass;
  regionGroup: RegionGroup;
  culture: string | null;
  /** class weight x quality factor (spec 4.2). */
  score: number;
}

export interface MuseumAdapter {
  id: string;
  kind: "api" | "scrape";
  rightsMode: "open" | "attributed" | "attributed-nc";
  enabled: boolean;
  buildIndex(): AsyncIterable<IndexRow>;
  fetchArtwork(sourceObjectId: string): Promise<Artwork>;
}

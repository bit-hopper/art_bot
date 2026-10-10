import { classWeight } from "../classify.js";
import { loadProfile, loadSourceConfig, type FilterProfile, type SourceConfig } from "../config.js";
import { HttpClient } from "../http.js";
import { htmlToText } from "../text.js";
import type { Artwork, IndexRow, MuseumAdapter, RightsStatus } from "../types.js";
import { classifyRecord, isFlatFragment, isSherd, nonEmpty, regionGroupFromPlace, scoreFor } from "./common.js";

export interface NmafaSourceConfig extends SourceConfig {
  bulk_url: string;
  shards: number;
  non_african_places: string[];
}

interface Labelled { label?: string; content?: string }

interface NmafaMedia {
  type?: string;
  usage?: { access?: string };
  resources?: Array<{ label?: string; url?: string; width?: number; height?: number }>;
}

/** One line of the Smithsonian Open Access bulk file `metadata/edan/nmafa/NN.txt` (EDAN `edanmdm`). */
export interface NmafaRecord {
  content: {
    descriptiveNonRepeating: {
      guid?: string;
      record_ID: string;
      title?: Labelled;
      online_media?: { media?: NmafaMedia[] };
    };
    freetext: Partial<Record<"date" | "name" | "notes" | "place" | "setName" | "creditLine" | "identifier" | "objectType" | "physicalDescription", Labelled[]>>;
  };
}

const first = (xs: Labelled[] | undefined, label?: RegExp) => nonEmpty((label ? xs?.find((x) => label.test(x.label ?? "")) : xs?.[0])?.content);
const all = (xs: Labelled[] | undefined, label: RegExp) => (xs ?? []).filter((x) => label.test(x.label ?? "")).map((x) => nonEmpty(x.content)).filter((x): x is string => x !== null);

/** Owner ruling 2026-10-08, origin decides: a place field that names a non-African country means made elsewhere ("Austria; Ethiopia" is a coin struck in Vienna). */
export function madeOutsideAfrica(place: string | null, nonAfrican: string[]): boolean {
  const bad = new Set(nonAfrican.map((p) => p.toLowerCase()));
  return (place ?? "").split(/[;,]/).some((p) => bad.has(p.trim().toLowerCase()));
}

/** The CC0 image: the high-resolution JPEG when the record lists one, else the screen-size image. */
export function nmafaImage(r: NmafaRecord): { url: string; longEdge: number | null } | null {
  for (const m of r.content.descriptiveNonRepeating.online_media?.media ?? []) {
    if (m.type !== "Images" || m.usage?.access !== "CC0") continue;
    const res = m.resources?.find((x) => /high-resolution jpeg/i.test(x.label ?? "")) ?? m.resources?.find((x) => /screen/i.test(x.label ?? ""));
    if (res?.url) return { url: res.url, longEdge: Math.max(res.width ?? 0, res.height ?? 0) || null };
  }
  return null;
}

export function normaliseNmafaRecord(r: NmafaRecord, profile: FilterProfile, nonAfrican: string[]): Artwork {
  const d = r.content.descriptiveNonRepeating;
  const f = r.content.freetext;
  const id = d.record_ID;
  const place = first(f.place);
  const type = first(f.objectType);
  const title = nonEmpty(htmlToText(d.title?.content));
  const image = nmafaImage(r);
  const prov = all(f.notes, /^provenance/i).join("; ");
  const gallery = first(f.setName, /^on view/i);
  const outside = madeOutsideAfrica(place, nonAfrican);
  const rights: RightsStatus = !image || outside ? "blocked" : "open";
  return {
    key: `nmafa:${id}`,
    source: "nmafa",
    sourceObjectId: id,
    accessionNumber: first(f.identifier),
    title,
    objectType: type,
    objectClass: classifyRecord(type, title, profile),
    culture: first(f.name, /^maker/i),
    country: place,
    region: null,
    regionGroup: regionGroupFromPlace(place),
    dateDisplay: first(f.date),
    medium: first(f.physicalDescription, /^medium/i),
    dimensions: first(f.physicalDescription, /^dimensions/i),
    department: null,
    creditLine: first(f.creditLine),
    description: htmlToText(first(f.notes, /^description/i)),
    provenanceNote: nonEmpty(prov),
    onView: gallery !== null,
    gallery,
    imageUrl: image?.url ?? null,
    imageLicense: image ? "CC0" : null,
    photographer: null,
    rightsStatus: rights,
    objectUrl: (d.guid ?? "").replace(/^http:/, "https:") || `https://www.si.edu/object/${id}`,
  };
}

export class NmafaAdapter implements MuseumAdapter {
  readonly id = "nmafa";
  readonly kind = "api" as const;
  readonly rightsMode: SourceConfig["rights_mode"];
  readonly enabled: boolean;

  constructor(
    private readonly cfg: NmafaSourceConfig = loadSourceConfig<NmafaSourceConfig>("nmafa"),
    private readonly profile: FilterProfile = loadProfile(),
    private readonly http: HttpClient = new HttpClient({ minIntervalMs: cfg.min_interval_ms, stopOnBlock: true }),
  ) {
    this.rightsMode = cfg.rights_mode;
    this.enabled = cfg.enabled;
  }

  private shardUrl(shard: string): string {
    return `${this.cfg.bulk_url}/${shard}.txt`;
  }

  private async shard(shard: string): Promise<NmafaRecord[]> {
    const text = await this.http.getText(this.shardUrl(shard));
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as NmafaRecord);
  }

  /** Source object ids are `{shard}/{record_ID}`: the bulk shard is chosen by the Smithsonian, so it is kept to fetch one small file later. */
  async *buildIndex(): AsyncIterable<IndexRow> {
    for (let i = 0; i < this.cfg.shards; i++) {
      const name = i.toString(16).padStart(2, "0");
      for (const r of await this.shard(name)) {
        const a = normaliseNmafaRecord(r, this.profile, this.cfg.non_african_places);
        if (a.rightsStatus === "blocked") continue;
        const weight = classWeight(a.objectClass, this.profile);
        if (weight <= 0) continue;
        const img = nmafaImage(r);
        yield {
          key: `nmafa:${name}/${a.sourceObjectId}`, source: "nmafa", sourceObjectId: `${name}/${a.sourceObjectId}`, objectClass: a.objectClass,
          regionGroup: a.regionGroup, culture: a.culture ?? a.country, score: scoreFor(weight, { longEdge: img?.longEdge, fragment: isFlatFragment(a.objectType, a.title), sherd: isSherd(a.objectClass, a.objectType, a.title) }),
        };
      }
    }
  }

  async fetchArtwork(sourceObjectId: string): Promise<Artwork> {
    const [name, id] = sourceObjectId.split("/");
    const rec = (await this.shard(name!)).find((r) => r.content.descriptiveNonRepeating.record_ID === id);
    if (!rec) throw new Error(`nmafa: ${id} not in shard ${name}`);
    const a = normaliseNmafaRecord(rec, this.profile, this.cfg.non_african_places);
    return { ...a, key: `nmafa:${sourceObjectId}`, sourceObjectId };
  }
}

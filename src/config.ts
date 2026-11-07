import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import type { ObjectClass } from "./types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Keywords {
  archive: string[];
  specimen: string[];
  mask: string[];
  not_mask: string[];
  "carved-instrument": string[];
  "other-carved-cast": string[];
  pottery: string[];
  pottery_whole_word: string[];
  sculpture: string[];
  sculpture_whole_word: string[];
}

/** Owner 2026-11-05: favour whole, refined objects. Applied at pick time, so no index has to be rebuilt. */
export interface TasteConfig {
  /** Multiplies the pick weight of every row of a class. */
  class_boost?: Partial<Record<ObjectClass, number>>;
  /** Rows whose culture names one of these (Edo, Benin) are drawn `factor` times as often. */
  culture_boost?: { terms: string[]; factor: number };
  /**
   * After the record is fetched: a title or type naming one of `terms` (any region) or, for Egypt, `egypt_terms`, is kept with
   * probability `accept` and otherwise re-picked, at most `max_rejects` times per run so a post never fails on it.
   */
  low_interest?: { accept: number; max_rejects: number; terms: string[]; egypt_terms: string[]; egypt_strict?: { accept: number; terms: string[] } };
  /**
   * Egypt only: a title or type naming one of `terms` as a whole word (heads, statues, coffins, stelae, wall reliefs) is always kept;
   * any other Egyptian record that is not pottery or a mask is kept with probability `other_accept`. Shares `low_interest.max_rejects`.
   */
  high_interest?: { terms: string[]; other_accept: number };
  /**
   * Material at pick time, from the index row's `medium` (whole words; German terms for SMB). A medium naming one of `boost_terms` (cast
   * metal, ivory, stone) is drawn `boost` times as often; a catch-all (`other`) row naming one of `organic_terms` (fur, leather, raffia,
   * fibre) and no boost term is drawn `organic` times as often. Rows with no recorded medium are neutral.
   */
  material?: { boost_terms: string[]; boost: number; organic_terms: string[]; organic: number };
  /**
   * After the fetch, for the catch-all class (`other`), by the record's medium: soft organic material (`material.organic_terms`) is kept
   * with probability `organic_accept`; otherwise a medium that names none of `refined_terms` (metal, ivory, stone, ceramic) is kept with
   * `unrefined_accept`. No recorded medium is left alone. Shares `low_interest.max_rejects`.
   */
  catch_all?: { organic_accept: number; refined_terms: string[]; unrefined_accept: number };
}

export interface FilterProfile {
  enabled: boolean;
  taste?: TasteConfig;
  region_share_caps: Record<string, number>;
  require_image: boolean;
  /** Draw only masks once none was published for this many hours; unset or 0 turns the rule off. */
  force_mask_after_hours?: number;
  classes: Record<ObjectClass, number>;
  keywords: Keywords;
  exclude_keywords: string[];
}

export interface SmbSourceConfig {
  enabled: boolean;
  kind: "scrape";
  rights_mode: "open" | "attributed" | "attributed-nc";
  source_weight: number;
  min_interval_ms: number;
  org_units_africa: string[];
  org_units_egypt: string[];
  /** Units filed by period (Islamic, Byzantine, Antiquities): kept when every place of origin they name is African (owner 2026-10-09). */
  org_units_origin?: string[];
  /** Non-African terms; an origin-unit object that also matches one is left out of the index (it is "Egypt or Syria"). */
  origin_exclude_terms?: string[];
  /** Egyptian towns that appear next to "Ägypten" in origin lines ("Ägypten" + "Fustat" is one origin, not two). */
  origin_egypt_places?: string[];
  africa_terms: string[];
  /** Index terms whose rows carry that name as `culture`, so the pick-time boost sees them (search rows have no culture otherwise). */
  featured_cultures?: string[];
  /**
   * Material terms the portal can filter on (`materials=`). The search rows carry no material, so after the index is enumerated each term is
   * searched once per unit and every indexed row it hits gets the term in its `medium` (a few hundred requests, not one page per object).
   */
  material_terms?: string[];
  egypt_terms: string[];
  north_africa_terms: string[];
  allowed_licenses: Record<"open" | "attributed" | "attributed-nc", string[]>;
}

/** Settings every source shares; adapters add their own keys (spec 3, 5.2). */
export interface SourceConfig {
  enabled: boolean;
  kind: "api" | "scrape";
  rights_mode: "open" | "attributed" | "attributed-nc";
  source_weight: number;
  /** Minimum gap between requests to the source, in ms. */
  min_interval_ms: number;
  timeout_ms?: number;
  retries?: number;
  /** Language of the record's free text; anything but English is machine-translated at post time (spec 6.7). */
  language?: string;
}

function load<T>(file: string): T {
  return parse(readFileSync(path.join(root, "config", file), "utf8")) as T;
}

function requireKeys(obj: object, keys: string[], where: string): void {
  for (const k of keys) {
    if (!(k in obj)) throw new Error(`config error: ${where} is missing "${k}"`);
  }
}

export function loadProfile(name = "africana-masks-and-sculpture"): FilterProfile {
  const file = load<{ profiles: Record<string, FilterProfile> }>("filters.yaml");
  const p = file.profiles?.[name];
  if (!p) throw new Error(`config error: filter profile "${name}" not found`);
  requireKeys(p, ["classes", "keywords", "region_share_caps"], `profile ${name}`);
  requireKeys(
    p.keywords,
    ["archive", "specimen", "mask", "not_mask", "carved-instrument", "other-carved-cast", "pottery", "pottery_whole_word", "sculpture", "sculpture_whole_word"],
    `profile ${name}.keywords`,
  );
  return p;
}

export function loadSmbConfig(): SmbSourceConfig {
  const file = load<{ sources: { smb?: SmbSourceConfig } }>("sources.yaml");
  const s = file.sources?.smb;
  if (!s) throw new Error('config error: sources.smb not found');
  requireKeys(
    s,
    ["org_units_africa", "org_units_egypt", "africa_terms", "egypt_terms", "north_africa_terms", "allowed_licenses", "min_interval_ms"],
    "sources.smb",
  );
  return s;
}

export interface Denylist {
  provenance_flags: string[];
  blocked_terms: string[];
  blocked_type_tokens: string[];
  blocked_keys: string[];
  photograph_terms?: string[];
  allowed_phrases?: string[];
  modern_material_terms?: string[];
  explicit_terms?: string[];
  explicit_title_terms?: string[];
  condition_terms?: string[];
  /** CLIP score (0 to 1) from which an image counts as corroded or encrusted; unset or 0 turns the image check off. */
  condition_image_threshold?: number;
  /** Sources whose image check fails closed: when the CLIP model cannot run, their pick is refused instead of posted unchecked (owner 2026-11-06: an encrusted Osiris slipped through). */
  condition_fail_closed_sources?: string[];
  latest_year?: number;
  /** Owner 2026-11-05: a work in a traditional medium by a living craft tradition (Edo brass from Benin City) is exempt from `latest_year`. */
  latest_year_exempt?: { culture_terms: string[]; medium_terms: string[] };
}

export function loadDenylist(): Denylist {
  const d = load<Denylist>("denylist.yaml");
  requireKeys(d, ["provenance_flags", "blocked_terms", "blocked_type_tokens", "blocked_keys"], "denylist.yaml");
  return d;
}

export function loadSourceConfig<T extends SourceConfig = SourceConfig>(id: string): T {
  const s = load<{ sources: Record<string, T> }>("sources.yaml").sources?.[id];
  if (!s) throw new Error(`config error: sources.${id} not found`);
  requireKeys(s, ["enabled", "kind", "rights_mode", "source_weight", "min_interval_ms"], `sources.${id}`);
  return s;
}

/** Source id -> `source_weight` for the fairness step (spec 5.2). */
export function loadSourceWeights(): Record<string, number> {
  const all = load<{ sources: Record<string, SourceConfig> }>("sources.yaml").sources ?? {};
  return Object.fromEntries(Object.entries(all).map(([id, s]) => [id, s.source_weight ?? 1]));
}

export function enabledSourceIds(): string[] {
  const all = load<{ sources: Record<string, SourceConfig> }>("sources.yaml").sources ?? {};
  return Object.entries(all).filter(([, s]) => s.enabled).map(([id]) => id);
}

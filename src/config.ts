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
  sculpture: string[];
  sculpture_whole_word: string[];
}

export interface FilterProfile {
  enabled: boolean;
  region_share_caps: Record<string, number>;
  require_image: boolean;
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
  africa_terms: string[];
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
    ["archive", "specimen", "mask", "not_mask", "carved-instrument", "other-carved-cast", "sculpture", "sculpture_whole_word"],
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

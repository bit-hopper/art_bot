import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "./state.js";

const HOUR = 3_600_000;
export const NO_POST_AFTER_HOURS = 3;
export const STALE_INDEX_AFTER_DAYS = 3;

export interface HealthInput {
  now: Date;
  /** ISO time of the last published post, or null when the ledger has none. */
  lastPostAt: string | null;
  /** Enabled sources mapped to the ISO time their index last rebuilt, or null when it never did. */
  indexBuiltAt: Record<string, string | null>;
  paused: boolean;
}

export interface HealthAlert {
  type: string;
  message: string;
}

/** The alerts that apply right now (spec 10); every alert type not returned is cleared by the caller. */
export function evaluateHealth(h: HealthInput): HealthAlert[] {
  if (h.paused) return [];
  const alerts: HealthAlert[] = [];
  if (h.lastPostAt) {
    const hours = (h.now.getTime() - Date.parse(h.lastPostAt)) / HOUR;
    if (hours > NO_POST_AFTER_HOURS) alerts.push({ type: "no-post", message: `No post for ${Math.floor(hours)} hours (last at ${h.lastPostAt}).` });
  } else {
    alerts.push({ type: "no-post", message: "The ledger has no published post yet." });
  }
  const stale = Object.entries(h.indexBuiltAt).filter(([, at]) => !at || (h.now.getTime() - Date.parse(at)) / (24 * HOUR) > STALE_INDEX_AFTER_DAYS);
  if (stale.length > 0) alerts.push({ type: "stale-index", message: `Index older than ${STALE_INDEX_AFTER_DAYS} days or missing: ${stale.map(([s]) => s).join(", ")}.` });
  return alerts;
}

const metaFile = () => path.join(stateDir(), "meta.json");

/** `meta.json` on the state branch records when each source's index last rebuilt (file times do not survive git). */
export function readMeta(): { indexBuiltAt: Record<string, string> } {
  return existsSync(metaFile()) ? JSON.parse(readFileSync(metaFile(), "utf8")) : { indexBuiltAt: {} };
}

export function markIndexBuilt(source: string, at = new Date()): void {
  const meta = readMeta();
  meta.indexBuiltAt[source] = at.toISOString();
  mkdirSync(path.dirname(metaFile()), { recursive: true });
  writeFileSync(metaFile(), JSON.stringify(meta, null, 1) + "\n");
}

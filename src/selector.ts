import type { FilterProfile } from "./config.js";
import type { Ledger, LedgerRow } from "./ledger.js";
import type { Artwork, IndexRow, ObjectClass } from "./types.js";

const FAIRNESS_WINDOW = 6;
const CAP_WINDOW = 24;
const CULTURE_WINDOW = 2;
const MAX_ATTEMPTS = 5;

const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

/** Spec 5.2 step 2: `score x source_weight x 0.5^n`, n = how many of the last 6 posts came from the same source. */
export function rowWeight(row: IndexRow, recent6: LedgerRow[], sourceWeights: Record<string, number>): number {
  const n = recent6.filter((r) => r.source === row.source).length;
  return row.score * (sourceWeights[row.source] ?? 1) * 0.5 ** n;
}

/** Region groups already at their share of the last 24 posts (spec 5.2). The cap is never relaxed. */
export function cappedRegions(recent24: LedgerRow[], caps: Record<string, number>): Set<string> {
  const out = new Set<string>();
  for (const [group, cap] of Object.entries(caps)) {
    if (recent24.filter((r) => r.regionGroup === group).length >= cap * CAP_WINDOW) out.add(group);
  }
  return out;
}

/** True when the last 2 posts both share this culture. Applied to the fetched record because SMB index rows carry none. */
export function cultureRepeats(culture: string | null, recent2: LedgerRow[]): boolean {
  const c = norm(culture);
  return c !== "" && recent2.length >= CULTURE_WINDOW && recent2.every((r) => norm(r.culture) === c);
}

/**
 * Owner rule 2026-10-14: at least one mask in every 24 hours. Masks are about 1% of the index, so weights alone gave 3 masks in
 * 58 posts. True when no mask was published in the last `hours` (the profile sets 23, so a missed hour still lands inside 24).
 */
export function maskDue(ledger: Ledger, hours: number | undefined, now: Date): boolean {
  if (!hours) return false;
  const since = now.getTime() - hours * 3_600_000;
  return !ledger.posts().some((r) => r.objectClass === "mask" && Date.parse(r.postedAt ?? r.claimedAt) >= since);
}

export function weightedPick<T>(items: T[], weight: (t: T) => number, rng: () => number): T | null {
  const total = items.reduce((s, t) => s + Math.max(weight(t), 0), 0);
  if (items.length === 0 || total <= 0) return null;
  let x = rng() * total;
  for (const t of items) {
    x -= Math.max(weight(t), 0);
    if (x < 0) return t;
  }
  return items[items.length - 1]!;
}

/** Postable classes that have index rows but none left after removing already-posted keys (spec 5.2 step 5). */
export function exhaustedTiers(rows: IndexRow[], ledger: Ledger, profile: FilterProfile): ObjectClass[] {
  const seen = new Set<ObjectClass>();
  const open = new Set<ObjectClass>();
  for (const r of rows) {
    seen.add(r.objectClass);
    if (!ledger.blocks(r.key)) open.add(r.objectClass);
  }
  return [...seen].filter((c) => (profile.classes[c] ?? 0) > 0 && !open.has(c));
}

export interface Attempt {
  key: string;
  outcome: "picked" | "fetch-failed" | "image-failed" | "duplicate" | "no-image" | "culture-repeat" | "denied";
  detail?: string;
}

export interface SelectorDeps<P = undefined> {
  rows: IndexRow[];
  ledger: Ledger;
  profile: FilterProfile;
  sourceWeights: Record<string, number>;
  fetch(row: IndexRow): Promise<Artwork>;
  /** Extra rejection reason for a fetched record (the sensitive-object denylist). */
  deny?(a: Artwork): string | null;
  /**
   * Fetch and prepare the image. A record can look fine and still have no usable file (Mia's image host lacks about 6%
   * of its newest records), so a failure here re-picks like any other rejection and the result rides along on success.
   */
  prepare?(a: Artwork): Promise<P>;
  /** Rejection reason found by looking at the prepared image (a photograph with a real person in it), or null. */
  checkImage?(a: Artwork, prepared: P): Promise<string | null>;
  rng?: () => number;
  maxAttempts?: number;
  now?: Date;
}

export type Selection<P = undefined> =
  | { ok: true; artwork: Artwork; row: IndexRow; prepared: P; attempts: Attempt[]; exhaustedTiers: ObjectClass[]; maskDue: boolean }
  | { ok: false; reason: "POOL_EMPTY" | "ATTEMPTS_EXHAUSTED"; attempts: Attempt[]; exhaustedTiers: ObjectClass[] };

/**
 * Spec 5.2: drop posted keys, apply fairness and the region caps, weighted-random pick by score, fetch the record,
 * re-check it, and re-pick on any failure (max 5 attempts). Tier fall-through needs no code: the weights already
 * draw masks first and move down the classes as they run out.
 */
export async function selectArtwork<P = undefined>(d: SelectorDeps<P>): Promise<Selection<P>> {
  const rng = d.rng ?? Math.random;
  const max = d.maxAttempts ?? MAX_ATTEMPTS;
  const recent24 = d.ledger.recent(CAP_WINDOW);
  const recent6 = recent24.slice(-FAIRNESS_WINDOW);
  const recent2 = recent24.slice(-CULTURE_WINDOW);
  const capped = cappedRegions(recent24, d.profile.region_share_caps);
  const tiers = exhaustedTiers(d.rows, d.ledger, d.profile);

  let pool = d.rows.filter((r) => !d.ledger.blocks(r.key) && !capped.has(r.regionGroup) && (d.profile.classes[r.objectClass] ?? 0) > 0);
  pool = pool.filter((r) => !cultureRepeats(r.culture, recent2));
  const attempts: Attempt[] = [];
  if (pool.length === 0) return { ok: false, reason: "POOL_EMPTY", attempts, exhaustedTiers: tiers };

  // While a mask is due, draw only from masks; once none are left (or all were rejected) the normal pool takes over.
  const due = maskDue(d.ledger, d.profile.force_mask_after_hours, d.now ?? new Date());
  let masks = due ? pool.filter((r) => r.objectClass === "mask") : [];

  while (attempts.length < max) {
    const row = weightedPick(masks.length > 0 ? masks : pool, (r) => rowWeight(r, recent6, d.sourceWeights), rng);
    if (!row) return { ok: false, reason: "POOL_EMPTY", attempts, exhaustedTiers: tiers };
    pool = pool.filter((r) => r !== row);
    masks = masks.filter((r) => r !== row);

    let artwork: Artwork;
    try {
      artwork = await d.fetch(row);
    } catch (e) {
      attempts.push({ key: row.key, outcome: "fetch-failed", detail: String(e instanceof Error ? e.message : e) });
      continue;
    }
    const reject = (outcome: Attempt["outcome"], detail?: string) => attempts.push({ key: row.key, outcome, detail });
    if (d.ledger.isDuplicate(artwork)) { reject("duplicate"); continue; }
    if (!artwork.imageUrl || artwork.rightsStatus === "blocked") { reject("no-image"); continue; }
    if (cultureRepeats(artwork.culture, recent2)) { reject("culture-repeat", artwork.culture ?? undefined); continue; }
    const denied = d.deny?.(artwork);
    if (denied) { reject("denied", denied); continue; }

    let prepared = undefined as P;
    if (d.prepare) {
      try {
        prepared = await d.prepare(artwork);
      } catch (e) {
        reject("image-failed", String(e instanceof Error ? e.message : e));
        continue;
      }
    }

    const imageDenied = d.checkImage ? await d.checkImage(artwork, prepared) : null;
    if (imageDenied) { reject("denied", imageDenied); continue; }

    attempts.push({ key: row.key, outcome: "picked" });
    return { ok: true, artwork, row, prepared, attempts, exhaustedTiers: tiers, maskDue: due };
  }
  return { ok: false, reason: "ATTEMPTS_EXHAUSTED", attempts, exhaustedTiers: tiers };
}

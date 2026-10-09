import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Artwork, ObjectClass, RegionGroup } from "./types.js";

export type LedgerStatus = "claimed" | "posted_bluesky" | "posted_all" | "failed_threads" | "failed";

/** One line of `ledger.jsonl`. Append-only: every status change is a new row for the same key, the last one wins. */
export interface LedgerRow {
  key: string;
  source: string;
  accessionNumber: string | null;
  title: string | null;
  objectUrl: string;
  status: LedgerStatus;
  /** Carried so the selector can apply the culture rule and region share caps from the ledger alone. */
  culture: string | null;
  regionGroup: RegionGroup;
  objectClass: ObjectClass;
  blueskyUri?: string;
  blueskyCid?: string;
  threadsId?: string;
  claimedAt: string;
  postedAt?: string;
  error?: string;
}

const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Spec 5.1 secondary guard: accession numbers are not unique and museums re-ingest records under new ids, so a
 * candidate also collides on (source, accession) or (source, title). A title equal to the object type ("Maske") is
 * the SMB fallback for untitled objects, not an identity, so it never counts.
 */
function guards(a: Pick<Artwork, "source" | "accessionNumber" | "title" | "objectType">): string[] {
  const out: string[] = [];
  if (a.accessionNumber) out.push(`acc|${a.source}|${norm(a.accessionNumber)}`);
  if (a.title && norm(a.title) !== norm(a.objectType ?? "")) out.push(`title|${a.source}|${norm(a.title)}`);
  return out;
}

export class Ledger {
  private readonly latest = new Map<string, LedgerRow>();
  private readonly order: string[] = [];
  private readonly guardSet = new Set<string>();
  private dirty = true;

  constructor(
    readonly file: string | null,
    rows: LedgerRow[] = [],
  ) {
    for (const r of rows) this.apply(r);
  }

  static load(file: string): Ledger {
    if (!existsSync(file)) return new Ledger(file);
    const rows = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l, i) => {
        try {
          return JSON.parse(l) as LedgerRow;
        } catch {
          throw new Error(`ledger ${file}: line ${i + 1} is not valid JSON`);
        }
      });
    return new Ledger(file, rows);
  }

  private apply(row: LedgerRow): void {
    if (!this.latest.has(row.key)) this.order.push(row.key);
    this.latest.set(row.key, row);
    this.dirty = true;
  }

  private rebuildGuards(): void {
    this.dirty = false;
    this.guardSet.clear();
    for (const r of this.latest.values()) {
      if (r.status === "failed") continue;
      for (const g of guards({ source: r.source, accessionNumber: r.accessionNumber, title: r.title, objectType: null })) this.guardSet.add(g);
    }
  }

  /** Append a row to memory and, when the ledger has a file, to disk. */
  append(row: LedgerRow): void {
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(row) + "\n");
    }
    this.apply(row);
  }

  /** Latest row per key, in first-seen order (seeds the in-memory copy a dry run works on). */
  allRows(): LedgerRow[] {
    return this.order.map((k) => this.latest.get(k)!);
  }

  get(key: string): LedgerRow | undefined {
    return this.latest.get(key);
  }

  /** True when `key` may not be picked: any status except `failed` (spec 5.1). */
  blocks(key: string): boolean {
    const r = this.latest.get(key);
    return r !== undefined && r.status !== "failed";
  }

  /** Secondary guard, run after `fetchArtwork` when accession and title are known. */
  isDuplicate(a: Artwork): boolean {
    if (this.dirty) this.rebuildGuards();
    return this.blocks(a.key) || guards(a).some((g) => this.guardSet.has(g));
  }

  /** Posts that count as published, oldest first (`failed` and bare `claimed` rows do not). */
  posts(): LedgerRow[] {
    return this.order
      .map((k) => this.latest.get(k)!)
      .filter((r) => r.status === "posted_bluesky" || r.status === "posted_all" || r.status === "failed_threads")
      .sort((a, b) => (a.postedAt ?? a.claimedAt).localeCompare(b.postedAt ?? b.claimedAt));
  }

  recent(n: number): LedgerRow[] {
    return this.posts().slice(-n);
  }

  /** Keys that were claimed but never reached a root post: reconcile (M2) repairs these. */
  stuckClaims(): LedgerRow[] {
    return [...this.latest.values()].filter((r) => r.status === "claimed");
  }
}

export function claimRow(a: Artwork, objectClass: ObjectClass, now = new Date()): LedgerRow {
  return {
    key: a.key, source: a.source, accessionNumber: a.accessionNumber, title: a.title, objectUrl: a.objectUrl,
    status: "claimed", culture: a.culture, regionGroup: a.regionGroup, objectClass, claimedAt: now.toISOString(),
  };
}

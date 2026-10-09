import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/config.js";
import { claimRow, Ledger, type LedgerRow } from "../src/ledger.js";
import { cappedRegions, cultureRepeats, exhaustedTiers, rowWeight, selectArtwork, weightedPick } from "../src/selector.js";
import type { Artwork, IndexRow, ObjectClass, RegionGroup } from "../src/types.js";

const profile = loadProfile();

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const WEIGHT: Record<string, number> = { mask: 100, sculpture: 90, other: 10 };

function row(i: number, source: string, cls: ObjectClass, region: RegionGroup = "sub-saharan", culture: string | null = null): IndexRow {
  return { key: `${source}:${i}`, source, sourceObjectId: String(i), objectClass: cls, regionGroup: region, culture, score: WEIGHT[cls] ?? 10 };
}

function art(r: IndexRow, over: Partial<Artwork> = {}): Artwork {
  return {
    key: r.key, source: r.source, sourceObjectId: r.sourceObjectId, accessionNumber: `ACC-${r.key}`, title: `Title ${r.key}`,
    objectType: "Mask", objectClass: r.objectClass, culture: r.culture, country: null, region: null, regionGroup: r.regionGroup,
    dateDisplay: null, medium: null, dimensions: null, department: null, creditLine: null, description: null, provenanceNote: null,
    onView: false, gallery: null, imageUrl: "https://example.org/i.jpg", imageLicense: "CC0", photographer: null,
    rightsStatus: "open", objectUrl: `https://example.org/${r.key}`, ...over,
  };
}

function posted(r: IndexRow, minute: number, over: Partial<LedgerRow> = {}): LedgerRow {
  const a = art(r);
  return {
    ...claimRow(a, r.objectClass, new Date(Date.UTC(2026, 0, 1, 0, minute))),
    status: "posted_all", postedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), ...over,
  };
}

describe("ledger", () => {
  it("blocks every status except failed, and tolerates re-appended rows", () => {
    const r = row(1, "met", "mask");
    const l = new Ledger(null, [posted(r, 1, { status: "claimed" })]);
    expect(l.blocks(r.key)).toBe(true);
    l.append(posted(r, 2, { status: "failed" }));
    expect(l.blocks(r.key)).toBe(false);
    l.append(posted(r, 3));
    expect(l.blocks(r.key)).toBe(true);
    expect(l.posts()).toHaveLength(1);
  });

  it("secondary guard: same accession, or same real title, at the same museum; not an SMB fallback title", () => {
    const l = new Ledger(null, [posted(row(1, "met", "mask"), 1)]);
    const other = art(row(2, "met", "mask"));
    expect(l.isDuplicate({ ...other, accessionNumber: "acc-met:1" })).toBe(true);
    expect(l.isDuplicate({ ...other, title: "TITLE   met:1" })).toBe(true);
    expect(l.isDuplicate({ ...other, source: "cleveland", accessionNumber: "ACC-met:1", title: "x" })).toBe(false);

    const smb = new Ledger(null, [{ ...posted(row(3, "smb", "mask"), 1), title: "Maske", accessionNumber: "III C 1" }]);
    const next = art(row(4, "smb", "mask"), { title: "Maske", objectType: "Maske", accessionNumber: "III C 2" });
    expect(smb.isDuplicate(next)).toBe(false);
  });

  it("round-trips through the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
    try {
      const f = path.join(dir, "state", "ledger.jsonl");
      const l = Ledger.load(f);
      l.append(posted(row(1, "met", "mask"), 1));
      l.append(posted(row(2, "met", "mask"), 2));
      expect(readFileSync(f, "utf8").trim().split("\n")).toHaveLength(2);
      expect(Ledger.load(f).posts().map((p) => p.key)).toEqual(["met:1", "met:2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("selector pieces", () => {
  it("halves a source's weight for each of its posts in the last 6", () => {
    const r = row(1, "smb", "mask");
    const recent = [posted(row(2, "smb", "mask"), 1), posted(row(3, "smb", "mask"), 2), posted(row(4, "met", "mask"), 3)];
    expect(rowWeight(r, [], { smb: 2 })).toBe(200);
    expect(rowWeight(r, recent, { smb: 2 })).toBe(50);
  });

  it("caps a region at its share of the last 24", () => {
    const ten = Array.from({ length: 10 }, (_, i) => posted(row(i, "met", "mask", "egypt"), i));
    expect(cappedRegions(ten, { egypt: 0.4 }).has("egypt")).toBe(true);
    expect(cappedRegions(ten.slice(1), { egypt: 0.4 }).has("egypt")).toBe(false);
  });

  it("flags a culture only when both of the last 2 posts share it", () => {
    const a = posted(row(1, "met", "mask", "sub-saharan", "Yoruba"), 1);
    const b = posted(row(2, "met", "mask", "sub-saharan", "yoruba"), 2);
    const c = posted(row(3, "met", "mask", "sub-saharan", "Bwa"), 3);
    expect(cultureRepeats("Yoruba", [a, b])).toBe(true);
    expect(cultureRepeats("Yoruba", [a, c])).toBe(false);
    expect(cultureRepeats(null, [a, b])).toBe(false);
  });

  it("weightedPick follows the weights and returns null on nothing to pick", () => {
    const r = rng(1);
    const hits = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i++) hits[weightedPick(["a", "b"] as const, (x) => (x === "a" ? 3 : 1), r)!]++;
    expect(hits.a / 4000).toBeGreaterThan(0.7);
    expect(hits.a / 4000).toBeLessThan(0.8);
    expect(weightedPick([], () => 1, r)).toBeNull();
  });

  it("reports a postable tier that has index rows but none left", () => {
    const rows = [row(1, "met", "mask"), row(2, "met", "sculpture")];
    const l = new Ledger(null, [posted(rows[0]!, 1)]);
    expect(exhaustedTiers(rows, l, profile)).toEqual(["mask"]);
  });
});

describe("selectArtwork", () => {
  const rows = [row(1, "met", "mask"), row(2, "met", "sculpture"), row(3, "smb", "mask")];
  const base = { profile, sourceWeights: { met: 1, smb: 2 } };

  it("re-picks after a failed fetch, a duplicate, a missing image and a denylist hit", async () => {
    const pool = Array.from({ length: 6 }, (_, i) => row(i + 10, "met", "mask"));
    const plan: Record<string, (r: IndexRow) => Artwork> = {
      "met:10": () => { throw new Error("HTTP 500"); },
      "met:11": (r) => art(r, { imageUrl: null }),
      "met:12": (r) => art(r, { rightsStatus: "blocked" }),
      "met:13": (r) => art(r, { title: "denied thing" }),
    };
    const sel = await selectArtwork({
      ...base, rows: pool, ledger: new Ledger(null), rng: rng(3),
      fetch: async (r) => (plan[r.key] ? plan[r.key]!(r) : art(r)),
      deny: (a) => (a.title === "denied thing" ? "test" : null),
      maxAttempts: 10,
    });
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      const bad = new Set(["met:10", "met:11", "met:12", "met:13"]);
      expect(bad.has(sel.row.key)).toBe(false);
      for (const a of sel.attempts.slice(0, -1)) expect(a.outcome).not.toBe("picked");
    }
  });

  it("re-picks when the image cannot be fetched, and hands back what prepare produced", async () => {
    const pool = [row(1, "mia", "mask"), row(2, "mia", "mask"), row(3, "mia", "mask")];
    const sel = await selectArtwork<string>({
      ...base, rows: pool, ledger: new Ledger(null), rng: rng(9), fetch: async (r) => art(r),
      prepare: async (a) => {
        if (a.key !== "mia:2") throw new Error("HTTP 403 AccessDenied");
        return `bytes-of-${a.key}`;
      },
    });
    expect(sel.ok && sel.prepared).toBe("bytes-of-mia:2");
    expect(sel.attempts.filter((a) => a.outcome === "image-failed").length).toBe(sel.attempts.length - 1);
  });

  it("gives up after 5 attempts and says so", async () => {
    const pool = Array.from({ length: 9 }, (_, i) => row(i, "met", "mask"));
    const sel = await selectArtwork({ ...base, rows: pool, ledger: new Ledger(null), fetch: async () => { throw new Error("down"); } });
    expect(sel).toMatchObject({ ok: false, reason: "ATTEMPTS_EXHAUSTED" });
    expect(sel.attempts).toHaveLength(5);
  });

  it("reports POOL_EMPTY when every row is posted, and when only a capped region is left", async () => {
    const l = new Ledger(null, rows.map((r, i) => posted(r, i)));
    expect(await selectArtwork({ ...base, rows, ledger: l, fetch: async (r) => art(r) })).toMatchObject({ ok: false, reason: "POOL_EMPTY" });

    const egypt = Array.from({ length: 11 }, (_, i) => row(100 + i, "met", "mask", "egypt"));
    const l2 = new Ledger(null, egypt.slice(0, 10).map((r, i) => posted(r, i)));
    const sel = await selectArtwork({ ...base, rows: [egypt[10]!], ledger: l2, fetch: async (r) => art(r) });
    expect(sel).toMatchObject({ ok: false, reason: "POOL_EMPTY" });
  });

  it("applies the culture rule after fetch, because SMB index rows have no culture", async () => {
    const smb = [row(1, "smb", "mask"), row(2, "smb", "mask"), row(3, "smb", "mask")];
    const prior = [posted(row(90, "met", "mask", "sub-saharan", "Eket"), 1), posted(row(91, "met", "mask", "sub-saharan", "Eket"), 2)];
    const sel = await selectArtwork({
      ...base, rows: smb, ledger: new Ledger(null, prior), rng: rng(5),
      fetch: async (r) => art(r, { culture: r.key === "smb:3" ? "Bwa" : "Eket" }),
    });
    expect(sel.ok && sel.row.key).toBe("smb:3");
    expect(sel.attempts.filter((a) => a.outcome === "culture-repeat").length).toBe(sel.attempts.length - 1);
  });
});

describe("selector simulation: 1,000 runs on a toy index", () => {
  it("never repeats, draws masks earlier than the rest, honours the Egypt cap and fairness", async () => {
    const toy: IndexRow[] = [];
    let n = 0;
    for (const source of ["a", "b", "c"]) {
      for (let i = 0; i < 80; i++) toy.push(row(n++, source, "mask", i % 3 === 0 ? "egypt" : "sub-saharan"));
      for (let i = 0; i < 160; i++) toy.push(row(n++, source, "sculpture", i % 3 === 0 ? "egypt" : "sub-saharan"));
      for (let i = 0; i < 160; i++) toy.push(row(n++, source, "other", i % 3 === 0 ? "egypt" : "sub-saharan"));
    }
    const ledger = new Ledger(null);
    const r = rng(2026);
    const order: ObjectClass[] = [];
    const sources: string[] = [];
    const seen = new Set<string>();
    const regions: RegionGroup[] = [];

    for (let i = 0; i < 1000; i++) {
      const sel = await selectArtwork({ rows: toy, ledger, profile, sourceWeights: { a: 1, b: 1, c: 3 }, rng: r, fetch: async (x) => art(x) });
      if (!sel.ok) throw new Error(`run ${i}: ${sel.reason}`);
      expect(seen.has(sel.artwork.key)).toBe(false);
      seen.add(sel.artwork.key);
      order.push(sel.row.objectClass);
      sources.push(sel.row.source);
      regions.push(sel.row.regionGroup);
      ledger.append(posted(sel.row, i));
    }

    const meanPos = (c: ObjectClass) => {
      const idx = order.flatMap((x, i) => (x === c ? [i] : []));
      return idx.reduce((s, x) => s + x, 0) / idx.length;
    };
    expect(meanPos("mask")).toBeLessThan(meanPos("sculpture"));
    expect(meanPos("sculpture")).toBeLessThan(meanPos("other"));

    for (let i = 0; i + 24 <= regions.length; i++) {
      expect(regions.slice(i, i + 24).filter((g) => g === "egypt").length).toBeLessThanOrEqual(10); // 40% of 24 = 9.6, capped at 10
    }
    // Fairness is a soft halving, not a hard cap: the triple-weight source leads, but by less than its raw 3/5 share.
    const share = sources.filter((x) => x === "c").length / sources.length;
    expect(share).toBeGreaterThan(1 / 3);
    expect(share).toBeLessThan(0.6);
  }, 60_000);
});

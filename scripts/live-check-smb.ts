/**
 * Production-readiness gate, step 1 (spec 11.4): build the real SMB index, fetch N random indexed ids from the
 * live source, and check that each record normalises and each image URL returns a valid JPEG within Bluesky's limit.
 *
 * Usage: npx tsx scripts/live-check-smb.ts <out_dir> [sample_size=20]
 * Respects the 1 req/s limit through the adapter's HttpClient. Writes index + results to <out_dir>, never to the repo.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SmbAdapter } from "../src/adapters/smb.js";
import { HttpClient } from "../src/http.js";
import type { IndexRow } from "../src/types.js";

const BLUESKY_MAX_BYTES = 2_000_000;

const out = process.argv[2];
if (!out) throw new Error("usage: live-check-smb.ts <out_dir> [sample_size]");
const sampleSize = Number(process.argv[3] ?? 20);
mkdirSync(out, { recursive: true });

const adapter = new SmbAdapter();
const t0 = Date.now();
const rows: IndexRow[] = [];
for await (const r of adapter.buildIndex()) rows.push(r);
writeFileSync(path.join(out, "index.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const byClass: Record<string, number> = {};
const byRegion: Record<string, number> = {};
for (const r of rows) {
  byClass[r.objectClass] = (byClass[r.objectClass] ?? 0) + 1;
  byRegion[r.regionGroup] = (byRegion[r.regionGroup] ?? 0) + 1;
}
console.log(`index: ${rows.length} rows in ${Math.round((Date.now() - t0) / 1000)}s`, { byClass, byRegion });

// Weighted towards what will actually be posted: sample across all rows, uniformly.
const picks = [...rows].sort(() => Math.random() - 0.5).slice(0, sampleSize);
const img = new HttpClient({ minIntervalMs: 1000, stopOnBlock: true });
const results: unknown[] = [];
let bad = 0;

for (const row of picks) {
  const res: Record<string, unknown> = { key: row.key, indexedClass: row.objectClass };
  try {
    const a = await adapter.fetchArtwork(row.sourceObjectId);
    Object.assign(res, {
      title: a.title, objectType: a.objectType, objectClass: a.objectClass, regionGroup: a.regionGroup,
      rights: a.rightsStatus, license: a.imageLicense, accession: a.accessionNumber, objectUrl: a.objectUrl,
    });
    if (a.objectClass !== row.objectClass) res.classMismatch = true;
    if (a.rightsStatus === "blocked") {
      res.note = "blocked at fetch time (no usable licence): correctly excluded from posting";
    } else if (a.imageUrl) {
      const r = await img.get(a.imageUrl);
      const buf = new Uint8Array(await r.arrayBuffer());
      const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
      Object.assign(res, { imageStatus: r.status, imageBytes: buf.length, jpeg });
      if (r.status !== 200 || !jpeg || buf.length > BLUESKY_MAX_BYTES) throw new Error("image check failed");
    } else {
      throw new Error("no image url on a non-blocked artwork");
    }
  } catch (e) {
    bad++;
    res.error = String(e);
  }
  results.push(res);
  console.log(JSON.stringify(res));
}

writeFileSync(path.join(out, "live-check.json"), JSON.stringify(results, null, 1));
console.log(`done: ${picks.length - bad}/${picks.length} ok, ${bad} failed`);
process.exit(bad > 0 ? 1 : 0);

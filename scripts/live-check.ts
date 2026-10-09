/**
 * Production-readiness gate, step 1 (spec 11.4), for any source: build the real index, fetch N random indexed ids from the
 * live source, and check that each record normalises, renders within both platforms' limits, and has an image that decodes
 * and can be made to fit Bluesky's limit.
 *
 * Usage: npx tsx scripts/live-check.ts <source> <out_dir> [sample_size=20] [--max-index=N]
 *   --max-index=N  Met or Louvre: index just the first N objects (a full Met build is ~17,000 requests, the Louvre ~90,000).
 *   --reuse-index  Sample from the <out_dir>/<source>-index.jsonl of an earlier run instead of rebuilding it.
 *   --region=G     Sample only rows whose region group is G (e.g. sub-saharan), so a small group is not drowned out.
 * Respects each source's pacing through its HttpClient. Writes index + results to <out_dir>, never to the repo.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LouvreAdapter, type LouvreCacheEntry, type LouvreIdsEntry } from "../src/adapters/louvre.js";
import { MetAdapter } from "../src/adapters/met.js";
import { createAdapter } from "../src/adapters/index.js";
import { loadDenylist } from "../src/config.js";
import { denyReason } from "../src/denylist.js";
import { HttpClient } from "../src/http.js";
import { downloadImage, prepareImage } from "../src/image.js";
import { LIMITS, measure, renderPost } from "../src/render.js";
import { JsonCache, louvreCacheFile, louvreIdsFile } from "../src/state.js";
import type { IndexRow } from "../src/types.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [source, out] = args;
const sampleSize = Number(args[2] ?? 20);
const maxIndex = Number(process.argv.find((a) => a.startsWith("--max-index="))?.slice(12) ?? 0) || undefined;
if (!source || !out) throw new Error("usage: live-check.ts <source> <out_dir> [sample_size] [--max-index=N]");
mkdirSync(out, { recursive: true });

const region = process.argv.find((a) => a.startsWith("--region="))?.slice(9);
const reuseIndex = process.argv.includes("--reuse-index");
const indexFile = path.join(out, `${source}-index.jsonl`);

const adapter =
  source === "met" && maxIndex
    ? new MetAdapter(undefined, undefined, undefined, { maxObjects: maxIndex })
    : source === "louvre" && maxIndex
      ? new LouvreAdapter(undefined, undefined, undefined, {
          maxObjects: maxIndex,
          cache: new JsonCache<LouvreCacheEntry>(louvreCacheFile()),
          idsCache: new JsonCache<LouvreIdsEntry>(louvreIdsFile()),
        })
      : createAdapter(source);
const deny = loadDenylist();
const t0 = Date.now();
const rows: IndexRow[] = [];
if (reuseIndex) {
  for (const line of readFileSync(indexFile, "utf8").split("\n")) if (line.trim()) rows.push(JSON.parse(line) as IndexRow);
} else {
  for await (const r of adapter.buildIndex()) rows.push(r);
  writeFileSync(indexFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const tally = (key: "objectClass" | "regionGroup") =>
  rows.reduce<Record<string, number>>((m, r) => ((m[r[key]] = (m[r[key]] ?? 0) + 1), m), {});
console.log(`index: ${rows.length} rows in ${Math.round((Date.now() - t0) / 1000)}s`, { byClass: tally("objectClass"), byRegion: tally("regionGroup") });

const picks = rows.filter((r) => !region || r.regionGroup === region).sort(() => Math.random() - 0.5).slice(0, sampleSize);
const img = new HttpClient({ minIntervalMs: 1000 });
const results: Array<Record<string, unknown>> = [];
let bad = 0;

for (const row of picks) {
  const res: Record<string, unknown> = { key: row.key, indexedClass: row.objectClass };
  try {
    const a = await adapter.fetchArtwork(row.sourceObjectId);
    Object.assign(res, {
      title: a.title, objectType: a.objectType, objectClass: a.objectClass, regionGroup: a.regionGroup, culture: a.culture,
      rights: a.rightsStatus, license: a.imageLicense, accession: a.accessionNumber, objectUrl: a.objectUrl,
    });
    if (a.objectClass !== row.objectClass) res.classMismatch = true;
    if (a.regionGroup !== row.regionGroup) res.regionMismatch = true;
    const denied = denyReason(a, deny);
    if (denied) res.denied = denied;
    if (a.rightsStatus === "reserved") res.note = "no open licence: posted with the museum's rights statement";
    if (!a.imageUrl) throw new Error("no image url");

    const prepared = await prepareImage(await downloadImage(a.imageUrl, img));
    Object.assign(res, { imageBytes: prepared.bytes.length, imageMime: prepared.mime, size: `${prepared.width}x${prepared.height}`, resized: prepared.resized, originalBytes: prepared.originalBytes });

    for (const platform of ["bluesky", "threads"] as const) {
      const post = renderPost(a, platform, { resized: prepared.resized });
      const over = [post.root, post.reply].some((t) => measure(t, platform) > LIMITS[platform]) || measure(post.alt, "threads") > 1000;
      if (over || !post.alt) throw new Error(`render over limit or no alt on ${platform}`);
    }
  } catch (e) {
    bad++;
    res.error = String(e);
  }
  results.push(res);
  console.log(JSON.stringify(res));
}

writeFileSync(path.join(out, `${source}${region ? `-${region}` : ""}-live-check.json`),JSON.stringify(results, null, 1));
console.log(`done: ${picks.length - bad}/${picks.length} ok, ${bad} failed; classMismatch ${results.filter((r) => r.classMismatch).length}, denied ${results.filter((r) => r.denied).length}`);
process.exit(bad > 0 ? 1 : 0);

/**
 * Production-readiness gate, steps 2-3 (spec 11.4): write a random sample of N indexed objects as a markdown table to
 * check by hand against each museum's own page (rights wording; object_class and region_group; human-remains or sacred hits).
 *
 * Usage: npx tsx scripts/audit-sample.ts <source> <out_dir> [n=50] [--rebuild]
 * Uses state/index/<source>.jsonl when present, else builds the index. Writes <out_dir>/<source>-audit.md and .json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAdapter } from "../src/adapters/index.js";
import { loadDenylist } from "../src/config.js";
import { denyReason } from "../src/denylist.js";
import { renderPost } from "../src/render.js";
import { readIndex, writeIndex } from "../src/state.js";
import type { IndexRow } from "../src/types.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [source, out] = args;
const n = Number(args[2] ?? 50);
if (!source || !out) throw new Error("usage: audit-sample.ts <source> <out_dir> [n] [--rebuild]");
mkdirSync(out, { recursive: true });

const adapter = createAdapter(source);
let rows = process.argv.includes("--rebuild") ? null : readIndex(source);
if (!rows) {
  rows = [];
  for await (const r of adapter.buildIndex()) rows.push(r as IndexRow);
  writeIndex(source, rows);
}
console.log(`index: ${rows.length} rows`);

const deny = loadDenylist();
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const sample = [...rows].sort(() => Math.random() - 0.5).slice(0, n);
const lines = [
  `| # | key | class | region | rights | licence | photographer | type | title | deny | page |`,
  `|---|---|---|---|---|---|---|---|---|---|---|`,
];
const json: unknown[] = [];

for (const [i, row] of sample.entries()) {
  try {
    const a = await adapter.fetchArtwork(row.sourceObjectId);
    const reply = renderPost(a, "bluesky", { resized: false }).reply;
    const rightsLine = reply.split("\n").filter((l) => /licen|©|Photo|Rights|Public Domain|CC /i.test(l)).join(" ⏎ ");
    lines.push(
      `| ${i + 1} | ${a.key} | ${a.objectClass}${a.objectClass !== row.objectClass ? ` (index ${row.objectClass})` : ""} | ${a.regionGroup} | ${a.rightsStatus} | ${cell(a.imageLicense)} | ${cell(a.photographer)} | ${cell(a.objectType)} | ${cell(a.title)} | ${cell(denyReason(a, deny))} | ${a.objectUrl} |`,
    );
    json.push({ ...a, indexedClass: row.objectClass, rightsLine });
  } catch (e) {
    lines.push(`| ${i + 1} | ${row.key} | ERROR ${cell(e)} | | | | | | | | |`);
  }
  console.log(`${i + 1}/${sample.length} ${row.key}`);
}

writeFileSync(path.join(out, `${source}-audit.md`), lines.join("\n") + "\n");
writeFileSync(path.join(out, `${source}-audit.json`), JSON.stringify(json, null, 1));
console.log(`wrote ${path.join(out, `${source}-audit.md`)}`);

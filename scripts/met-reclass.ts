/**
 * Re-derive class, score and origin of cached Met rows from the Met's open-data CSV instead of refetching each object
 * (the Met API is rate-limited to about 1 request a second; 13,000 refetches take hours). Use after a classifier change
 * (bump CLASS_VERSION in src/adapters/met.ts first). Rows the CSV does not hold keep their old `v` and are refetched.
 *
 * The CSV is a Git LFS file: download it from https://media.githubusercontent.com/media/metmuseum/openaccess/master/MetObjects.csv
 * (the raw.githubusercontent.com URL returns only an LFS pointer) into its own directory.
 *
 * Usage: npx tsx scripts/met-reclass.ts <MetObjects.csv> [cache=state/index/met.cache.json] [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { classWeight } from "../src/classify.js";
import { loadProfile, loadSourceConfig } from "../src/config.js";
import { classifyRecord, isFlatFragment, isSherd, scoreFor } from "../src/adapters/common.js";
import { metOriginOk, type MetCacheEntry, type MetSourceConfig } from "../src/adapters/met.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const [csvPath, cachePath = "state/index/met.cache.json"] = args.filter((a) => !a.startsWith("--"));
if (!csvPath) throw new Error("usage: met-reclass.ts <MetObjects.csv> [cache] [--write]");
const VERSION = Number(/const CLASS_VERSION = (\d+)/.exec(readFileSync("src/adapters/met.ts", "utf8"))?.[1]);

const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, MetCacheEntry>;
const profile = loadProfile();
const cfg = loadSourceConfig<MetSourceConfig>("met");
const extra = new Set((cfg.extra_objects ?? []).map((x) => String(x.id)));

// Departments whose cached rows were origin-checked (the others are African by construction).
const ORIGIN_DEPT_NAMES = new Set(["Greek and Roman Art", "Islamic Art", "Medieval Art", "Arms and Armor", "Ancient West Asian Art", "Ancient Near Eastern Art", "The Cloisters"]);

// Minimal RFC 4180 reader over the whole file (484,000 records, about 320 MB).
const text = readFileSync(csvPath, "utf8");
let i = 0;
function readRecord(): string[] | null {
  if (i >= text.length) return null;
  const rec: string[] = [];
  let f = "";
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      for (;;) {
        const j = text.indexOf('"', i);
        f += text.slice(i, j);
        i = j + 1;
        if (text[i] === '"') { f += '"'; i++; } else break;
      }
    } else if (c === ",") { rec.push(f); f = ""; i++; }
    else if (c === "\n") { rec.push(f); i++; return rec; }
    else if (c === "\r") i++;
    else { f += c; i++; }
  }
  rec.push(f);
  return rec;
}
const header = readRecord()!.map((h) => h.replace(/^﻿/, ""));
const col = Object.fromEntries(header.map((h, k) => [h, k])) as Record<string, number>;

const stats = { seen: 0, missing: 0, classChanged: 0, originDropped: 0, unchanged: 0 };
const moves: Record<string, number> = {};
const examples: Record<string, string[]> = {};
const names: Record<string, Record<string, number>> = {};
let r: string[] | null;
while ((r = readRecord())) {
  const id = r[col["Object ID"]!]!;
  const e = cache[id];
  if (!e || !e.row || (e.v ?? 0) >= VERSION) continue;
  stats.seen++;
  const name = r[col["Object Name"]!]!;
  const title = r[col["Title"]!]!;
  const cls = classifyRecord(name, title, profile, r[col["Classification"]!]);
  const weight = classWeight(cls, profile);
  const originOk =
    extra.has(id) ||
    metOriginOk({
      objectID: Number(id), department: r[col["Department"]!], country: r[col["Country"]!], culture: r[col["Culture"]!], region: r[col["Region"]!],
    });
  if (ORIGIN_DEPT_NAMES.has(r[col["Department"]!]!) && !originOk) {
    stats.originDropped++;
    cache[id] = { ...e, row: null, v: VERSION };
    continue;
  }
  if (weight <= 0) { cache[id] = { ...e, row: null, v: VERSION }; continue; }
  const score = scoreFor(weight, { highlight: r[col["Is Highlight"]!] === "True", fragment: isFlatFragment(name, title), sherd: isSherd(cls, name, title) });
  const nm = ((names[cls] ??= {})[name.toLowerCase().split(/[,;]/)[0]!.trim()] ??= 0);
  names[cls]![name.toLowerCase().split(/[,;]/)[0]!.trim()] = nm + 1;
  if (cls !== e.row.objectClass) {
    stats.classChanged++;
    const k = `${e.row.objectClass} -> ${cls}`;
    moves[k] = (moves[k] ?? 0) + 1;
    (examples[k] ??= []).length < 8 && examples[k]!.push(`${name} / ${title}`.slice(0, 70));
  } else stats.unchanged++;
  cache[id] = { ...e, row: { ...e.row, objectClass: cls, score }, v: VERSION };
}
stats.missing = Object.values(cache).filter((x) => x.row && (x.v ?? 0) < VERSION).length;
console.log(JSON.stringify(stats), JSON.stringify(moves, null, 1));
if (args.includes("--examples")) {
  console.log(JSON.stringify(examples, null, 1));
  for (const [c, n] of Object.entries(names)) console.log(c, Object.values(n).reduce((a, b) => a + b, 0), Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, v]) => `${k} ${v}`).join(" | "));
}
if (write) {
  writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`wrote ${cachePath}`);
}

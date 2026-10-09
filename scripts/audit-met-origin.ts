/**
 * Origin-rule audit for the Met departments added on 2026-10-09 (Greek and Roman, Islamic, Medieval, Ancient West Asian):
 * sample N records per department straight from the search, apply the adapter's own origin test, and print accepted and
 * rejected rows so both false accepts and false rejects can be read by hand.
 *
 * Usage: npx tsx scripts/audit-met-origin.ts <out_dir> [per_dept=15]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadDenylist, loadProfile, loadSourceConfig } from "../src/config.js";
import { denyReason } from "../src/denylist.js";
import { HttpClient } from "../src/http.js";
import { metOriginOk, normaliseMetObject, type MetObject, type MetSourceConfig } from "../src/adapters/met.js";

const [out, perArg] = process.argv.slice(2);
if (!out) throw new Error("usage: audit-met-origin.ts <out_dir> [per_dept]");
mkdirSync(out, { recursive: true });
const per = Number(perArg ?? 15);

const API = "https://collectionapi.metmuseum.org/public/collection";
const cfg = loadSourceConfig<MetSourceConfig>("met");
const profile = loadProfile();
const deny = loadDenylist();
const http = new HttpClient({ minIntervalMs: cfg.min_interval_ms, stopOnBlock: true });
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, 48);

const added = cfg.departments.filter((d) => d.origin_check || d.id === 3);
const lines = ["| dept | id | verdict | class | region | geoType | country | culture | type | title | date | img | deny |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
const stats: Record<string, { in: number; out: number }> = {};

for (const dept of added) {
  const q = new URLSearchParams({ departmentId: String(dept.id), hasImages: "true", q: "*" });
  if (dept.geo_location) q.set("geoLocation", dept.geo_location);
  const s = await http.getJson<{ total: number; objectIDs: number[] | null }>(`${API}/v1.1/search?${q}`);
  const ids = [...(s.objectIDs ?? [])].sort(() => Math.random() - 0.5).slice(0, per);
  stats[dept.id] = { in: 0, out: 0 };
  console.log(`dept ${dept.id}: ${s.total} hits, sampling ${ids.length}`);
  for (const id of ids) {
    const o = await http.getJson<MetObject & { geographyType?: string }>(`${API}/v1/objects/${id}`);
    const a = normaliseMetObject(o, profile, false);
    const ok = dept.origin_check ? metOriginOk(o) : true;
    stats[dept.id]![ok ? "in" : "out"]++;
    lines.push(
      `| ${dept.id} | ${id} | ${ok ? "IN" : "out"} | ${a.objectClass} | ${a.regionGroup} | ${cell(o.geographyType)} | ${cell(o.country || o.region)} | ${cell(o.culture)} | ${cell(o.objectName)} | ${cell(o.title)} | ${cell(o.objectDate)} | ${a.imageUrl ? "img" : "noimg"} | ${cell(denyReason(a, deny))} |`,
    );
  }
}

writeFileSync(path.join(out, "met-origin-audit.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(JSON.stringify(stats));

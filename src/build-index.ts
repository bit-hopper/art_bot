/**
 * Daily index rebuild (spec 5.3): `npx tsx src/build-index.ts [source ...]` (default: every enabled source).
 * A source that fails keeps its previous index file and the run exits 1 after the others finish.
 */
import { createAdapter, enabledAdapters } from "./adapters/index.js";
import { markIndexBuilt } from "./health.js";
import { writeIndex } from "./state.js";
import { pushState } from "./state-sync.js";
import type { IndexRow } from "./types.js";

const ids = process.argv.slice(2);
const adapters = ids.length > 0 ? ids.map(createAdapter) : enabledAdapters();
let failed = 0;

for (const adapter of adapters) {
  const t0 = Date.now();
  try {
    const rows: IndexRow[] = [];
    for await (const r of adapter.buildIndex()) rows.push(r);
    if (rows.length === 0) throw new Error("index came back empty; keeping the previous one");
    writeIndex(adapter.id, rows);
    markIndexBuilt(adapter.id);
    pushState(`index ${adapter.id}`);
    const byClass: Record<string, number> = {};
    for (const r of rows) byClass[r.objectClass] = (byClass[r.objectClass] ?? 0) + 1;
    console.log(JSON.stringify({ event: "index", source: adapter.id, rows: rows.length, seconds: Math.round((Date.now() - t0) / 1000), byClass }));
  } catch (e) {
    failed++;
    console.error(JSON.stringify({ event: "index-failed", source: adapter.id, error: e instanceof Error ? e.message : String(e) }));
  }
}
process.exit(failed > 0 ? 1 : 0);

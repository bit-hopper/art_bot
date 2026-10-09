import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IndexRow } from "./types.js";

/** Where `ledger.jsonl` and `index/*.jsonl` live: the checked-out `state` branch in Actions (M2), `./state` locally. */
export const stateDir = () => path.resolve(process.env.STATE_DIR ?? "state");
export const ledgerFile = () => path.join(stateDir(), "ledger.jsonl");
const indexFile = (id: string) => path.join(stateDir(), "index", `${id}.jsonl`);

export function readIndex(id: string): IndexRow[] | null {
  const f = indexFile(id);
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as IndexRow);
}

/** Written to a temp file and renamed, so a crash mid-write never replaces a good index (spec 5.3). */
export function writeIndex(id: string, rows: IndexRow[]): void {
  const f = indexFile(id);
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  renameSync(tmp, f);
}

/** A small JSON-file key/value store for per-source crawl caches (e.g. Met object classes), kept on the state branch. */
export class JsonCache<V> {
  private readonly data: Record<string, V>;

  constructor(private readonly file: string | null) {
    this.data = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, V>) : {};
  }

  get(key: string): V | undefined {
    return this.data[key];
  }

  set(key: string, value: V): void {
    this.data[key] = value;
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }
}

export const louvreCacheFile = () => path.join(stateDir(), "index", "louvre.cache.json");
export const louvreIdsFile = () => path.join(stateDir(), "index", "louvre.ids.json");
export const metCacheFile = () => path.join(stateDir(), "index", "met.cache.json");

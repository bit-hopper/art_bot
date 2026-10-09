import type { MuseumAdapter } from "../types.js";
import { enabledSourceIds } from "../config.js";
import { AicAdapter } from "./aic.js";
import { ClevelandAdapter } from "./cleveland.js";
import { MetAdapter, type MetCacheEntry } from "./met.js";
import { MiaAdapter } from "./mia.js";
import { SmbAdapter } from "./smb.js";
import { JsonCache, metCacheFile } from "../state.js";

const FACTORIES: Record<string, () => MuseumAdapter> = {
  smb: () => new SmbAdapter(),
  met: () => new MetAdapter(undefined, undefined, undefined, { cache: new JsonCache<MetCacheEntry>(metCacheFile()) }),
  cleveland: () => new ClevelandAdapter(),
  aic: () => new AicAdapter(),
  mia: () => new MiaAdapter(),
};

export function createAdapter(id: string): MuseumAdapter {
  const make = FACTORIES[id];
  if (!make) throw new Error(`unknown source "${id}" (known: ${Object.keys(FACTORIES).join(", ")})`);
  return make();
}

/** Adapters whose `enabled` flag in `config/sources.yaml` is true: the per-source kill switch (spec 10). */
export function enabledAdapters(): MuseumAdapter[] {
  return enabledSourceIds().filter((id) => id in FACTORIES).map(createAdapter);
}

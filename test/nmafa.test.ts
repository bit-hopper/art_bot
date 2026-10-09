import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { madeOutsideAfrica, NmafaAdapter, normaliseNmafaRecord, type NmafaRecord, type NmafaSourceConfig } from "../src/adapters/nmafa.js";
import { loadProfile, loadSourceConfig } from "../src/config.js";
import { HttpClient } from "../src/http.js";
import type { IndexRow } from "../src/types.js";

const text = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/nmafa/records.jsonl"), "utf8");
const records = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as NmafaRecord);
const byId = (id: string) => records.find((r) => r.content.descriptiveNonRepeating.record_ID === id)!;
const profile = loadProfile();
const cfg = loadSourceConfig<NmafaSourceConfig>("nmafa");

describe("nmafa", () => {
  it("normalises a CC0 sculpture with its own image, place and provenance", () => {
    const a = normaliseNmafaRecord(byId("nmafa_2015-9-24"), profile, cfg.non_african_places);
    expect(a.key).toBe("nmafa:nmafa_2015-9-24");
    expect(a.title).toBe("Divination tapper");
    expect(a.objectClass).toBe("sculpture");
    expect(a.regionGroup).toBe("sub-saharan");
    expect(a.culture).toBe("Yoruba artist");
    expect(a.country).toBe("Nigeria");
    expect(a.rightsStatus).toBe("open");
    expect(a.imageLicense).toBe("CC0");
    expect(a.imageUrl).toMatch(/^https:\/\/ids\.si\.edu\/ids\/download\?id=NMAfA-.*\.jpg$/);
    expect(a.provenanceNote).toContain("Alain Schoffel");
    expect(a.accessionNumber).toBe("2015-9-24");
    expect(a.onView).toBe(true);
  });

  it("blocks an object made outside Africa (a coin struck in Austria)", () => {
    const a = normaliseNmafaRecord(byId("nmafa_89-4-2"), profile, cfg.non_african_places);
    expect(a.rightsStatus).toBe("blocked");
  });

  it("matches place parts exactly, not as substrings", () => {
    expect(madeOutsideAfrica("Germany; Democratic Republic of the Congo; Congo", cfg.non_african_places)).toBe(true);
    expect(madeOutsideAfrica("Owo, Nigeria", cfg.non_african_places)).toBe(false);
    expect(madeOutsideAfrica("Niger", ["Nigeria"])).toBe(false);
    expect(madeOutsideAfrica(null, cfg.non_african_places)).toBe(false);
  });

  it("indexes by shard, skips blocked rows, and fetches one shard for a post", async () => {
    const urls: string[] = [];
    const http = new HttpClient({
      minIntervalMs: 0, sleep: async () => {}, stopOnBlock: true,
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(String(input).endsWith("/01.txt") ? text : "");
      }) as typeof fetch,
    });
    const adapter = new NmafaAdapter({ ...cfg, shards: 3 }, profile, http);
    const rows: IndexRow[] = [];
    for await (const r of adapter.buildIndex()) rows.push(r);
    expect(urls).toHaveLength(3);
    expect(rows.map((r) => r.key).sort()).toEqual(["nmafa:01/nmafa_2004-7-2", "nmafa:01/nmafa_2015-9-24"]);
    urls.length = 0;
    const a = await adapter.fetchArtwork("01/nmafa_2015-9-24");
    expect(urls).toEqual([`${cfg.bulk_url}/01.txt`]);
    expect(a.key).toBe("nmafa:01/nmafa_2015-9-24");
    expect(a.title).toBe("Divination tapper");
  });
});

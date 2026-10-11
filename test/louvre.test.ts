import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LouvreAdapter, normaliseLouvreRecord, pickImage, splitCopyright, type LouvreCacheEntry, type LouvreIdsEntry, type LouvreSourceConfig } from "../src/adapters/louvre.js";
import { loadDenylist, loadProfile, loadSourceConfig } from "../src/config.js";
import { denyReason } from "../src/denylist.js";
import { HttpClient } from "../src/http.js";
import { rightsLine } from "../src/render.js";
import { JsonCache } from "../src/state.js";
import type { IndexRow } from "../src/types.js";

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "louvre");
const json = (f: string) => JSON.parse(readFileSync(path.join(fx, f), "utf8"));
const profile = loadProfile();
const cfg = loadSourceConfig<LouvreSourceConfig>("louvre");

function fake(route: (url: string) => string | Response) {
  const urls: string[] = [];
  const http = new HttpClient({
    minIntervalMs: 0,
    sleep: async () => {},
    stopOnBlock: true,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const out = route(url);
      return out instanceof Response ? out : new Response(out, { headers: { "content-type": url.endsWith(".json") ? "application/json" : "application/xml" } });
    }) as typeof fetch,
  });
  return { http, urls };
}

async function collect(it: AsyncIterable<IndexRow>): Promise<IndexRow[]> {
  const rows: IndexRow[] = [];
  for await (const r of it) rows.push(r);
  return rows;
}

const ark = (id: string) => `https://collections.louvre.fr/ark:/53355/${id}`;
const sitemap = (...ids: string[]) =>
  `<urlset>${ids.flatMap((id) => [`<url><loc>${ark(id)}</loc></url>`, `<url><loc>https://collections.louvre.fr/en/ark:/53355/${id}</loc></url>`]).join("")}</urlset>`;

describe("Louvre normalisation", () => {
  it("Egyptian shabti: sculpture, egypt, credited to the Louvre and its photographer, no open licence claimed", () => {
    const a = normaliseLouvreRecord(json("shabti.json"), profile, cfg.exclude_terms);
    expect(a).toMatchObject({
      key: "louvre:cl010026595", objectClass: "sculpture", regionGroup: "egypt", country: "Egypt", rightsStatus: "attributed",
      objectUrl: "https://collections.louvre.fr/ark:/53355/cl010026595",
    });
    expect(a.imageUrl).toMatch(/^https:\/\/collections\.louvre\.fr\/media\/cache\//);
    expect(a.imageLicense).toMatch(/^© \d{4} Musée du Louvre/);
    expect(a.accessionNumber).toBeTruthy();
    expect(rightsLine(a, false)).toMatch(/^Source: Musée du Louvre\. Photo: .+ \(© \d{4} Musée du Louvre/);
  });

  it("maps French fields: gallery room, acquisition, material, dimensions", () => {
    const a = normaliseLouvreRecord(json("kohl-tube.json"), profile, cfg.exclude_terms);
    expect(a).toMatchObject({
      objectClass: "other-carved-cast", gallery: "Room 330", onView: true, creditLine: "Purchase, 1852", medium: "bois",
      department: "Département des Antiquités égyptiennes", accessionNumber: "E 207",
    });
    expect(a.dimensions).toBe("H 9,2 cm, Diam. 3,5 cm");
    expect(a.imageLicense).toBe("© 2002 Musée du Louvre, Dist. GrandPalaisRmn");
    expect(a.photographer).toBe("Christian Décamps");
  });

  it("a fragment is blocked even though its title does not say so (the note is in the denomination)", () => {
    const r = json("amulet-fragment.json");
    expect(r.title).not.toMatch(/fragment/i);
    expect(normaliseLouvreRecord(r, profile, cfg.exclude_terms).rightsStatus).toBe("blocked");
    expect(normaliseLouvreRecord(r, profile, []).rightsStatus).toBe("attributed");
  });

  it("tolerates list fields that arrive as empty strings", () => {
    const r = { ...json("shabti.json"), dimension: "", dateCreated: "", objectNumber: "", acquisitionDetails: "", image: "" };
    expect(normaliseLouvreRecord(r, profile)).toMatchObject({ dimensions: null, accessionNumber: null, creditLine: null, rightsStatus: "blocked" });
  });

  it("an object with no usable image is blocked", () => {
    expect(normaliseLouvreRecord({ ...json("shabti.json"), image: [] }, profile).rightsStatus).toBe("blocked");
  });

  it("splits the credit and photographer, and skips images credited to another institution", () => {
    expect(splitCopyright("© 2017 Musée du Louvre, Dist. GrandPalaisRmn / Christian Décamps")).toEqual({
      credit: "© 2017 Musée du Louvre, Dist. GrandPalaisRmn", photographer: "Christian Décamps",
    });
    expect(splitCopyright("© 2023 Musée du Louvre / Département des Antiquités égyptiennes").photographer).toBeNull();
    const orsay = { urlImage: "https://x/a.jpg", copyright: "© GrandPalaisRmn (Musée d'Orsay) / Foo" };
    const ok = { urlImage: "https://x/b.jpg", copyright: "© 2010 Musée du Louvre" };
    expect(pickImage([orsay, ok])).toBe(ok);
    expect(pickImage([orsay])).toBeNull();
  });
});

describe("Louvre denylist and classifier", () => {
  const deny = loadDenylist();
  const base = normaliseLouvreRecord(json("shabti.json"), profile, cfg.exclude_terms);

  it("blocks a mummy or human remains in French, but not 'momiforme' (a shabti's mummy shape)", () => {
    expect(denyReason(base, deny)).toBeNull();
    expect(denyReason({ ...base, objectType: "momie" }, deny)).toMatch(/object type/);
    expect(denyReason({ ...base, objectType: "cercueil", description: "cercueil et momie d'un prêtre" }, deny)).toMatch(/et momie/);
    expect(denyReason({ ...base, description: "animal momifié" }, deny)).toMatch(/momifi/);
    expect(denyReason({ ...base, description: "restes humains" }, deny)).toMatch(/restes humains/);
  });

  it("lets a mummy label through (a tag, not a body) but still blocks the mummy itself", () => {
    const label = { ...base, objectType: "étiquette de momie en palette ; étiquette de momie biface", title: "étiquette de momie en palette" };
    expect(denyReason(label, deny)).toBeNull();
    expect(denyReason({ ...label, objectType: "momie" }, deny)).toMatch(/object type/);
    expect(denyReason({ ...label, description: "étiquette de momie ; fixée sur une momie de prêtre" }, deny)).toMatch(/momie/);
  });

  it("classifies French Egyptian types", () => {
    const cls = (t: string) => normaliseLouvreRecord({ ...json("shabti.json"), title: t, denominationTitle: [{ type: "Dénomination", value: t }] }, profile).objectClass;
    expect(cls("masque funéraire")).toBe("mask");
    expect(cls("statuette de Ptah")).toBe("sculpture");
    expect(cls("stèle")).toBe("sculpture");
    expect(cls("tête de roi")).toBe("sculpture");
    expect(cls("amulette")).toBe("other-carved-cast");
    expect(cls("ostracon")).toBe("other");
    expect(cls("papyrus")).toBe("other");
  });
});

describe("Louvre index build", () => {
  const route = (u: string): string | Response => {
    if (u.endsWith("/sitemap.xml")) return `<sitemapindex><sitemap><loc>https://collections.louvre.fr/media/sitemap/sitemap0.xml</loc></sitemap></sitemapindex>`;
    if (u.endsWith("sitemap0.xml")) return sitemap("cl010026595", "cl010064393", "cl010084896", "cl020000001");
    if (u.endsWith("cl010026595.json")) return JSON.stringify(json("shabti.json"));
    if (u.endsWith("cl010064393.json")) return JSON.stringify(json("painting.json"));
    if (u.endsWith("cl010084896.json")) return JSON.stringify(json("amulet-fragment.json"));
    return new Response("{}", { status: 404 });
  };

  it("lists ids from the sitemaps (cl01 only), keeps Egyptian postable objects, drops paintings and fragments", async () => {
    const { http, urls } = fake(route);
    const rows = await collect(new LouvreAdapter(cfg, profile, http).buildIndex());
    expect(rows.map((r) => r.key)).toEqual(["louvre:cl010026595"]);
    expect(rows[0]).toMatchObject({ regionGroup: "egypt", objectClass: "sculpture", score: 90 });
    const fetched = urls.filter((u) => u.endsWith(".json")).map((u) => u.split("/").pop());
    expect(fetched.sort()).toEqual(["cl010026595.json", "cl010064393.json", "cl010084896.json"]);
    expect(urls.some((u) => u.includes("/en/ark"))).toBe(false);
  });

  it("fetches each object once: a second build reads the cache and the saved id list", async () => {
    const cache = new JsonCache<LouvreCacheEntry>(null);
    const idsCache = new JsonCache<LouvreIdsEntry>(null);
    await collect(new LouvreAdapter(cfg, profile, fake(route).http, { cache, idsCache }).buildIndex());
    const again = fake(route);
    const rows = await collect(new LouvreAdapter(cfg, profile, again.http, { cache, idsCache }).buildIndex());
    expect(rows.map((r) => r.key)).toEqual(["louvre:cl010026595"]);
    expect(again.urls).toHaveLength(0);
  });

  it("stops at the per-run cap and, when blocked, keeps what the cache holds", async () => {
    const cache = new JsonCache<LouvreCacheEntry>(null);
    const capped = new LouvreAdapter({ ...cfg, max_new_per_run: 1 }, profile, fake(route).http, { cache });
    await collect(capped.buildIndex());
    expect(capped.incomplete).toBe(true);

    const blocked = fake((u) => (u.endsWith(".json") ? new Response("", { status: 429 }) : route(u)));
    const b = new LouvreAdapter(cfg, profile, blocked.http, { cache });
    await collect(b.buildIndex());
    expect(b.incomplete).toBe(true);
  });

  it("probes every Nth id and skips the stretches between two probes of the same unwanted department", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `cl01000000${i + 1}`);
    const rec = (id: string) => {
      const collection = Number(id.slice(-1)) <= 4 ? "Département des Antiquités égyptiennes" : "Département des Peintures";
      return JSON.stringify({ ...json("shabti.json"), arkId: id, collection });
    };
    const { http, urls } = fake((u) => (u.endsWith("sitemap0.xml") ? sitemap(...ids) : u.endsWith(".json") ? rec(u.split("/").pop()!.replace(".json", "")) : route(u)));
    const rows = await collect(new LouvreAdapter({ ...cfg, probe_stride: 4 }, profile, http).buildIndex());
    const fetched = urls.filter((u) => u.endsWith(".json")).map((u) => u.split("/").pop()!.slice(-6, -5)).sort();
    // probes 1, 5 and 9; the stretch 1..5 touches Egypt so 2-4 are fetched; 5..9 are both paintings so 6-8 are not
    expect(fetched).toEqual(["1", "2", "3", "4", "5", "9"]);
    expect(rows).toHaveLength(4);
  });

  it("crawls the stretches of an origin-rule department only when crawl_origin_stretches is on", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `cl01000000${i + 1}`);
    const rec = (id: string) => JSON.stringify({ ...json("shabti.json"), arkId: id, collection: "Département des Antiquités grecques, étrusques et romaines" });
    const fetchedWith = async (on: boolean) => {
      const { http, urls } = fake((u) => (u.endsWith("sitemap0.xml") ? sitemap(...ids) : u.endsWith(".json") ? rec(u.split("/").pop()!.replace(".json", "")) : route(u)));
      await collect(new LouvreAdapter({ ...cfg, probe_stride: 4, crawl_origin_stretches: on, origin_collections: ["Département des Antiquités grecques, étrusques et romaines"] }, profile, http).buildIndex());
      return urls.filter((u) => u.endsWith(".json")).map((u) => u.split("/").pop()!.slice(-6, -5)).sort();
    };
    expect(await fetchedWith(false)).toEqual(["1", "5", "9"]);
    expect(await fetchedWith(true)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("keeps the previous id list when the sitemap refresh is refused", async () => {
    const idsCache = new JsonCache<LouvreIdsEntry>(null);
    idsCache.set("ids", { day: 0, ids: ["cl010026595"] });
    const { http } = fake((u) => (u.endsWith(".xml") ? new Response("", { status: 403 }) : route(u)));
    const rows = await collect(new LouvreAdapter(cfg, profile, http, { idsCache }).buildIndex());
    expect(rows.map((r) => r.key)).toEqual(["louvre:cl010026595"]);
  });

  it("keeps denylist hits out of the index (here: a record that names human remains)", async () => {
    const label = { ...json("shabti.json"), arkId: "cl010001775", description: "restes humains retrouvés à l'intérieur" };
    const { http } = fake((u) => (u.endsWith("sitemap0.xml") ? sitemap("cl010001775", "cl010026595") : u.endsWith("cl010001775.json") ? JSON.stringify(label) : route(u)));
    expect((await collect(new LouvreAdapter(cfg, profile, http).buildIndex())).map((r) => r.key)).toEqual(["louvre:cl010026595"]);
  });

  it("fetchArtwork returns the normalised record", async () => {
    const { http } = fake(route);
    const a = await new LouvreAdapter(cfg, profile, http).fetchArtwork("cl010026595");
    expect(a.key).toBe("louvre:cl010026595");
  });
});

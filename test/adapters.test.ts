import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AicAdapter, aicImageUrl, normaliseAicArtwork, type AicSourceConfig } from "../src/adapters/aic.js";
import { ClevelandAdapter, cultureMatches, normaliseClevelandArtwork, type ClevelandSourceConfig } from "../src/adapters/cleveland.js";
import { CLASS_VERSION, MetAdapter, normaliseMetObject, type MetCacheEntry, type MetSourceConfig } from "../src/adapters/met.js";
import { hasPublicImage, MiaAdapter, normaliseMiaRecord, type MiaRecord, type MiaSourceConfig } from "../src/adapters/mia.js";
import { loadDenylist, loadProfile, loadSourceConfig } from "../src/config.js";
import { denyReason } from "../src/denylist.js";
import { HttpClient, StopCrawlError } from "../src/http.js";
import { JsonCache } from "../src/state.js";
import type { IndexRow } from "../src/types.js";

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const json = (f: string) => JSON.parse(readFileSync(path.join(fx, f), "utf8"));
const profile = loadProfile();
const deny = loadDenylist();

/** An HttpClient whose network is `route(url)`; every URL requested is recorded. */
function fake(route: (url: string) => unknown | Response) {
  const urls: string[] = [];
  const http = new HttpClient({
    minIntervalMs: 0,
    sleep: async () => {},
    stopOnBlock: true,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const out = route(url);
      return out instanceof Response ? out : new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return { http, urls };
}

async function collect(it: AsyncIterable<IndexRow>): Promise<IndexRow[]> {
  const rows: IndexRow[] = [];
  for await (const r of it) rows.push(r);
  return rows;
}

describe("Met", () => {
  const cfg = { ...loadSourceConfig<MetSourceConfig>("met"), extra_objects: [] };

  it("Egyptian Open Access object: CC0, image, egypt, on view", () => {
    const a = normaliseMetObject(json("met/egypt-obj.json"), profile, true);
    expect(a).toMatchObject({
      key: "met:329767", accessionNumber: "2021.41.1", regionGroup: "egypt", rightsStatus: "open", imageLicense: "CC0",
      onView: true, gallery: "Gallery 138", department: "Egyptian Art",
      imageUrl: "https://images.metmuseum.org/CRDImages/eg/web-large/DP-21418-002.jpg",
    });
  });

  it("African mask without Open Access: no image URL, so blocked (nothing to post), not a licence filter", () => {
    const a = normaliseMetObject(json("met/africa-mask-no-image.json"), profile, false);
    expect(a).toMatchObject({ objectClass: "mask", regionGroup: "sub-saharan", culture: "Dan peoples", imageUrl: null, rightsStatus: "blocked" });
  });

  it("builds the index from searches plus one fetch per object, dropping objects without an image", async () => {
    const eg = json("met/egypt-obj.json");
    const af = json("met/africa-mask-no-image.json");
    const { http, urls } = fake((u) => {
      if (u.includes("/v1.1/search")) return { total: 2, objectIDs: [329767, 314439] };
      return u.endsWith("/329767") ? eg : af;
    });
    const rows = await collect(new MetAdapter(cfg, profile, http).buildIndex());
    expect(rows.map((r) => r.key)).toEqual(["met:329767"]);
    expect(rows[0]).toMatchObject({ regionGroup: "egypt", objectClass: "other-carved-cast", score: 40 });   // object name says "jewelry-case"
    const searches = urls.filter((u) => u.includes("/v1.1/search"));
    expect(searches.some((u) => u.includes("departmentId=5") && u.includes("geoLocation=Africa"))).toBe(true);
    expect(searches.some((u) => u.includes("departmentId=10") && !u.includes("geoLocation"))).toBe(true);
    expect(urls.filter((u) => u.includes("/objects/"))).toHaveLength(2); // ids are unioned across departments
  });

  it("fetches only ids missing from the cache, and keeps the cached rows when the WAF blocks mid-build", async () => {
    const eg = json("met/egypt-obj.json");
    const af = json("met/africa-mask-no-image.json");
    const cache = new JsonCache<MetCacheEntry>(null);
    const day = Math.floor(Date.now() / 86_400_000);
    const row: IndexRow = { key: "met:1", source: "met", sourceObjectId: "1", objectClass: "mask", regionGroup: "sub-saharan", culture: null, score: 100 };
    cache.set("1", { day, row, v: CLASS_VERSION });
    cache.set("314439", { day, row: null }); // known to have no image: not re-fetched

    const ok = fake((u) => (u.includes("/v1.1/search") ? { total: 3, objectIDs: [1, 314439, 329767] } : eg));
    const adapter = new MetAdapter(cfg, profile, ok.http, { cache });
    expect((await collect(adapter.buildIndex())).map((r) => r.key)).toEqual(["met:1", "met:329767"]);
    expect(ok.urls.filter((u) => u.includes("/objects/"))).toEqual([`${"https://collectionapi.metmuseum.org/public/collection"}/v1/objects/329767`]);

    const blocked = fake((u) => (u.includes("/v1.1/search") ? { total: 2, objectIDs: [1, 7] } : new Response("", { status: 403 })));
    const b = new MetAdapter(cfg, profile, blocked.http, { cache });
    expect((await collect(b.buildIndex())).map((r) => r.key)).toContain("met:1");
    expect(b.incomplete).toBe(true);
    void af;
  });

  it("finds the ids past the search's 10,000-offset limit with date windows", async () => {
    const eg = json("met/egypt-obj.json");
    const one = { ...cfg, departments: [{ id: 10, geo_location: null, egypt: true }] };
    const { http, urls } = fake((u) => {
      if (!u.includes("/v1.1/search")) return eg;
      if (u.includes("dateBegin=-1500&dateEnd=-1000")) return { total: 1, objectIDs: [329767] };
      if (u.includes("dateBegin")) return { total: 0, objectIDs: null };
      return u.includes("offset=0&") || u.includes("offset=0") ? { total: 5, objectIDs: [1, 2] } : { total: 5, objectIDs: [] }; // total 5, but only 2 reachable
    });
    const cache = new JsonCache<MetCacheEntry>(null);
    cache.set("1", { day: Math.floor(Date.now() / 86_400_000), row: null, v: CLASS_VERSION });
    cache.set("2", { day: Math.floor(Date.now() / 86_400_000), row: null, v: CLASS_VERSION });
    await collect(new MetAdapter(one, profile, http, { cache }).buildIndex());
    expect(urls.filter((u) => u.includes("dateBegin")).length).toBeGreaterThan(5);
    expect(urls.filter((u) => u.includes("/objects/"))).toEqual([`${"https://collectionapi.metmuseum.org/public/collection"}/v1/objects/329767`]);
  });

  it("fetches a cached row again when it was classified by an older rule set", async () => {
    const eg = json("met/egypt-obj.json");
    const cache = new JsonCache<MetCacheEntry>(null);
    const day = Math.floor(Date.now() / 86_400_000);
    const row: IndexRow = { key: "met:329767", source: "met", sourceObjectId: "329767", objectClass: "other", regionGroup: "egypt", culture: null, score: 10 };
    cache.set("329767", { day, row, v: CLASS_VERSION - 1 });
    const { http, urls } = fake((u) => (u.includes("/v1.1/search") ? { total: 1, objectIDs: [329767] } : eg));
    await collect(new MetAdapter(cfg, profile, http, { cache }).buildIndex());
    expect(urls.filter((u) => u.includes("/objects/"))).toHaveLength(1);
    expect(cache.get("329767")?.v).toBe(CLASS_VERSION);
  });

  it("treats a 404 object as gone, caches that, and keeps going", async () => {
    const eg = json("met/egypt-obj.json");
    const cache = new JsonCache<MetCacheEntry>(null);
    const { http, urls } = fake((u) => {
      if (u.includes("/v1.1/search")) return { total: 2, objectIDs: [316484, 329767] };
      return u.endsWith("/316484") ? new Response("{}", { status: 404 }) : eg;
    });
    const rows = await collect(new MetAdapter(cfg, profile, http, { cache }).buildIndex());
    expect(rows.map((r) => r.key)).toEqual(["met:329767"]);
    expect(cache.get("316484")?.row).toBeNull();
    const again = fake((u) => (u.includes("/v1.1/search") ? { total: 2, objectIDs: [316484, 329767] } : eg));
    await collect(new MetAdapter(cfg, profile, again.http, { cache }).buildIndex());
    expect(again.urls.filter((u) => u.includes("/objects/"))).toHaveLength(0);
    void urls;
  });

  it("stops fetching at the per-run cap and says the index is incomplete", async () => {
    const eg = json("met/egypt-obj.json");
    const { http, urls } = fake((u) => (u.includes("/v1.1/search") ? { total: 5, objectIDs: [11, 12, 13, 14, 15] } : eg));
    const a = new MetAdapter({ ...cfg, max_new_per_run: 2 }, profile, http);
    await collect(a.buildIndex());
    expect(urls.filter((u) => u.includes("/objects/"))).toHaveLength(2);
    expect(a.incomplete).toBe(true);
  });

  it("stops, instead of retrying, when the WAF answers a JSON call with HTML", async () => {
    const { http } = fake(() => new Response("<html>Incapsula</html>", { headers: { "content-type": "text/html" } }));
    await expect(collect(new MetAdapter(cfg, profile, http).buildIndex())).rejects.toBeInstanceOf(StopCrawlError);
  });
});

describe("Cleveland", () => {
  const cfg = loadSourceConfig<ClevelandSourceConfig>("cleveland");

  it("Buffalo Mask (real record)", () => {
    const a = normaliseClevelandArtwork(json("cleveland/buffalo-mask.json"), profile, false);
    expect(a).toMatchObject({
      key: "cleveland:144495", accessionNumber: "1969.2", title: "Buffalo Mask", objectType: "Mask", objectClass: "mask",
      culture: "Burkina Faso, possibly Bwa-style maker", dateDisplay: "early to mid-1900s", dimensions: "Overall: 69.8 cm (27 1/2 in.)",
      creditLine: "Gift of Katherine C. White", onView: true, gallery: "Gallery 108A", rightsStatus: "open", imageLicense: "CC0",
      imageUrl: "https://openaccess-cdn.clevelandart.org/1969.2/1969.2_web.jpg", objectUrl: "https://clevelandart.org/art/1969.2",
      provenanceNote: "Katherine C. White [1929-1980], Gates Mills, OH, given to the Cleveland Museum of Art (at least 1968–1969)",
    });
    expect(a.description).toMatch(/^Among the Bwa people/);
  });

  it("a non-CC0 record is posted as reserved with the museum's wording, never as open", () => {
    const rec = { ...json("cleveland/buffalo-mask.json"), share_license_status: "Copyrighted" };
    expect(normaliseClevelandArtwork(rec, profile, false)).toMatchObject({ rightsStatus: "reserved", imageLicense: "Copyrighted" });
  });

  it("keeps Egyptian-department records only when the culture says Egypt/Nubia, not Near Eastern ones", () => {
    const terms = cfg.egypt_culture_terms;
    expect(cultureMatches(["Neo-Assyrian (911–609 BCE), Iraq, Nimrud"], terms)).toBe(false);
    expect(cultureMatches(["Egypt, New Kingdom (1540–1069 BCE), Dynasty 18"], terms)).toBe(true);
    expect(cultureMatches(["Nubia, Kerma"], terms)).toBe(true);
    expect(cultureMatches(undefined, terms)).toBe(false);
  });

  it("indexes the African department and only the Egyptian rows from the shared department", async () => {
    const img = { web: { url: "https://x/w.jpg", width: "800", height: "600" } };
    const { http, urls } = fake((u) => {
      if (u.includes("department=African+Art")) return { data: [{ id: 1, type: "Mask", title: "A", culture: ["Africa, Nigeria, Yoruba"], images: img }] };
      return {
        data: [
          { id: 2, type: "Sculpture", title: "B", culture: ["Neo-Assyrian, Iraq"], images: img },
          { id: 3, type: "Sculpture", title: "C", culture: ["Egypt, Dynasty 18"], images: img },
          { id: 4, type: "Sculpture", title: "D", culture: ["Egypt"], images: null },
        ],
      };
    });
    const rows = await collect(new ClevelandAdapter({ ...cfg, origin_departments: [] }, profile, http).buildIndex());
    expect(rows.map((r) => [r.key, r.regionGroup, r.objectClass])).toEqual([
      ["cleveland:1", "sub-saharan", "mask"],
      ["cleveland:3", "egypt", "sculpture"],
    ]);
    expect(urls.every((u) => u.includes("has_image=1"))).toBe(true);
  });

  it("origin departments keep only records whose culture is wholly African (owner 2026-10-09)", async () => {
    const img = { web: { url: "https://x/w.jpg", width: "800", height: "600" } };
    const rec = (id: number, culture: string[], type = "Textile") => ({ id, type, title: `T${id}`, culture, images: img });
    const { http } = fake((u) => {
      if (u.includes("department=Textiles"))
        return { data: [rec(10, ["Egypt, Byzantine period"]), rec(11, ["Egypt or Syria(?)"]), rec(12, ["Iran, Safavid"]), rec(13, ["Africa, West Africa, Ghana"])] };
      return { data: [] };
    });
    const rows = await collect(new ClevelandAdapter({ ...cfg, departments: [], egypt_departments: [], origin_departments: ["Textiles"] }, profile, http).buildIndex());
    expect(rows.map((r) => [r.key, r.regionGroup])).toEqual([["cleveland:10", "egypt"], ["cleveland:13", "sub-saharan"]]);
    const ok = normaliseClevelandArtwork({ ...json("cleveland/buffalo-mask.json"), culture: ["Egypt or Syria(?)"] }, profile, false, true);
    expect(ok.rightsStatus).toBe("blocked");
  });
});

describe("AIC", () => {
  const cfg = loadSourceConfig<AicSourceConfig>("aic");

  it("public-domain mask (real record): CC0 image, culture from style, 843 px IIIF url, AIC's own image description", () => {
    const a = normaliseAicArtwork(json("aic/181740.json").data, profile);
    expect(a).toMatchObject({
      key: "aic:181740", accessionNumber: "2003.174", objectClass: "mask", culture: "Chokwe", country: "Angola", regionGroup: "sub-saharan",
      rightsStatus: "open", imageLicense: "CC0", objectUrl: "https://www.artic.edu/artworks/181740",
    });
    expect(a.imageUrl).toBe(aicImageUrl("65010653-87cb-a15c-1803-bca5b6617a75"));
    expect(a.imageAlt).toMatch(/^A work made of wood/);
    expect(a.provenanceNote).not.toContain("[");
  });

  it("not public domain: still postable, as reserved, with the cut-off style tidied", () => {
    const a = normaliseAicArtwork(json("aic/99539.json").data, profile);
    expect(a).toMatchObject({ rightsStatus: "reserved", imageLicense: null, culture: "Kuba", objectClass: "mask" });
  });

  it("Egyptian objects filed under Thebes/dynasty are tagged egypt so the share cap applies", () => {
    expect(normaliseAicArtwork(json("aic/64339.json").data, profile).regionGroup).toBe("egypt");
  });

  it("walks the department by id range (AIC refuses deep paging) and sends the AIC-User-Agent header", async () => {
    const seen: Array<{ after: number; ua: string | undefined }> = [];
    const http = new HttpClient({
      minIntervalMs: 0, sleep: async () => {},
      fetchImpl: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const after = body.query.bool.filter[1].range.id.gt as number;
        seen.push({ after, ua: (init?.headers as Record<string, string>)["AIC-User-Agent"] });
        const mk = (id: number, image_id: string | null) => ({ id, artwork_type_title: "Mask", title: `M${id}`, place_of_origin: "Nigeria", image_id });
        const data = after === 0 ? Array.from({ length: 100 }, (_, i) => mk(i + 1, i === 0 ? null : "a")) : [mk(150, "b")];
        return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const rows = await collect(new AicAdapter(cfg, profile, http).buildIndex());
    expect(rows).toHaveLength(100); // 99 with an image on page 1, plus id 150
    expect(seen.map((s) => s.after)).toEqual([0, 100]);
    expect(seen[0]!.ua).toMatch(/africana-art-bot/);
  });
});

describe("Mia", () => {
  const cfg = loadSourceConfig<MiaSourceConfig>("mia");

  it("Sande mask (real record)", () => {
    const a = normaliseMiaRecord(json("mia/sande-mask-1937.json"), profile);
    expect(a).toMatchObject({
      key: "mia:1937", accessionNumber: "72.69.1", objectType: "Mask", objectClass: "mask", culture: "Mende", country: "Sierra Leone",
      regionGroup: "sub-saharan", rightsStatus: "open", imageLicense: "Public Domain", onView: true, gallery: "Gallery G254",
      imageUrl: "https://1.api.artsmia.org/800/1937.jpg", objectUrl: "https://collections.artsmia.org/art/1937",
    });
  });

  it("In Copyright / Unknown objects are reserved with Mia's own wording; no valid image means blocked", () => {
    const rec = json("mia/sande-mask-1937.json") as MiaRecord;
    expect(normaliseMiaRecord({ ...rec, rights_type: "In Copyright", room: "Not on View" }, profile)).toMatchObject({
      rightsStatus: "reserved", imageLicense: "In Copyright", onView: false, gallery: null,
    });
    expect(hasPublicImage({ ...rec, public_access: 0 })).toBe(false);
    expect(normaliseMiaRecord({ ...rec, image: "invalid" }, profile)).toMatchObject({ imageUrl: null, rightsStatus: "blocked" });
  });

  it("pages with from/size, keeps only records with a public image, and fails whole if a page fails (yesterday's index stays)", async () => {
    const rec = json("mia/sande-mask-1937.json");
    const { http, urls } = fake((u) => {
      const from = Number(new URL(u).searchParams.get("from"));
      const hits = from === 0 ? Array.from({ length: 100 }, (_, i) => ({ _source: { ...rec, id: 1000 + i } })) : [{ _source: { ...rec, id: 5, image: "invalid" } }, { _source: { ...rec, id: 6 } }];
      return { hits: { total: { value: 102 }, hits } };
    });
    const rows = await collect(new MiaAdapter(cfg, profile, http).buildIndex());
    expect(rows).toHaveLength(101);
    expect(rows.at(-1)?.key).toBe("mia:6");
    expect(urls[0]).toContain("continent%3AAfrica");

    const fast = new HttpClient({ minIntervalMs: 0, sleep: async () => {}, retryDelaysMs: [0, 0, 0], fetchImpl: (async (u: RequestInfo | URL) => (new URL(String(u)).searchParams.get("from") === "0" ? new Response(JSON.stringify({ hits: { total: { value: 200 }, hits: Array.from({ length: 100 }, () => ({ _source: rec })) } }), { headers: { "content-type": "application/json" } }) : new Response("boom", { status: 500 }))) as typeof fetch });
    await expect(collect(new MiaAdapter(cfg, profile, fast).buildIndex())).rejects.toThrow(/HTTP 500/);
  });
});

describe("denylist", () => {
  it("blocks the mummy and its coffin (record says mummified human remains), not an ordinary mask", () => {
    const mummy = normaliseAicArtwork(json("aic/64339.json").data, profile);
    expect(denyReason(mummy, deny)).toMatch(/mummy|human remains/i);
    expect(denyReason(normaliseClevelandArtwork(json("cleveland/buffalo-mask.json"), profile, false), deny)).toBeNull();
    expect(denyReason(normaliseMiaRecord(json("mia/sande-mask-1937.json"), profile), deny)).toBeNull();
  });

  it("matches the object type by whole token, so a mummy mask is not caught but a mummy is", () => {
    const base = normaliseMiaRecord(json("mia/sande-mask-1937.json"), profile);
    expect(denyReason({ ...base, objectType: "Mumienmaske" }, deny)).toBeNull();
    expect(denyReason({ ...base, objectType: "Mumie" }, deny)).toMatch(/object type/);
  });

  it("blocks modern materials in the medium or title (the 2007 Ijele mask: Kunststoff), not wood or cotton", () => {
    const base = normaliseMiaRecord(json("mia/sande-mask-1937.json"), profile);
    expect(denyReason({ ...base, medium: "Holz, Kunststoff, Baumwollstoffe (Patchwork)" }, deny)).toMatch(/Kunststoff/i);
    expect(denyReason({ ...base, medium: "Wood, Styrofoam, synthetic fabric" }, deny)).toMatch(/modern material/);
    expect(denyReason({ ...base, medium: "Bois, matière plastique" }, deny)).toMatch(/modern material/);
    expect(denyReason({ ...base, medium: "Holz, Baumwollstoffe (Patchwork), Raffia" }, deny)).toBeNull();
    expect(denyReason({ ...base, objectType: "Plastik", medium: "Holz", description: "plastic modelling of the face" }, deny)).toBeNull();
  });

  it("blocks an object dated entirely after 1956, but not on a BCE date, a century, or an earlier year in a range", () => {
    const base = normaliseMiaRecord(json("mia/sande-mask-1937.json"), profile);
    const dated = (dateDisplay: string | null) => denyReason({ ...base, dateDisplay }, deny);
    expect(dated("2007")).toBe("dated 2007, after 1956");
    expect(dated("ca. 1960s")).toMatch(/dated 1960/);
    expect(dated("1957")).toMatch(/dated 1957/);
    expect(dated("1956")).toBeNull();
    expect(dated("1900-1960")).toBeNull();
    expect(dated("19th century, collected 1980")).toBeNull();
    expect(dated("19. Jh., erworben 1980")).toBeNull();
    expect(dated("2050-1900 B.C.")).toBeNull();
    expect(dated("2100 BCE")).toBeNull();
    expect(dated("Dynasty 22")).toBeNull();
    expect(dated(null)).toBeNull();
  });

  it("honours manual key overrides", () => {
    const base = normaliseMiaRecord(json("mia/sande-mask-1937.json"), profile);
    expect(denyReason(base, { ...deny, blocked_keys: ["mia:1937"] })).toMatch(/manual override/);
  });
});

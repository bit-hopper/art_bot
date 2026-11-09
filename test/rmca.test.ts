import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { isObjectRecord, madeOutsideAfrica, normaliseRmca, parseListing, parseObjectPage, RmcaAdapter, titleOf, zoomifyBase, type RmcaSourceConfig } from "../src/adapters/rmca.js";
import { loadProfile, loadSourceConfig } from "../src/config.js";
import { HttpClient } from "../src/http.js";
import { downloadImage } from "../src/image.js";
import { isZoomifyUrl, parseZoomifyProps, pickLevel, stitchZoomify, tileUrl, zoomifyLevels } from "../src/zoomify.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/rmca");
const html = (f: string) => readFileSync(path.join(dir, f), "utf8");
const profile = loadProfile();
const cfg = loadSourceConfig<RmcaSourceConfig>("rmca");
const rules = { nonAfricanPlaces: cfg.non_african_places, objectInventoryPrefixes: cfg.object_inventory_prefixes };
const ZOOM ="https://webarch.africamuseum.be/collections-pictures/zoomify/TMS/EO/0000/EO.0.0.2101-1_DIA_01";

describe("rmca listing and object pages", () => {
  it("reads ten records from a results page, with place, culture and the full-size picture", () => {
    const { total, items } = parseListing(html("listing-5000.html"));
    expect(total).toBeGreaterThan(20000);
    expect(items).toHaveLength(10);
    const first = items[0]!;
    expect(first.objectId).toBe("34332");
    expect(first.imageUrl).toMatch(/\/collections-pictures\/zoomify\/.+[^g]$/);
    expect(first.fields["Object type"]).toBeTruthy();
    const nkisi = items.find((i) => i.objectId === "34336")!;
    expect(nkisi.fields).toMatchObject({ "Object type": "cult object > power object > ritual sculpture", Culture: "Luluwa", "Inventory number": "EO.0.0.39894" });
    expect(nkisi.imageUrl).toBe("https://webarch.africamuseum.be/collections-pictures/zoomify/nascollec001/Qweb/Pict-ordered/7603/AFM_1819_REP_7603/BESTAND_2/AFM_1819_REP_7603_029/AFM_1819_REP_7603_029_097_PHOTO");
  });

  it("skips groups of objects", () => {
    const { items } = parseListing(`<a href="display_group?languageid=3&amp;groupid=343&amp;order=0"><img src="x"/></a><i>Group</i>`);
    expect(items).toEqual([]);
  });

  it("normalises a Songye mask from its object page", () => {
    const p = parseObjectPage(html("object-29361.html"));
    expect(p.imageUrl).toBe(ZOOM);
    const a = normaliseRmca("29361", p.imageUrl, p.fields, profile, rules);
    expect(a).toMatchObject({
      key: "rmca:29361", source: "rmca", title: "Mask", objectClass: "mask", culture: "Songye", country: "Democratic Republic of the Congo",
      region: "Democratic Republic of the Congo > Kasaï", regionGroup: "sub-saharan", medium: "wood, feather, pigment, vegetal fibre",
      dimensions: "56,8 cm x 31 cm", accessionNumber: "EO.0.0.2101-1", rightsStatus: "attributed-nc", imageLicense: "CC BY-NC-SA 2.0 BE", dateDisplay: null,
      objectUrl: "https://webarch.africamuseum.be/collections/browsecollections/humansciences/display_object?objectid=29361",
    });
  });

  it("copes with a record that has no culture", () => {
    const p = parseObjectPage(html("object-34340.html"));
    const a = normaliseRmca("34340", p.imageUrl, p.fields, profile, rules);
    expect(a.culture).toBeNull();
    expect(a.country).toBeTruthy();
  });

  it("names the object after the last part of its type path", () => {
    expect(titleOf("cult object > power object > ritual sculpture")).toBe("Ritual sculpture");
    expect(titleOf(null)).toBeNull();
  });

  it("blocks a record with no picture and one collected outside Africa", () => {
    const f = { "Object type": "mask", "Inventory number": "EO.1.2", "Place of collecting": "Melanesia > Vanuatu" };
    expect(normaliseRmca("1", ZOOM, f, profile, rules).rightsStatus).toBe("blocked");
    expect(normaliseRmca("2", null, { "Object type": "mask", "Inventory number": "EO.1.2" }, profile, rules).rightsStatus).toBe("blocked");
    expect(normaliseRmca("3", ZOOM, { "Object type": "mask", "Inventory number": "EO.1.2", "Place of collecting": "Mali" }, profile, rules).rightsStatus).toBe("attributed-nc");
  });

  // Owner 2026-11-09: the photograph archives (portraits, colonial administration, body art) must never be posted. Real records from a random sample.
  it("blocks the museum's photograph archives and drawings, which have no object type, and keeps real objects", () => {
    const archive: Array<Record<string, string>> = [
      { Theme: "portrait", "Original owner": "Henry Morton Stanley (°1841 - †1904)", "Inventory number": "SA.5153-31" },
      { Theme: "headdress, body modifications, portrait", Photographer: "Armand Joseph Oscar Hutereau (°1875 - †1914)", "Inventory number": "AP.0.0.15323" },
      { Theme: "city life, family/family life", Photographer: "Joseph Makula", "Inventory number": "HP.1956.32.669" },
      { Theme: "events, political life", "Inventory number": "CP.2007.1.150" },
      { Theme: "headdress, body art", Photographer: "Auguste M. Bal", "Inventory number": "EP.0.0.4954" },
      { Producer: "Charles Callewaert (°1855 - †1945)", Technique: "graphic arts > mixed technique > pencil - aquarelle", "Inventory number": "HO.0.1.3112" },
    ];
    for (const f of archive) {
      expect(isObjectRecord(f, rules.objectInventoryPrefixes)).toBe(false);
      expect(normaliseRmca("9", ZOOM, f, profile, rules).rightsStatus).toBe("blocked");
    }
    // a typed record under an archive prefix is still refused, and so is a typed record with no inventory number
    expect(isObjectRecord({ "Object type": "photograph", "Inventory number": "HP.1.2" }, rules.objectInventoryPrefixes)).toBe(false);
    expect(isObjectRecord({ "Object type": "mask" }, rules.objectInventoryPrefixes)).toBe(false);
    for (const inv of ["EO.1967.63.626", "MO.1968.8.2", "HO.1955.9.20", "eo.0.0.1"]) {
      expect(isObjectRecord({ "Object type": "statuette", "Inventory number": inv }, rules.objectInventoryPrefixes)).toBe(true);
    }
  });

  it("matches place parts exactly, not as substrings", () => {
    expect(madeOutsideAfrica("Melanesia > Vanuatu", cfg.non_african_places)).toBe(true);
    expect(madeOutsideAfrica("Democratic Republic of the Congo > Kasaï", cfg.non_african_places)).toBe(false);
    expect(madeOutsideAfrica("Niger", ["Nigeria"])).toBe(false);
    expect(madeOutsideAfrica(null, cfg.non_african_places)).toBe(false);
  });

  it("turns a thumbnail address into the tile pyramid", () => {
    expect(zoomifyBase("https://h/collections-pictures/im_80/TMS/EO/0000/EO.0.0.1_DIA_01.jpg")).toBe("https://h/collections-pictures/zoomify/TMS/EO/0000/EO.0.0.1_DIA_01");
    expect(zoomifyBase("https://h/banners/x.jpg")).toBeNull();
  });

  it("pages through the listing and indexes only postable records", async () => {
    const page = html("listing-5000.html");
    const urls: string[] = [];
    const http = new HttpClient({
      minIntervalMs: 0, sleep: async () => {}, stopOnBlock: true,
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(urls.length === 1 ? page : page.replace(/<h3>\s*\d+\s+results/, "<h3>10 results"), { headers: { "content-type": "text/html" } });
      }) as typeof fetch,
    });
    const rows = [];
    for await (const r of new RmcaAdapter(cfg, profile, http).buildIndex()) rows.push(r);
    expect(urls[0]).toContain("b_start:int=0");
    expect(urls).toHaveLength(Math.ceil(parseListing(page).total! / 10));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === "rmca" && r.key === `rmca:${r.sourceObjectId}`)).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("zoomify", () => {
  it("lays out levels smallest first and numbers tiles level by level", () => {
    const levels = zoomifyLevels({ width: 1660, height: 2126, tileSize: 256 });
    expect(levels.map((l) => [l.width, l.height])).toEqual([[104, 133], [208, 266], [415, 532], [830, 1063], [1660, 2126]]);
    expect(levels[0]).toMatchObject({ level: 0, cols: 1, rows: 1, firstTile: 0 });
    const full = levels.at(-1)!;
    expect([full.width, full.height, full.cols, full.rows]).toEqual([1660, 2126, 7, 9]);
    // NUMTILES in the museum's ImageProperties.xml is 92 for this picture
    expect(full.firstTile + full.cols * full.rows).toBe(92);
    expect(tileUrl("B", full, 6, 8)).toBe(`B/TileGroup0/${full.level}-6-8.jpg`);
    expect(tileUrl("B", { ...full, firstTile: 300 }, 0, 0)).toBe(`B/TileGroup1/${full.level}-0-0.jpg`);
  });

  it("picks the largest level that fits, and recognises a tile base", () => {
    const levels = zoomifyLevels({ width: 4000, height: 3000, tileSize: 256 });
    const l = pickLevel(levels, 2400);
    expect(Math.max(l.width, l.height)).toBeLessThanOrEqual(2400);
    expect(Math.max(levels[l.level + 1]!.width, levels[l.level + 1]!.height)).toBeGreaterThan(2400);
    expect(isZoomifyUrl(ZOOM)).toBe(true);
    expect(isZoomifyUrl("https://h/zoomify/a/b.jpg")).toBe(false);
    expect(isZoomifyUrl("https://h/a/b.jpg")).toBe(false);
    expect(parseZoomifyProps('<IMAGE_PROPERTIES WIDTH="1660" HEIGHT="2126" NUMTILES="92" NUMIMAGES="1" VERSION="1.8" TILESIZE="256" />')).toEqual({ width: 1660, height: 2126, tileSize: 256 });
    expect(() => parseZoomifyProps("<nothing/>")).toThrow(/usable size/);
  });

  it("downloads the tiles and stitches them into one picture of the full size", async () => {
    const solid = (rgb: [number, number, number], w: number, h: number) =>
      sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg().toBuffer();
    // A 300x200 picture with 256 px tiles: level 0 is 150x100 (1 tile), level 1 is 300x200 (2x1 tiles).
    const tiles = new Map<string, Buffer>([
      [`${ZOOM}/TileGroup0/1-0-0.jpg`, await solid([255, 0, 0], 256, 200)],
      [`${ZOOM}/TileGroup0/1-1-0.jpg`, await solid([0, 0, 255], 44, 200)],
    ]);
    const seen: string[] = [];
    const http = new HttpClient({
      minIntervalMs: 0, sleep: async () => {},
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        if (url.endsWith("ImageProperties.xml")) return new Response('<IMAGE_PROPERTIES WIDTH="300" HEIGHT="200" NUMTILES="3" TILESIZE="256" />');
        const t = tiles.get(url);
        return t ? new Response(new Uint8Array(t), { headers: { "content-type": "image/jpeg" } }) : new Response("no", { status: 404 });
      }) as typeof fetch,
    });
    const out = await stitchZoomify(ZOOM, http);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([300, 200, "jpeg"]);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number) => [data[x * 3], data[x * 3 + 1], data[x * 3 + 2]];
    expect(px(10)![0]).toBeGreaterThan(200); // red tile on the left
    expect(px(290)![2]).toBeGreaterThan(200); // blue tile on the right
    // downloadImage routes a tile base to the stitcher
    expect((await sharp(await downloadImage(ZOOM, new HttpClient(), http)).metadata()).width).toBe(300);
    expect(seen.length).toBeGreaterThan(3);
  });

  it("fails the image when a tile is missing", async () => {
    const http = new HttpClient({
      minIntervalMs: 0, sleep: async () => {}, retryDelaysMs: [],
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).endsWith("ImageProperties.xml") ? new Response('<IMAGE_PROPERTIES WIDTH="300" HEIGHT="200" TILESIZE="256" />') : new Response("no", { status: 404 })) as typeof fetch,
    });
    await expect(stitchZoomify(ZOOM, http)).rejects.toThrow(/tile HTTP 404/);
  });
});

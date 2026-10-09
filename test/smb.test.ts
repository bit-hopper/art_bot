import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chooseImage,
  licenseRights,
  normaliseSmbRecord,
  parseObjectPage,
  regionGroupFromTerms,
  SmbAdapter,
} from "../src/adapters/smb.js";
import { loadProfile, loadSmbConfig } from "../src/config.js";
import { HttpClient } from "../src/http.js";
import { htmlToText } from "../src/text.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "smb");
const page = (id: string) => readFileSync(path.join(dir, `${id}.html`), "utf8");
const cfg = loadSmbConfig();
const profile = loadProfile();
const art = (id: string) => normaliseSmbRecord(parseObjectPage(page(id)), cfg, profile);

describe("SMB object page -> Artwork (real fixtures, fetched 2026-10-08)", () => {
  it("Nigerian mask: no title, falls back to object type; NC licence is postable as attributed-nc", () => {
    const a = art("obj-212185");
    expect(a.key).toBe("smb:212185");
    expect(a.accessionNumber).toBe("III C 44940");
    expect(a.title).toBe("Maske");
    expect(a.objectClass).toBe("mask");
    expect(a.country).toBe("Nigeria");
    expect(a.culture).toBe("Eket");
    expect(a.regionGroup).toBe("sub-saharan");
    expect(a.dateDisplay).toBe("20. Jahrhundert");
    expect(a.medium).toBe("Holz");
    expect(a.dimensions).toBe("Allgemein: 23,00 cm; Breite: 22,5 cm");
    expect(a.imageLicense).toBe("CC BY-NC-SA 4.0");
    expect(a.photographer).toBe("Claudia Obrocki");
    expect(a.rightsStatus).toBe("attributed-nc");
    expect(a.imageUrl).toBe("https://search.smb.museum/media/images/thumbs/extra_large/583/583705.jpg");
    expect(a.objectUrl).toBe("https://id.smb.museum/object/212185");
    expect(a.description).toContain("Ein scheibenflaches fast kreisrundes Gesicht");
    expect(a.description).not.toMatch(/[<>]|&lt;|&quot;/);
  });

  it("Egyptian mummy mask: has a title, egypt region group, CC BY-SA is attributed", () => {
    const a = art("obj-607423");
    expect(a.title).toBe("Mumienmaske einer Frau mit einem Haarkranz aus Rosenblüten");
    expect(a.department).toBe("Ägyptisches Museum und Papyrussammlung");
    expect(a.objectClass).toBe("mask");
    expect(a.regionGroup).toBe("egypt");
    expect(a.rightsStatus).toBe("attributed");
    expect(a.dateDisplay).toBe("1. Jh. n. Chr.");
  });

  it("record with acq_note and several images: provenance note from the record, front image chosen", () => {
    const a = art("obj-823198");
    expect(a.title).toBe("Tjiwara, Antilope");
    expect(a.country).toBe("Mali");
    expect(a.region).toBe("Ost-Bamana");
    expect(a.culture).toBe("Bambara (Bamanan)");
    expect(a.provenanceNote).toBe("Tausch von Museum für Völkerkunde zu Leipzig 1910");
    expect(a.photographer).toBe("Martin Franken"); // first image has no asset_content, i.e. the primary view
  });

  it("record whose image has no licence is blocked", () => {
    const a = art("obj-2041046");
    expect(a.rightsStatus).toBe("blocked");
    expect(a.imageUrl).toBeNull();
  });

  it("throws a clear error on a page without a payload", () => {
    expect(() => parseObjectPage("<html></html>")).toThrow(/__NUXT_DATA__/);
  });
});

describe("rights", () => {
  it.each([
    ["Public Domain Mark 1.0", "open"],
    ["CC0 1.0", "open"],
    ["CC BY-SA 4.0", "attributed"],
    ["CC BY-NC-SA 4.0", "attributed-nc"],
    ["CC BY-NC-ND 4.0", "attributed-nc"],
    ["All rights reserved", "blocked"],
    ["", "blocked"],
    [null, "blocked"],
    [undefined, "blocked"],
  ])("%s -> %s", (lic, expected) => {
    expect(licenseRights(lic as string | null | undefined, cfg)).toBe(expected);
  });

  it("chooseImage skips unlicensed images and prefers a front view", () => {
    const img = chooseImage(
      [
        { xl_path: "/a.jpg", license: null },
        { xl_path: "/b.jpg", license: "CC BY-NC-SA 4.0", asset_content: "Seitenansicht (rechts)" },
        { xl_path: "/c.jpg", license: "CC BY-NC-SA 4.0", asset_content: "Vorderseite" },
      ],
      cfg,
    );
    expect(img?.xl_path).toBe("/c.jpg");
  });

  it("chooseImage falls back to the first postable image, and to null when none is postable", () => {
    expect(chooseImage([{ xl_path: "/b.jpg", license: "CC BY-NC-SA 4.0", asset_content: "Rückseite" }], cfg)?.xl_path).toBe("/b.jpg");
    expect(chooseImage([{ xl_path: "/a.jpg", license: null }], cfg)).toBeNull();
    expect(chooseImage(undefined, cfg)).toBeNull();
  });
});

describe("htmlToText", () => {
  it("decodes SMB's double-escaped HTML", () => {
    expect(htmlToText("&lt;div&gt;Eins&lt;br&gt;&lt;/div&gt;&lt;div&gt;&quot;Zwei&quot;&nbsp;drei&lt;/div&gt;")).toBe('Eins "Zwei" drei');
  });
  it("returns null for empty input", () => {
    expect(htmlToText("")).toBeNull();
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText("&lt;div&gt;&lt;br&gt;&lt;/div&gt;")).toBeNull();
  });
});

describe("regionGroupFromTerms", () => {
  it.each([
    [["Afrika"], "unspecified-africa"],
    [["Afrika", "Mali"], "sub-saharan"],
    [["Tunesien"], "north-africa"],
    [["Ägypten", "Afrika"], "egypt"],
  ])("%j -> %s", (terms, expected) => {
    expect(regionGroupFromTerms(terms, cfg)).toBe(expected);
  });
});

describe("SmbAdapter.buildIndex", () => {
  /** Fake portal: each (org_unit, term) query returns its rows in pages of 2, to exercise paging. */
  function fakeFetch(db: Record<string, Array<{ id: string; objekttyp: string }>>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      const key = `${u.searchParams.get("org_units")}|${u.searchParams.get("geographicalReferences") ?? ""}`;
      const all = db[key] ?? [];
      const start = Number(u.searchParams.get("start") ?? 0);
      const artworks = all.slice(start, start + 2);
      return new Response(JSON.stringify({ artworks, total: all.length }), { status: 200 });
    }) as typeof fetch;
  }

  it("unions by id, drops zero-weight classes, assigns region groups and scores", async () => {
    const small = { ...cfg, org_units_africa: ["EM"], org_units_egypt: ["EG"], africa_terms: ["Afrika", "Mali", "Tunesien", "Ägypten"] };
    const db = {
      "EM|Afrika": [{ id: "obj-1", objekttyp: "Maske" }, { id: "obj-2", objekttyp: "Figur" }, { id: "obj-3", objekttyp: "Positiv, SW" }],
      "EM|Mali": [{ id: "obj-1", objekttyp: "Maske" }, { id: "obj-4", objekttyp: "Korb" }],
      "EM|Tunesien": [{ id: "obj-5", objekttyp: "Hocker" }],
      "EM|Ägypten": [{ id: "obj-6", objekttyp: "Statuette" }],
      "EG|": [{ id: "obj-7", objekttyp: "Mumienmaske" }, { id: "obj-6", objekttyp: "Statuette" }],
    };
    const http = new HttpClient({ fetchImpl: fakeFetch(db), sleep: async () => {}, retryDelaysMs: [] });
    const adapter = new SmbAdapter(small, profile, http);

    const rows = [];
    for await (const r of adapter.buildIndex()) rows.push(r);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    expect(rows).toHaveLength(6); // obj-3 (archive) dropped; obj-1 and obj-6 each appear once
    expect(byKey["smb:1"]).toMatchObject({ objectClass: "mask", regionGroup: "sub-saharan", score: 100 });
    expect(byKey["smb:2"]).toMatchObject({ objectClass: "sculpture", regionGroup: "unspecified-africa", score: 90 });
    expect(byKey["smb:3"]).toBeUndefined();
    expect(byKey["smb:4"]).toMatchObject({ objectClass: "other", regionGroup: "sub-saharan", score: 10 });
    expect(byKey["smb:5"]).toMatchObject({ objectClass: "other-carved-cast", regionGroup: "north-africa", score: 40 });
    expect(byKey["smb:6"]).toMatchObject({ objectClass: "sculpture", regionGroup: "egypt" });
    expect(byKey["smb:7"]).toMatchObject({ objectClass: "mask", regionGroup: "egypt", score: 100 });
  });
});

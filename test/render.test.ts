import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normaliseSmbRecord, parseObjectPage } from "../src/adapters/smb.js";
import { loadProfile, loadSmbConfig } from "../src/config.js";
import { LIMITS, measure, pickProvenanceNote, renderAlt, renderPost, renderRoot, renderReply, truncate, type Platform } from "../src/render.js";
import type { Artwork } from "../src/types.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "smb");
const smb = (id: string) => normaliseSmbRecord(parseObjectPage(readFileSync(path.join(dir, `${id}.html`), "utf8")), loadSmbConfig(), loadProfile());

const base: Artwork = {
  key: "cleveland:1969.2", source: "cleveland", sourceObjectId: "1969.2", accessionNumber: "1969.2",
  title: "Buffalo Mask", objectType: "Mask", objectClass: "mask", culture: "Burkina Faso, Bwa-style", country: null, region: null,
  regionGroup: "sub-saharan", dateDisplay: "early–mid 1900s", medium: "Wood, plant fibers, paint, and iron",
  dimensions: "Overall: 69.8 cm (27 1/2 in.)", department: "African Art", creditLine: "Gift of Katherine C. White, 1969.2",
  description: null, provenanceNote: null, onView: true, gallery: "Gallery 108A", imageUrl: "https://example.org/x.jpg",
  imageLicense: "CC0", photographer: null, rightsStatus: "open", objectUrl: "https://www.clevelandart.org/art/1969.2",
};

const platforms: Platform[] = ["bluesky", "threads"];

describe("render: the spec 6.4 Cleveland example", () => {
  it("root matches the template", () => {
    expect(renderRoot(base, "bluesky")).toBe(
      "Buffalo Mask\nBurkina Faso, Bwa-style · early–mid 1900s\nCleveland Museum of Art · Gallery 108A\n\n#AfricanaArt #Africana",
    );
  });
  it("reply carries accession, credit, licence and link", () => {
    expect(renderReply(base, "bluesky")).toBe(
      [
        "Mask · Wood, plant fibers, paint, and iron",
        "Overall: 69.8 cm (27 1/2 in.)",
        "Accession no. 1969.2",
        "Gift of Katherine C. White, 1969.2",
        "Image: CC0, Cleveland Museum of Art",
        "https://www.clevelandart.org/art/1969.2",
      ].join("\n"),
    );
  });
  it("omits the gallery when the object is not on view; Egyptian objects carry the same tags", () => {
    const r = renderRoot({ ...base, onView: false, regionGroup: "egypt" }, "bluesky");
    expect(r).not.toContain("Gallery");
    expect(r.endsWith("#AfricanaArt #Africana")).toBe(true);
  });
});

describe("render: SMB attribution", () => {
  const a = smb("obj-212185");
  it("names the photographer and licence, and says resized only when it was", () => {
    expect(renderReply(a, "bluesky")).toContain("Source: Staatliche Museen zu Berlin. Photo: Claudia Obrocki (CC BY-NC-SA 4.0)");
    expect(renderReply(a, "bluesky", { resized: true })).toContain("Source: Staatliche Museen zu Berlin. Photo: Claudia Obrocki (CC BY-NC-SA 4.0, resized)");
  });
  it("puts the department in front of the museum name", () => {
    expect(renderRoot(a, "bluesky")).toContain("Ethnologisches Museum, Staatliche Museen zu Berlin");
  });
});

describe("render: reserved objects state the museum's own wording and never invent a licence", () => {
  it("uses the record's wording", () => {
    const r = renderReply({ ...base, rightsStatus: "reserved", imageLicense: "In Copyright" }, "bluesky");
    expect(r).toContain("Rights: In Copyright, Cleveland Museum of Art");
    expect(r).not.toContain("CC0");
  });
  it("says there is no open licence when the record has none", () => {
    expect(renderReply({ ...base, rightsStatus: "reserved", imageLicense: null }, "bluesky")).toContain("Rights: no open licence,");
  });
});

describe("render: budget cut order (spec 6.2)", () => {
  const long = { ...base, description: "A".repeat(80) + " " + "word ".repeat(80), provenanceNote: "Acquired from a collector in 1969. More text follows." };
  const prov = pickProvenanceNote(long.provenanceNote, [])!;

  it("cuts the description first, keeping dimensions, medium and provenance", () => {
    const r = renderReply(long, "bluesky", { provenance: prov });
    expect(measure(r, "bluesky")).toBeLessThanOrEqual(300);
    expect(r).toContain("…");
    expect(r).toContain("Overall: 69.8 cm");
    expect(r).toContain("Provenance: Acquired from a collector in 1969.");
  });
  it("drops dimensions, then medium, before touching provenance", () => {
    const heavy = { ...long, creditLine: "C".repeat(95), accessionNumber: "ACC " + "1".repeat(20), provenanceNote: "P".repeat(60) };
    const p = pickProvenanceNote(heavy.provenanceNote, [])!;
    const r = renderReply(heavy, "bluesky", { provenance: p });
    expect(measure(r, "bluesky")).toBeLessThanOrEqual(300);
    expect(r).toContain("Provenance: " + "P".repeat(60));
    expect(r).not.toContain("Overall:");
  });
  it("never drops URL, accession or credit even when they alone are near the limit", () => {
    const crowded = { ...long, creditLine: "Gift of " + "X".repeat(150), objectUrl: "https://example.org/" + "u".repeat(60) };
    const r = renderReply(crowded, "bluesky", { provenance: prov });
    expect(measure(r, "bluesky")).toBeLessThanOrEqual(300);
    expect(r).toContain(crowded.objectUrl);
    expect(r).toContain("Accession no. 1969.2");
    expect(r).toContain("Gift of");
  });
});

describe("render: provenance note", () => {
  it("prefers the sentence with a flag term", () => {
    const n = pickProvenanceNote("Collected 1890. Taken in a punitive expedition in 1897. Sold 1920.", ["punitive expedition"]);
    expect(n).toEqual({ text: "Taken in a punitive expedition in 1897.", flagged: true });
  });
  it("matches German compounds", () => {
    expect(pickProvenanceNote("Erworben 1900. Kriegsbeute von 1897.", ["beute"])?.flagged).toBe(true);
  });
  it("falls back to the first sentence and returns null when empty", () => {
    expect(pickProvenanceNote("Bought in 1920. Then sold.", ["looted"])).toEqual({ text: "Bought in 1920.", flagged: false });
    expect(pickProvenanceNote("  ", [])).toBeNull();
  });
  it("does not split at a German century, an ordinal or an abbreviated month", () => {
    const smb = "19. Jh., Auftrag im Königreich Benin; in unbekanntem Besitz nach Feb. 1897; erworben von W.H. Himburg, 1902.";
    expect(pickProvenanceNote(smb, [])?.text).toBe(smb);
    expect(pickProvenanceNote("Erworben am 3. Mai 1900. Danach verkauft.", [])?.text).toBe("Erworben am 3. Mai 1900.");
    expect(pickProvenanceNote("Siehe Fig. 4 und Abb. 5 von 1910. Danach verkauft.", [])?.text).toBe("Siehe Fig. 4 und Abb. 5 von 1910.");
  });
});

describe("render: counting", () => {
  it("counts graphemes for Bluesky and emoji bytes for Threads", () => {
    expect(measure("👩‍👩‍👧‍👦", "bluesky")).toBe(1);
    expect(measure("👩‍👩‍👧‍👦", "threads")).toBe(25);
    expect(measure("é", "bluesky")).toBe(1);
  });
  it("truncates on a word boundary within the limit", () => {
    const t = truncate("The quick brown fox jumps over the lazy dog", 20, "bluesky");
    expect(measure(t, "bluesky")).toBeLessThanOrEqual(20);
    expect(t.endsWith("…")).toBe(true);
  });
  it("alt text is under the Threads cap and avoids repeating the type", () => {
    expect(renderAlt({ ...base, title: "Mask" })).toMatch(/^Mask\. /);
    expect(renderAlt({ ...base, description: "x ".repeat(2000) }).length).toBeLessThanOrEqual(1000);
  });
});

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("render: property test, no output over the limits", () => {
  const words = ["Maske", "Kopfaufsatz", "Häuptlingsstuhl", "Nationalmuseum", "masque", "ñandú", "😀", "👩‍👩‍👧‍👦", "🇳🇬", "Außergewöhnlich", "Zeremonialgewand", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
  const phrase = (r: () => number, n: number) =>
    Array.from({ length: Math.floor(r() * n) }, () => words[Math.floor(r() * words.length)]).join(" ");
  const maybe = (r: () => number, n: number) => (r() < 0.2 ? null : phrase(r, n) || "x");

  it("holds for 600 random artworks on both platforms", () => {
    const r = rng(42);
    for (let i = 0; i < 600; i++) {
      const a: Artwork = {
        ...base,
        title: maybe(r, 60), objectType: maybe(r, 5), culture: maybe(r, 12), country: maybe(r, 3), dateDisplay: maybe(r, 8),
        medium: maybe(r, 25), dimensions: maybe(r, 30), creditLine: maybe(r, 40), accessionNumber: maybe(r, 5),
        description: maybe(r, 150), provenanceNote: maybe(r, 120), gallery: maybe(r, 10), onView: r() < 0.5,
        department: maybe(r, 8), photographer: maybe(r, 10), imageLicense: maybe(r, 3),
        regionGroup: r() < 0.3 ? "egypt" : "sub-saharan",
        rightsStatus: (["open", "attributed", "attributed-nc", "reserved"] as const)[Math.floor(r() * 4)]!,
        source: Object.keys({ met: 1, cleveland: 1, aic: 1, mia: 1, smb: 1 })[Math.floor(r() * 5)]!,
        objectUrl: "https://example.org/" + "u".repeat(Math.floor(r() * 90)),
      };
      for (const p of platforms) {
        const post = renderPost(a, p, { resized: r() < 0.5, provenanceFlags: ["looted"] });
        expect(measure(post.root, p), `root ${i} ${p}`).toBeLessThanOrEqual(LIMITS[p]);
        expect(measure(post.reply, p), `reply ${i} ${p}`).toBeLessThanOrEqual(LIMITS[p]);
        expect(measure(post.alt, "threads")).toBeLessThanOrEqual(1000);
        expect(post.reply).toContain(a.objectUrl);
        expect(post.root).toContain("#AfricanaArt #Africana");
        if (a.accessionNumber) expect(post.reply).toContain("Accession no. ");
      }
    }
  }, 60_000);

  it("holds for the real SMB fixtures, including long German titles", () => {
    for (const id of ["obj-212185", "obj-2041046", "obj-607423", "obj-823198"]) {
      const a = { ...smb(id), title: "Kopfaufsatz in Form eines Büffels mit Zeremonialgewand und Federschmuck der Gesellschaft der Maskentänzer ".repeat(4) };
      for (const p of platforms) {
        const post = renderPost(a, p);
        expect(measure(post.root, p)).toBeLessThanOrEqual(LIMITS[p]);
        expect(measure(post.reply, p)).toBeLessThanOrEqual(LIMITS[p]);
      }
    }
  });
});

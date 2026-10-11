import { describe, expect, it } from "vitest";
import { measure, renderPost } from "../src/render.js";
import { translateArtwork } from "../src/translate.js";
import type { Artwork } from "../src/types.js";

const smb: Artwork = {
  key: "smb:1", source: "smb", sourceObjectId: "1", accessionNumber: "III C 1", title: "Menschliche Figur", objectType: "Plastik",
  objectClass: "sculpture", culture: null, country: "Nigeria", region: null, regionGroup: "sub-saharan", dateDisplay: null,
  medium: "Bronze", dimensions: null, department: "Ethnologisches Museum", creditLine: null, description: "[Benin_Königreich]",
  provenanceNote: "19. Jh., Auftrag im Königreich Benin.", onView: false, gallery: null, imageUrl: "https://example.org/x.jpg",
  imageLicense: "CC BY-NC-SA 4.0", photographer: "A. Photographer", rightsStatus: "attributed-nc", objectUrl: "https://id.smb.museum/object/1",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake DeepL: reports `used` characters, "translates" by upper-casing, and records the calls. */
function fakeDeepl(used = 0, translate: (texts: string[]) => Response = (t) => json({ translations: t.map((x) => ({ text: `EN(${x})` })) })) {
  const calls: Array<{ url: string; body: any; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("Authorization") });
    return url.endsWith("/usage") ? json({ character_count: used, character_limit: 500_000 }) : translate(JSON.parse(String(init!.body)).text);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const quiet = () => {};
const opts = (extra: object = {}) => ({ key: "k:fx", language: () => "de", log: quiet, ...extra });

describe("translate", () => {
  it("translates the four free-text fields in one call and leaves title, place and accession alone", async () => {
    const { fetchImpl, calls } = fakeDeepl();
    const t = await translateArtwork(smb, opts({ fetchImpl }));
    expect(t).toMatchObject({ objectType: "EN(Plastik)", medium: "EN(Bronze)", description: "EN([Benin_Königreich])", provenanceNote: "EN(19. Jh., Auftrag im Königreich Benin.)", translated: true });
    expect(t).toMatchObject({ title: "Menschliche Figur", country: "Nigeria", accessionNumber: "III C 1", creditLine: null });
    const post = calls.find((c) => c.url.endsWith("/translate"))!;
    expect(post.url).toBe("https://api-free.deepl.com/v2/translate");
    expect(post.auth).toBe("DeepL-Auth-Key k:fx");
    expect(post.body).toMatchObject({ source_lang: "DE", target_lang: "EN-US" });
    expect(post.body.text).toHaveLength(4);
  });

  it("sends nothing for an English source, a missing key, or a record with no free text", async () => {
    const { fetchImpl, calls } = fakeDeepl();
    expect(await translateArtwork(smb, opts({ fetchImpl, language: () => undefined }))).toBe(smb);
    expect(await translateArtwork(smb, opts({ fetchImpl, language: () => "en" }))).toBe(smb);
    expect(await translateArtwork(smb, { language: () => "de", fetchImpl, log: quiet, key: "" })).toBe(smb);
    const bare = { ...smb, objectType: null, medium: " ", description: null, provenanceNote: null };
    expect(await translateArtwork(bare, opts({ fetchImpl }))).toBe(bare);
    expect(calls).toHaveLength(0);
  });

  it("posts the original once the monthly cap would be passed", async () => {
    const { fetchImpl, calls } = fakeDeepl(449_990);
    expect(await translateArtwork(smb, opts({ fetchImpl }))).toBe(smb);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["usage"]);
  });

  it("posts the original when the usage call, the translation or the reply shape fails", async () => {
    const down = (async () => new Response("no", { status: 456 })) as unknown as typeof fetch;
    expect(await translateArtwork(smb, opts({ fetchImpl: down }))).toBe(smb);
    expect(await translateArtwork(smb, opts({ fetchImpl: fakeDeepl(0, () => json({}, 500)).fetchImpl }))).toBe(smb);
    expect(await translateArtwork(smb, opts({ fetchImpl: fakeDeepl(0, () => json({ translations: [{ text: "x" }] })).fetchImpl }))).toBe(smb);
    const boom = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await translateArtwork(smb, opts({ fetchImpl: boom }))).toBe(smb);
  });

  it("uses the paid host for a key without the :fx suffix", async () => {
    const { fetchImpl, calls } = fakeDeepl();
    await translateArtwork(smb, opts({ fetchImpl, key: "paid" }));
    expect(calls[0]!.url).toBe("https://api.deepl.com/v2/usage");
  });
});

describe("translated posts", () => {
  it("flags the reply as machine translation and still fits both platforms", async () => {
    const long = { ...smb, description: "Lange Beschreibung. ".repeat(40) };
    const t = await translateArtwork(long, opts({ fetchImpl: fakeDeepl(0, (x) => json({ translations: x.map((s) => ({ text: s })) })).fetchImpl }));
    for (const p of ["bluesky", "threads"] as const) {
      const r = renderPost(t, p, {}).reply;
      expect(r).toContain("[machine translation]");
      expect(measure(r, p)).toBeLessThanOrEqual(p === "bluesky" ? 300 : 500);
      expect(r.endsWith(t.objectUrl)).toBe(true);
    }
    expect(renderPost(smb, "bluesky", {}).reply).not.toContain("machine translation");
  });
});

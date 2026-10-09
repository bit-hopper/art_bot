import { randomBytes } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { downloadImage, prepareImage, BLUESKY_MAX_BYTES } from "../src/image.js";
import { HttpClient } from "../src/http.js";
import { publish, type BlueskyAgent } from "../src/publishers/bluesky.js";
import type { PreparedImage } from "../src/image.js";

async function jpeg(w: number, h: number, noisy: boolean, extra?: (s: Sharp) => Sharp): Promise<Uint8Array> {
  const raw = noisy ? randomBytes(w * h * 3) : Buffer.alloc(w * h * 3, 200);
  const s = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  return new Uint8Array(await (extra ? extra(s) : s).jpeg({ quality: 95 }).toBuffer());
}

describe("prepareImage", () => {
  it("leaves a file that already fits exactly as the museum sent it", async () => {
    const small = await jpeg(400, 300, false);
    const out = await prepareImage(small);
    expect(out.resized).toBe(false);
    expect(out.bytes).toBe(small);
    expect(out).toMatchObject({ mime: "image/jpeg", width: 400, height: 300 });
  });

  it("re-encodes an oversize file under the limit without upscaling or cropping", async () => {
    const big = await jpeg(2400, 3000, true);
    expect(big.length).toBeGreaterThan(BLUESKY_MAX_BYTES);
    const out = await prepareImage(big);
    expect(out.resized).toBe(true);
    expect(out.bytes.length).toBeLessThanOrEqual(1_900_000);
    expect(out.mime).toBe("image/jpeg");
    expect(out.width).toBeLessThanOrEqual(2400);
    expect(Math.abs(out.width / out.height - 2400 / 3000)).toBeLessThan(0.01);
    expect(out.originalBytes).toBe(big.length);
  }, 60_000);

  it("rejects bytes that are not an image", async () => {
    await expect(prepareImage(new TextEncoder().encode("<br /><b>Warning</b>: mkdir() Permission denied"))).rejects.toThrow(/unsupported image format/);
  });
});

describe("downloadImage", () => {
  const client = (res: Response) => new HttpClient({ sleep: async () => {}, fetchImpl: (async () => res) as typeof fetch });
  it("fails on a non-image answer and on an error status", async () => {
    await expect(downloadImage("https://x/i.jpg", client(new Response("<xml/>", { headers: { "content-type": "application/xml" } })))).rejects.toThrow(/application\/xml/);
    await expect(downloadImage("https://x/i.jpg", client(new Response("no", { status: 404 })))).rejects.toThrow(/HTTP 404/);
  });
});

function agent(failReply = false) {
  const calls = { upload: [] as unknown[], posts: [] as Array<Record<string, any>> };
  const a = {
    uploadBlob: async (bytes: Uint8Array, o: unknown) => (calls.upload.push([bytes.length, o]), { success: true, headers: {}, data: { blob: { $type: "blob", ref: "BLOB", mimeType: "image/jpeg", size: 3 } } }),
    post: async (rec: Record<string, any>) => {
      if (failReply && rec.reply) throw new Error("rate limited");
      calls.posts.push(rec);
      return { uri: `at://did:plc:x/app.bsky.feed.post/${calls.posts.length}`, cid: `cid${calls.posts.length}` };
    },
    resolveHandle: async () => ({ data: { did: "did:plc:y" } }),
  };
  return { agent: a as unknown as BlueskyAgent, calls };
}

const image: PreparedImage = { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg", width: 800, height: 600, resized: false, originalBytes: 3 };

describe("Bluesky publisher", () => {
  const post = { rootText: "Buffalo Mask\nCleveland Museum of Art\n\n#AfricanaArt #Africana", replyText: "Accession no. 1969.2\nhttps://clevelandart.org/art/1969.2", alt: "A buffalo mask.", image };

  it("posts the image with alt text and aspect ratio, then one reply threaded under the root", async () => {
    const { agent: a, calls } = agent();
    const r = await publish(a, post);
    expect(calls.upload).toEqual([[3, { encoding: "image/jpeg" }]]);
    const [root, reply] = calls.posts;
    expect(root).toMatchObject({ langs: ["en"], embed: { $type: "app.bsky.embed.images", images: [{ alt: "A buffalo mask.", aspectRatio: { width: 800, height: 600 } }] } });
    expect(reply).toMatchObject({ langs: ["en"], reply: { root: { uri: r.root.uri, cid: r.root.cid }, parent: { uri: r.root.uri, cid: r.root.cid } } });
    expect(r.reply?.uri).toContain("/2");
  });

  it("adds tag facets to the root and a link facet to the reply", async () => {
    const { agent: a, calls } = agent();
    await publish(a, post);
    const features = (rec: Record<string, any>) => (rec.facets ?? []).flatMap((f: any) => f.features.map((x: any) => x.$type));
    expect(features(calls.posts[0]!)).toEqual(["app.bsky.richtext.facet#tag", "app.bsky.richtext.facet#tag"]);
    expect(features(calls.posts[1]!)).toEqual(["app.bsky.richtext.facet#link"]);
  });

  it("returns, rather than throws, when only the reply fails, so the root is not lost", async () => {
    const { agent: a } = agent(true);
    const r = await publish(a, post);
    expect(r.reply).toBeNull();
    expect(r.replyError).toBe("rate limited");
    expect(r.root.uri).toContain("/1");
  });

  it("refuses text over 300 graphemes before uploading or posting anything", async () => {
    const { agent: a, calls } = agent();
    await expect(publish(a, { ...post, replyText: "x".repeat(301) })).rejects.toThrow(/301 graphemes/);
    expect(calls.upload).toHaveLength(0);
    expect(calls.posts).toHaveLength(0);
  });
});

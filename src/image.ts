import sharp from "sharp";
import { DEFAULT_USER_AGENT, type HttpClient } from "./http.js";

/** Bluesky's blob limit (lexicon `maxSize`, M0 2026-10-08). Resize only above it (spec 6.6). */
export const BLUESKY_MAX_BYTES = 2_000_000;
/** Aim a little under the limit when re-encoding, so the live smoke test has margin. */
const TARGET_BYTES = 1_900_000;
const LONG_EDGES = [2400, 2000, 1600, 1280, 1000];
const QUALITIES = [88, 80, 72, 64, 56];

export interface PreparedImage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  /** True only when we re-encoded or shrank the museum's file. Drives the "resized" credit (spec 6.6). */
  resized: boolean;
  originalBytes: number;
}

/** artic.edu sits behind a Cloudflare challenge that only lets identified clients through, via `AIC-User-Agent`. */
function hostHeaders(url: string): Record<string, string> {
  return new URL(url).hostname.endsWith("artic.edu") ? { "AIC-User-Agent": process.env.BOT_USER_AGENT ?? DEFAULT_USER_AGENT } : {};
}

export async function downloadImage(url: string, http: HttpClient): Promise<Uint8Array> {
  const res = await http.get(url, { Accept: "image/*", ...hostHeaders(url) });
  if (!res.ok) throw new Error(`image HTTP ${res.status} from ${url}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/^image\//i.test(type)) throw new Error(`image URL returned ${type}: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Spec 6.6: the museum's own web-size file is posted untouched when it fits. Otherwise re-encode as JPEG, shrinking the
 * long edge and lowering quality in steps until it fits. Never upscale, crop, or alter colours; EXIF orientation is
 * applied so the picture looks the same.
 */
export async function prepareImage(input: Uint8Array): Promise<PreparedImage> {
  const meta = await sharp(input).metadata();
  const mime = meta.format === "png" ? "image/png" : meta.format === "jpeg" ? "image/jpeg" : null;
  const [w, h] = [meta.width ?? 0, meta.height ?? 0];
  if (mime && input.length <= BLUESKY_MAX_BYTES && !(meta.orientation && meta.orientation > 1)) {
    return { bytes: input, mime, width: w, height: h, resized: false, originalBytes: input.length };
  }

  const long = Math.max(w, h);
  const edges = [long, ...LONG_EDGES.filter((e) => e < long), 800, 600].filter((e, i, a) => e <= long && a.indexOf(e) === i);
  let last: { bytes: Uint8Array; width: number; height: number } | undefined;
  for (const edge of edges) {
    for (const quality of QUALITIES) {
      const { data, info } = await sharp(input)
        .rotate()
        .resize({ width: w >= h ? edge : undefined, height: h > w ? edge : undefined, withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      last = { bytes: new Uint8Array(data), width: info.width, height: info.height };
      if (data.length <= TARGET_BYTES) return { ...last, mime: "image/jpeg", resized: true, originalBytes: input.length };
    }
  }
  throw new Error(`could not fit image under ${TARGET_BYTES} bytes (smallest attempt ${last?.bytes.length})`);
}

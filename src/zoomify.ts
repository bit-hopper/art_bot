import sharp from "sharp";
import { HttpClient } from "./http.js";
import { mapLimit } from "./adapters/common.js";

/**
 * Zoomify image pyramids (RMCA): the museum's 400 px file is a thumbnail, the full picture only exists as 256 px tiles under
 * `<base>/TileGroupN/<level>-<x>-<y>.jpg`, described by `<base>/ImageProperties.xml`. Levels run from one tile (0) to the full
 * size, each half the size of the next; tiles are numbered level by level, row by row, and 256 of them share a TileGroup.
 */

/** A Zoomify base URL: the path holds `/zoomify/` and has no file extension. */
export const isZoomifyUrl = (url: string) => /\/zoomify\//.test(url) && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url);

export interface ZoomifyProps {
  width: number;
  height: number;
  tileSize: number;
}

export function parseZoomifyProps(xml: string): ZoomifyProps {
  const num = (name: string) => Number(new RegExp(`${name}="(\\d+)"`, "i").exec(xml)?.[1]);
  const p = { width: num("WIDTH"), height: num("HEIGHT"), tileSize: num("TILESIZE") };
  if (!(p.width > 0 && p.height > 0 && p.tileSize > 0)) throw new Error("Zoomify ImageProperties.xml has no usable size");
  return p;
}

export interface ZoomifyLevel {
  level: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** Index of this level's first tile among all tiles, smallest level first. */
  firstTile: number;
}

/** Every level, smallest first, with each one's tile grid and where its tiles start in the numbering. */
export function zoomifyLevels(p: ZoomifyProps): ZoomifyLevel[] {
  const sizes: Array<[number, number]> = [[p.width, p.height]];
  for (let [w, h] = sizes[0]!; w > p.tileSize || h > p.tileSize; ) {
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    sizes.push([w, h]);
  }
  sizes.reverse();
  let first = 0;
  return sizes.map(([width, height], level) => {
    const cols = Math.ceil(width / p.tileSize);
    const rows = Math.ceil(height / p.tileSize);
    const l = { level, width, height, cols, rows, firstTile: first };
    first += cols * rows;
    return l;
  });
}

/** The largest level whose long edge is at most `maxEdge` (the full image when it fits). */
export function pickLevel(levels: ZoomifyLevel[], maxEdge: number): ZoomifyLevel {
  return [...levels].reverse().find((l) => Math.max(l.width, l.height) <= maxEdge) ?? levels[0]!;
}

export const tileUrl = (base: string, l: ZoomifyLevel, x: number, y: number) =>
  `${base}/TileGroup${Math.floor((l.firstTile + y * l.cols + x) / 256)}/${l.level}-${x}-${y}.jpg`;

/** Downloads the tiles of the largest level up to `maxEdge` and joins them into one JPEG. Any missing tile fails the whole image. */
export async function stitchZoomify(base: string, http: HttpClient, maxEdge = 2400): Promise<Uint8Array> {
  const props = parseZoomifyProps(await http.getText(`${base}/ImageProperties.xml`));
  const lvl = pickLevel(zoomifyLevels(props), maxEdge);
  const cells = Array.from({ length: lvl.rows }, (_, y) => Array.from({ length: lvl.cols }, (_, x) => ({ x, y }))).flat();
  const tiles = await mapLimit(cells, 4, async ({ x, y }) => {
    const url = tileUrl(base, lvl, x, y);
    const res = await http.get(url, { Accept: "image/*" });
    if (!res.ok) throw new Error(`Zoomify tile HTTP ${res.status} from ${url}`);
    return { input: Buffer.from(await res.arrayBuffer()), left: x * props.tileSize, top: y * props.tileSize };
  });
  return new Uint8Array(
    await sharp({ create: { width: lvl.width, height: lvl.height, channels: 3, background: "#ffffff" } })
      .composite(tiles)
      .jpeg({ quality: 92 })
      .toBuffer(),
  );
}

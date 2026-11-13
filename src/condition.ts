/**
 * Owner rule 2026-11-05: no corroded or encrusted objects, and as few dull catalogue pictures as possible (rough fragments, archive
 * scans, objects shot beside a ruler or a colour chart). Records seldom say so (the Louvre's Osiris bronze has no description at
 * all), so the picture is scored by a small open CLIP model that runs on the runner: no API key, no per-call cost. The "poor"
 * prompts compete with several clean-object prompts, because against a single rival almost every museum photo reads as dirty.
 * Calibrated on the 582 posted images (2026-11-05): 0.6 flags 10% of them (SMB 16%, Louvre 8%, Met 9%, the other museums none);
 * ranks 1-58 were read by hand and were catalogue shots, fragments, sherds, ostraca and the encrusted bronzes. Unlike the people
 * check this one fails open: a model that cannot load lets the post through.
 */
import type { PreparedImage } from "./image.js";

const MODEL = "Xenova/clip-vit-base-patch32";
const POOR = [
  "a heavily corroded, encrusted, dirt-covered lump of metal",
  "an object photographed next to a ruler or a colour calibration chart",
  "a black-and-white archival photograph or a handwritten catalogue card",
  "a rough broken fragment of stone or clay",
];
const GOOD = [
  "a well-preserved decorated ancient sculpture",
  "a clean ancient pottery vessel",
  "a carved wooden figure or mask",
  "a polished stone statue or relief",
  "a clean bronze, gold or ivory artifact",
  "a small amulet, bead or jewellery",
  "a museum photograph of a beautiful artwork on a plain background",
];
const LABELS = [...POOR, ...GOOD];

/** Combined probability of the four "poor" labels among all of them, 0 to 1. */
export type CorrosionScorer = (img: PreparedImage) => Promise<number>;

let loaded: Promise<(img: unknown, labels: string[]) => Promise<Array<{ label: string; score: number }>>> | null = null;

/** Loads the model on first use (downloaded once from the Hugging Face hub, cached between runs by the workflow). */
const clip: CorrosionScorer = async (img) => {
  const { pipeline, RawImage } = await import("@huggingface/transformers");
  loaded ??= pipeline("zero-shot-image-classification", MODEL) as unknown as NonNullable<typeof loaded>;
  const classify = await loaded;
  const raw = await RawImage.fromBlob(new Blob([img.bytes as BlobPart], { type: img.mime }));
  const out = await classify(raw, LABELS);
  return out.filter((o) => POOR.includes(o.label)).reduce((sum, o) => sum + o.score, 0);
};

/**
 * Owner 2026-11-12: smb:223559 (a Bafo "menschlicher Kopf" with real hair, inset teeth and a skin-like face) "looks like a corpse"
 * and "a jumpscare". Same model, a second label set: the SCARY prompts against calm rivals. Calibrated on that one image and the
 * bot's last 50 posts: it scored 0.10 against 0.07 for a scarab and 0.04 for a face mask, and the other 46 scored under 0.01.
 * Very little data, so expect to tune it. Always fails open. A fourth "mummified corpse" prompt was tried and dropped: it scored a
 * sculptor's model statue at 0.23 and a plain figure at 0.12.
 */
const SCARY = [
  "a creepy, unsettling, realistic human face with bared teeth, like a horror movie prop",
  "a frightening shrunken head or severed head",
  "a scary, uncanny, nightmarish face",
];
const CALM = [
  "a well-preserved decorated ancient sculpture",
  "a clean ancient pottery vessel",
  "a carved wooden figure or mask",
  "a polished stone statue or relief",
  "a clean bronze, gold or ivory artifact",
  "a serene, dignified, beautiful sculpture of a head",
  "a museum photograph of a beautiful artwork on a plain background",
];
export const UNCANNY_LABELS = [...SCARY, ...CALM];

/** Combined probability of the SCARY labels among all of them, 0 to 1. */
export type UncannyScorer = (img: PreparedImage) => Promise<number>;

let loadedUncanny: Promise<(img: unknown, labels: string[]) => Promise<Array<{ label: string; score: number }>>> | null = null;

const clipUncanny: UncannyScorer = async (img) => {
  const { pipeline, RawImage } = await import("@huggingface/transformers");
  loadedUncanny ??= pipeline("zero-shot-image-classification", MODEL) as unknown as NonNullable<typeof loaded>;
  const classify = await loadedUncanny;
  const raw = await RawImage.fromBlob(new Blob([img.bytes as BlobPart], { type: img.mime }));
  const out = await classify(raw, UNCANNY_LABELS);
  return out.filter((o) => SCARY.includes(o.label)).reduce((sum, o) => sum + o.score, 0);
};

/** The reason to reject an image that looks like a corpse or a horror prop, or null. A model failure is reported and the image passes. */
export async function uncannyReason(img: PreparedImage, threshold: number | undefined, score: UncannyScorer = clipUncanny, opts: Pick<ConditionOptions, "onError"> = {}): Promise<string | null> {
  if (!threshold) return null;
  try {
    const s = await score(img);
    return s >= threshold ? `image looks uncanny, like a corpse or a horror prop (score ${s.toFixed(2)})` : null;
  } catch (e) {
    loadedUncanny = null;
    opts.onError?.(e);
    return null;
  }
}

export interface ConditionOptions {
  /** Refuse the image when the model cannot run, instead of letting it through (owner 2026-11-06). */
  failClosed?: boolean;
  /** Called with the error whenever the model fails, so a silent fail-open shows up in the run log. */
  onError?: (e: unknown) => void;
}

/**
 * The reason to reject an image that looks corroded, fragmentary or like a dull catalogue shot, or null. When the model fails the
 * error is reported to `onError`; the image then passes (fail open) unless `failClosed`, which refuses it.
 */
export async function conditionReason(img: PreparedImage, threshold: number | undefined, score: CorrosionScorer = clip, opts: ConditionOptions = {}): Promise<string | null> {
  if (!threshold) return null;
  try {
    const s = await score(img);
    return s >= threshold ? `image looks corroded, fragmentary or like a catalogue shot (score ${s.toFixed(2)})` : null;
  } catch (e) {
    loaded = null;
    opts.onError?.(e);
    return opts.failClosed ? `image not checked for condition (${e instanceof Error ? e.message : e})` : null;
  }
}

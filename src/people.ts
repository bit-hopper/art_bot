/**
 * Owner rule 2026-10-14: a photograph of an object may be posted, a photograph with a real person in it never. Museum metadata
 * cannot say who is in a picture, so a record whose type or medium names a photograph goes through a small open object detector
 * (YOLOS-tiny, COCO "person" class) that runs on the runner itself: no API key, no per-call cost. The check fails closed: a model
 * that cannot load or run keeps the photograph out.
 */
import type { Denylist } from "./config.js";
import { matchesTerms } from "./classify.js";
import type { PreparedImage } from "./image.js";
import type { Artwork } from "./types.js";

const MODEL = "Xenova/yolos-tiny";
/** Low on purpose: a missed person is worse than a skipped photograph of an object. */
const PERSON_THRESHOLD = 0.3;

export interface Detection { label: string; score: number }
export type Detector = (img: PreparedImage) => Promise<Detection[]>;

/** True when the museum's own type or medium wording says the record is a photograph (`photograph_terms` in denylist.yaml). */
export function isPhotograph(a: Artwork, deny: Denylist): boolean {
  const text = [a.objectType, a.medium].filter(Boolean).join(" \n ");
  return (deny.photograph_terms ?? []).some((t) => matchesTerms(text, [t]));
}

let loaded: Promise<(img: unknown, opts?: unknown) => Promise<Detection[]>> | null = null;

/** Loads the model on first use (downloaded once from the Hugging Face hub), so runs that post no photograph never pay for it. */
const yolos: Detector = async (img) => {
  const { pipeline, RawImage } = await import("@huggingface/transformers");
  loaded ??= pipeline("object-detection", MODEL) as unknown as Promise<(i: unknown, o?: unknown) => Promise<Detection[]>>;
  const detect = await loaded;
  const raw = await RawImage.fromBlob(new Blob([img.bytes as BlobPart], { type: img.mime }));
  return detect(raw, { threshold: 0.1 });
};

/** The reason to reject a photograph, or null when no person was detected in it. */
export async function photographPeopleReason(img: PreparedImage, detect: Detector = yolos): Promise<string | null> {
  try {
    const person = (await detect(img)).find((d) => d.label === "person" && d.score >= PERSON_THRESHOLD);
    return person ? `photograph shows a real person (detector score ${person.score.toFixed(2)})` : null;
  } catch (e) {
    loaded = null;
    return `photograph not checked for people (${e instanceof Error ? e.message : e})`;
  }
}

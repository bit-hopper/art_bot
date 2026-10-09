import { classify } from "../classify.js";
import type { FilterProfile } from "../config.js";
import type { ObjectClass, RegionGroup } from "../types.js";

const NORTH_AFRICA = /\b(morocco|algeria|tunisia|libya|western sahara|maghreb|north africa|north african|carthage|carthaginian|cyrenaica|numidia|mauretania)\b/i;
// AIC and others give a city or a dynasty instead of "Egypt" ("Thebes", "twenty-second dynasty").
const EGYPT = /\b(egypt|egyptian|thebes|luxor|karnak|saqqara|giza|abydos|amarna|fayum|dynasty|ptolemaic|pharaonic|predynastic|coptic|alexandria|byzantine egypt|cairo|fostat|fustat|memphis|tanis|meir|akhmim)\b/i;

/** Region group from the museum's own place wording (spec 4). `egyptDept` forces `egypt` for Egyptian departments. */
export function regionGroupFromPlace(place: string | null | undefined, opts: { egyptDept?: boolean } = {}): RegionGroup {
  if (opts.egyptDept) return "egypt";
  const p = place ?? "";
  if (EGYPT.test(p)) return "egypt";
  if (NORTH_AFRICA.test(p)) return "north-africa";
  return p.trim() ? "sub-saharan" : "unspecified-africa";
}

/** Structured object type first (spec 4.1); a title that says "mask" rescues a generically typed object. */
export function classifyRecord(type: string | null | undefined, title: string | null | undefined, profile: FilterProfile, fallback?: string | null): ObjectClass {
  let cls = classify(type, profile);
  if (cls === "other" && fallback) cls = classify(fallback, profile);
  if (cls === "other" && classify(title, profile) === "mask") cls = "mask";
  return cls;
}

/** Spec 4.2: class weight x 0.5 if the image's long edge is under 600 px, x 1.2 for a museum highlight. */
export function scoreFor(weight: number, q: { longEdge?: number | null; highlight?: boolean } = {}): number {
  let s = weight;
  if (q.longEdge != null && q.longEdge < 600) s *= 0.5;
  if (q.highlight) s *= 1.2;
  return s;
}

/** Runs `fn` over `items` with at most `n` in flight; results come back in input order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

export function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
}

const AFRICAN_PLACE =
  /\b(egypt|egyptian|coptic|nubia|kush|meroitic|alexandria|ethiopia|ethiopian|eritrea|sudan|libya|tunisia|algeria|morocco|maghreb|north africa|north african|carthage|carthaginian|cyrenaica|numidia|mauretania|berber|africa|african)\b/i;

/**
 * Owner ruling 2026-10-08: origin decides, not travel. An object made in Africa stays African whoever ruled the place or
 * wherever it later went (Ptolemaic, Roman, Byzantine, Coptic, Islamic-period Egypt; Carthage; the Maghreb). A field
 * qualifies when every alternative the museum names is African: "Egypt", "probably Morocco" pass, "Egypt or Syria (?)" and
 * "Egyptian or Levantine" do not (origin not established). Any one qualifying field is enough.
 */
export function africanOrigin(...fields: Array<string | null | undefined>): boolean {
  return fields.some((f) => {
    const pieces = (f ?? "").split(/\s+or\s+/i).map((x) => x.replace(/\(\?\)/g, "").trim()).filter(Boolean);
    return pieces.length > 0 && pieces.every((x) => AFRICAN_PLACE.test(x));
  });
}

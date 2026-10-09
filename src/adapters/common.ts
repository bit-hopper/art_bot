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

// Carved objects the owner ranks as sculpture (2026-10-09) even when the museum files them under a generic type.
const SCULPTURE_TITLE = /\b(coffin|sarcophag\w*|sarkophag\w*|cercueil|stela|stelae|stele|stèle)\b/i;

// Carved or cast furniture and ritual implements whose museum type is generic ("Religious/Ritual Object", "Furniture and woodwork").
// Ornaments (owner 2026-10-09: jewellery, rings and amulets rank at least 40) that AIC files under "Costume and Accessories".
const CARVED_TITLE = /\b(edan|tapper|neckrest|headrest|stool|amulet|scarab|ring|necklace|bracelet|pendant|beads?|earring|anklet|armlet|fibula|brooch|diadem|collar|jewel(?:ry|lery)|jewellery)s?\b/i;

/** Structured object type first (spec 4.1); a title that says "mask" rescues a generically typed object, one that names a coffin or stela is sculpture, and one that names a stool, headrest, neckrest, tapper or edan is a carved object. */
export function classifyRecord(type: string | null | undefined, title: string | null | undefined, profile: FilterProfile, fallback?: string | null): ObjectClass {
  let cls = classify(type, profile);
  if (cls === "other" && fallback) cls = classify(fallback, profile);
  if (cls === "other" && classify(title, profile) === "mask") cls = "mask";
  if (cls === "other" && title && SCULPTURE_TITLE.test(title)) cls = "sculpture";
  if (cls === "other" && title && CARVED_TITLE.test(title)) cls = "other-carved-cast";
  return cls;
}

const FRAGMENT = /fragment|bruchst/i;
const FLAT = /textil|papyr|kelim|gewebe|stoff|tapestry|tunic|tunika|clavus|segment|curtain|vorhang|behang|hanging|linen|leinen|wool|wolle|cloth|garment|kleidung|seide|silk|weav|woven/i;
export const FLAT_FRAGMENT_FACTOR = 0.3;

/**
 * Owner ruling 2026-10-09: textile and papyrus fragments rank lower; ceramic, wooden and other non-woven fragments keep
 * their class weight. True when the type or title names a fragment of something woven or written on papyrus.
 */
export function isFlatFragment(...texts: Array<string | null | undefined>): boolean {
  const t = texts.filter(Boolean).join(" ");
  return FRAGMENT.test(t) && FLAT.test(t);
}

/** Spec 4.2: class weight x 0.5 if the image's long edge is under 600 px, x 1.2 for a museum highlight. */
export function scoreFor(weight: number, q: { longEdge?: number | null; highlight?: boolean; fragment?: boolean } = {}): number {
  let s = weight;
  if (q.fragment) s *= FLAT_FRAGMENT_FACTOR;
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

const PERIOD_ONLY = /^(?:(?:early|middle|late|abbasid|aghlabid|fatimid|mamluk|ayyubid|umayyad|ptolemaic|coptic|islamic|period|dynasty|sultanate|centur(?:y|ies)|bce|ce|\d+(?:st|nd|rd|th)?)[\s,-]*)+$/i;

/**
 * Owner ruling 2026-10-08: origin decides, not travel. An object made in Africa stays African whoever ruled the place or
 * wherever it later went (Ptolemaic, Roman, Byzantine, Coptic, Islamic-period Egypt; Carthage; the Maghreb). A field
 * qualifies when every alternative the museum names is African: "Egypt", "probably Morocco" pass, "Egypt or Syria (?)" and
 * "Egyptian or Levantine" do not (origin not established). Any one qualifying field is enough.
 */
export function africanOrigin(...fields: Array<string | null | undefined>): boolean {
  return fields.some((f) => {
    // A ruler or a dynasty on either side of "or" is not a rival place: "reign of Ptolemy V or Ptolemy VI", "Aghlabid or Abbasid".
    const text = (f ?? "").replace(/,?\s*reign of\s.*$/i, "");
    const pieces = text.split(/\s+or\s+/i).map((x) => x.replace(/\(\?\)/g, "").trim()).filter((x) => x && !PERIOD_ONLY.test(x));
    return pieces.length > 0 && pieces.every((x) => AFRICAN_PLACE.test(x));
  });
}

import type { FilterProfile } from "./config.js";
import type { ObjectClass } from "./types.js";

const SPLIT = /[^\p{L}\p{N}_]+/u;

/** Lower-cased word tokens, plus crude singular forms ("Röhrentrommeln" also yields "röhrentrommel"). */
function tokens(text: string): string[] {
  const toks = text.toLowerCase().split(SPLIT).filter(Boolean);
  return [...toks, ...toks.filter((w) => w.endsWith("n") && w.length > 4).map((w) => w.slice(0, -1))];
}

/**
 * German compounds put the head noun last ("Mumienmaske", "Blashorn"), so a keyword matches at either end of a
 * token. Keywords containing a space or punctuation are matched as phrases against the whole text.
 */
function hasAny(text: string, toks: string[], words: string[]): boolean {
  return words.some((raw) => {
    const w = raw.toLowerCase();
    if (/[^\p{L}\p{N}]/u.test(w)) return text.includes(w);
    return toks.some((t) => t.startsWith(w) || t.endsWith(w));
  });
}

/** True when any term matches `text` by the same token rules the classifier uses (either end of a compound, phrases whole). */
export function matchesTerms(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return hasAny(lower, tokens(lower), words);
}

/** Derive `object_class` from the museum's own object type wording (spec 4.1, steps 1 and 2). */
export function classify(objectType: string | null | undefined, profile: FilterProfile): ObjectClass {
  const text = (objectType ?? "").toLowerCase();
  const toks = tokens(text);
  const kw = profile.keywords;
  const first = toks[0];

  if (first && kw.archive.includes(first)) return "archive";
  if (hasAny(text, toks, kw.specimen)) return "specimen";
  if (hasAny(text, toks, profile.exclude_keywords)) return "other";
  if (hasAny(text, toks, kw.mask) && !hasAny(text, toks, kw.not_mask)) return "mask";
  if (hasAny(text, toks, kw["carved-instrument"])) return "carved-instrument";
  if (hasAny(text, toks, kw["other-carved-cast"])) return "other-carved-cast";
  if (hasAny(text, toks, kw.sculpture) || toks.some((t) => kw.sculpture_whole_word.includes(t))) return "sculpture";
  return "other";
}

/** Class weight (spec 4); zero means never posted. */
export function classWeight(cls: ObjectClass, profile: FilterProfile): number {
  return profile.classes[cls] ?? 0;
}

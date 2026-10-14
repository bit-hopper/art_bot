import { matchesTerms } from "./classify.js";
import type { Denylist } from "./config.js";
import type { Artwork } from "./types.js";

const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

const BCE = /\b(?:b\.?\s?c\.?(?:e\.?)?|v\.?\s?chr|av\.?\s?j\.?-?c)(?![\p{L}])/iu;
const YEAR = /(?<!\d)(1\d{3}|20\d{2})(?!\d)/g;
const CENTURY = /\b\d{1,2}(?:st|nd|rd|th|\.)?\s*(?:century|jh|jahrhundert|siècle)/i;

/**
 * The earliest year the date text gives when it clearly points past `cutoff`, else null. BCE dates are skipped, and so is a
 * text that also names a century ("19th century, collected 1980"): the later year is then an acquisition, not the making.
 */
function madeAfter(dateDisplay: string | null, cutoff: number): number | null {
  const text = dateDisplay ?? "";
  if (BCE.test(text) || CENTURY.test(text)) return null;
  const years = [...text.matchAll(YEAR)].map((m) => Number(m[1]));
  const first = years.length > 0 ? Math.min(...years) : null;
  return first !== null && first > cutoff ? first : null;
}

/** Spec 7.4. Returns the reason an object must not be posted, or null. An ethics filter: it stays when licensing never blocks. */
export function denyReason(a: Artwork, deny: Denylist): string | null {
  if (deny.blocked_keys.includes(a.key)) return `manual override ${a.key}`;
  if (deny.latest_year != null) {
    const year = madeAfter(a.dateDisplay, deny.latest_year);
    if (year !== null) return `dated ${year}, after ${deny.latest_year}`;
  }
  if (deny.modern_material_terms?.length) {
    const term = deny.modern_material_terms.find((t) => matchesTerms([a.medium, a.title].filter(Boolean).join(" \n "), [t]));
    if (term) return `modern material "${term}"`;
  }
  const strip = (s: string) => (deny.allowed_phrases ?? []).reduce((t, ph) => t.split(ph.toLowerCase()).join(" "), s.toLowerCase());
  const typeTokens = strip(a.objectType ?? "").toLowerCase().split(TOKEN_SPLIT);
  const tok = deny.blocked_type_tokens.find((t) => typeTokens.includes(t.toLowerCase()));
  if (tok) return `object type "${a.objectType}" (${tok})`;
  const text = strip([a.title, a.objectType, a.medium, a.description, a.provenanceNote].filter(Boolean).join(" \n "));
  const term = deny.blocked_terms.find((t) => matchesTerms(text, [t]));
  return term ? `record mentions "${term}"` : null;
}

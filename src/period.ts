import { matchesTerms } from "./classify.js";
import type { Artwork } from "./types.js";

/** New Kingdom (Dynasties 18 to 20), with a little slack at both ends for museums that round ("about 1550", "1075"). */
const NK_FROM = 1580;
const NK_TO = 1040;

const BCE = /\b(?:b\.?\s?c\.?(?:e\.?)?|v\.?\s?chr|av\.?\s?j\.?-?c)(?![\p{L}])/iu;
const YEAR = /(?<!\d)(\d{3,4})(?!\d)/g;

// "Dynasty 18", "18th Dynasty", "18. Dynastie", "Dynastie 19-20", "XVIIIe dynastie", "Dynasty XIX".
const DYNASTY_ARABIC = /\b(?:dynast(?:y|ie|ies)\s*(?:no\.?\s*)?(?:18|19|20)(?!\d)|(?:18|19|20)(?:st|nd|rd|th|e|ème|\.)?\s*dynast(?:y|ie))/i;
const DYNASTY_ROMAN = /\b(?:dynast(?:y|ie)\s*(?:xviii|xix|xx)\b|(?:xviii|xix|xx)(?:e|ème|th)?\s*dynast(?:y|ie))/i;

/**
 * True when the record's own date, culture or period wording places it in the New Kingdom (about 1550 to 1070 BCE): a period name
 * (`terms`: "New Kingdom", "Neues Reich", "Nouvel Empire", Amarna, Ramesside), a Dynasty 18 to 20 label, or a BCE date range that
 * lies wholly inside those years. The Met's separate `dynasty` and `period` fields are not kept on the record, so a Met object is
 * recognised by its `objectDate` range, which it gives for most Egyptian pieces.
 */
export function isNewKingdom(a: Pick<Artwork, "dateDisplay" | "culture">, terms: string[]): boolean {
  const text = [a.dateDisplay, a.culture].filter(Boolean).join(" ; ");
  if (!text) return false;
  if (matchesTerms(text, terms) || DYNASTY_ARABIC.test(text) || DYNASTY_ROMAN.test(text)) return true;
  if (!BCE.test(text)) return false;
  const years = [...text.matchAll(YEAR)].map((m) => Number(m[1]));
  return years.length > 0 && years.every((y) => y <= NK_FROM && y >= NK_TO);
}

/** A date or period is stated at all, so "not New Kingdom" is known and not just unrecorded. */
export function hasDateInfo(a: Pick<Artwork, "dateDisplay">): boolean {
  return /\d|dynast|kingdom|reich|empire|period|periode|zeit|époque|epoque/i.test(a.dateDisplay ?? "");
}

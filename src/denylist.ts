import { matchesTerms } from "./classify.js";
import type { Denylist } from "./config.js";
import type { Artwork } from "./types.js";

const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

/** Spec 7.4. Returns the reason an object must not be posted, or null. An ethics filter: it stays when licensing never blocks. */
export function denyReason(a: Artwork, deny: Denylist): string | null {
  if (deny.blocked_keys.includes(a.key)) return `manual override ${a.key}`;
  const strip = (s: string) => (deny.allowed_phrases ?? []).reduce((t, ph) => t.split(ph.toLowerCase()).join(" "), s.toLowerCase());
  const typeTokens = strip(a.objectType ?? "").toLowerCase().split(TOKEN_SPLIT);
  const tok = deny.blocked_type_tokens.find((t) => typeTokens.includes(t.toLowerCase()));
  if (tok) return `object type "${a.objectType}" (${tok})`;
  const text = strip([a.title, a.objectType, a.medium, a.description, a.provenanceNote].filter(Boolean).join(" \n "));
  const term = deny.blocked_terms.find((t) => matchesTerms(text, [t]));
  return term ? `record mentions "${term}"` : null;
}

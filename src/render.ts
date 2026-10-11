import { matchesTerms } from "./classify.js";
import type { Artwork } from "./types.js";

export type Platform = "bluesky" | "threads";

/** Bluesky counts graphemes; Threads counts characters with emoji as UTF-8 bytes (spec 6.2, 6.3). */
export const LIMITS: Record<Platform, number> = { bluesky: 300, threads: 500 };
export const ALT_LIMIT = 1000; // Threads `alt_text` cap; Bluesky has none, so one cap serves both

export const MUSEUMS: Record<string, string> = {
  met: "The Metropolitan Museum of Art",
  cleveland: "Cleveland Museum of Art",
  aic: "Art Institute of Chicago",
  mia: "Minneapolis Institute of Art",
  smb: "Staatliche Museen zu Berlin",
  louvre: "Musée du Louvre",
  nmafa: "Smithsonian National Museum of African Art",
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EMOJI = /\p{Extended_Pictographic}/u;
const utf8 = new TextEncoder();

function cost(grapheme: string, platform: Platform): number {
  if (platform === "bluesky") return 1;
  return EMOJI.test(grapheme) ? utf8.encode(grapheme).length : [...grapheme].length;
}

export function measure(text: string, platform: Platform): number {
  if (/^[ -~\n]*$/.test(text)) return text.length; // printable ASCII: one grapheme and one byte each
  let n = 0;
  for (const { segment } of segmenter.segment(text)) n += cost(segment, platform);
  return n;
}

/** Cut to at most `max` units, preferring a word boundary, ending in "…". Returns `text` unchanged if it fits. */
export function truncate(text: string, max: number, platform: Platform): string {
  if (measure(text, platform) <= max) return text;
  const budget = max - cost("…", platform);
  if (budget <= 0) return "";
  let used = 0;
  let out = "";
  for (const { segment } of segmenter.segment(text)) {
    const c = cost(segment, platform);
    if (used + c > budget) break;
    out += segment;
    used += c;
  }
  const atWord = out.replace(/[\s,;:.\-–—]+\S*$/u, "");
  const cut = atWord.length >= out.length * 0.6 ? atWord : out;
  return cut.trimEnd().replace(/[,;:\-–—]+$/u, "") + "…";
}

/** Fields are capped before measuring: grapheme counting is slow, and nothing past 4x the longest limit can survive. */
const MAX_FIELD = 2000;

function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").slice(0, MAX_FIELD).replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

export function museumName(a: Artwork): string {
  const base = MUSEUMS[a.source] ?? a.source;
  return a.source === "smb" && clean(a.department) ? `${clean(a.department)}, ${base}` : base;
}

function placeLine(a: Artwork): string | null {
  const parts: string[] = [];
  for (const p of [clean(a.culture), clean(a.country)]) {
    if (p && !parts.some((q) => q.toLowerCase().includes(p.toLowerCase()) || p.toLowerCase().includes(q.toLowerCase()))) parts.push(p);
  }
  const where = parts.join(", ");
  return [where || null, clean(a.dateDisplay)].filter(Boolean).join(" · ") || null;
}

// Owner 2026-10-09: the same two tags on every post; no #AncientEgypt (Egypt is Africana by origin, not a separate theme).
const HASHTAGS = "#AfricanaArt #Africana";

function composeRoot(title: string, place: string | null, museum: string, gallery: string | null, tags: string): string {
  const museumLine = gallery ? `${museum} · ${gallery}` : museum;
  return [title, place, museumLine, "", tags].filter((l) => l !== null).join("\n");
}

export function renderRoot(a: Artwork, platform: Platform): string {
  const limit = LIMITS[platform];
  const title = clean(a.title) ?? clean(a.objectType) ?? "Untitled";
  let place = placeLine(a);
  const gallery = a.onView ? clean(a.gallery) : null;
  const museum = museumName(a);
  const tags = HASHTAGS;

  for (const g of [gallery, null]) {
    const full = composeRoot(title, place, museum, g, tags);
    if (measure(full, platform) <= limit) return full;
  }
  const overhead = measure(composeRoot("", place, museum, null, tags), platform);
  const room = limit - overhead;
  if (room >= 20 || !place) return composeRoot(truncate(title, Math.max(room, 1), platform), place, museum, null, tags);
  const fixed = measure(composeRoot("", null, museum, null, tags), platform);
  place = truncate(place, Math.max(limit - fixed - 21, 1), platform);
  return composeRoot(truncate(title, 20, platform), place, museum, null, tags);
}

/** Spec 6.6 and 7.5: credit in the reply states the image licence; says "resized" when we resized. */
export function rightsLine(a: Artwork, resized: boolean): string {
  const museum = MUSEUMS[a.source] ?? a.source;
  const note = resized ? ", resized" : "";
  const lic = clean(a.imageLicense);
  switch (a.rightsStatus) {
    case "open":
      return `Image: ${lic ?? "open access"}, ${museum}${resized ? " (resized)" : ""}`;
    case "attributed":
    case "attributed-nc": {
      const who = clean(a.photographer);
      return who ? `Source: ${museum}. Photo: ${who} (${lic ?? "licensed"}${note})` : `Image: ${lic ?? "licensed"}, ${museum}${resized ? " (resized)" : ""}`;
    }
    default:
      return `Rights: ${lic ?? "no open licence"}, ${museum}${resized ? " (resized)" : ""}`;
  }
}

/**
 * A full stop ends a sentence only after two lowercase letters or digits, so initials ("C. White"), "c. 1912" and "N.Y." survive.
 * Not after a one- or two-digit number (German ordinals and centuries: "19. Jh.", "am 3. Mai") or a common abbreviation
 * ("Feb. 1897", "Nr. 12"); a four-digit year still ends a sentence.
 */
const SENTENCE_END =
  /(?<=[\p{Ll}\d)\]]{2}[.!?])(?<!\b(?:\d{1,2}|[Jj]an|[Ff]eb|[Mm]ar|[Aa]pr|[Jj]un|[Jj]ul|[Aa]ug|[Ss]ep|[Ss]ept|[Oo]ct|[Nn]ov|[Dd]ec|[Jj]hs?|[Nn]rs?|[Nn]os?|[Vv]ol|[Ff]ig|[Aa]bb|[Bb]zw|[Uu]sw)\.)\s+(?=[\p{Lu}\d])/u;

export interface ProvenanceNote {
  text: string;
  flagged: boolean;
}

/**
 * Spec 7.4: the note comes from the record only. A sentence containing a flag term wins; otherwise the first sentence
 * (the one that names how and when the museum acquired the object).
 */
export function pickProvenanceNote(raw: string | null | undefined, flags: string[]): ProvenanceNote | null {
  const text = clean(raw);
  if (!text) return null;
  const sentences = text.split(SENTENCE_END);
  const hit = sentences.find((s) => matchesTerms(s, flags));
  if (hit) return { text: hit, flagged: true };
  return { text: sentences[0]!, flagged: false };
}

interface ReplyParts {
  type: string | null;
  medium: string | null;
  dimensions: string | null;
  accession: string | null;
  credit: string | null;
  rights: string | null;
  provenance: string | null;
  description: string | null;
  note: string | null;
  url: string | null;
}

function composeReply(p: ReplyParts): string {
  const head = [p.type, p.medium].filter(Boolean).join(" · ") || null;
  return [
    head,
    p.dimensions,
    p.accession ? `Accession no. ${p.accession}` : null,
    p.credit,
    p.rights,
    p.provenance ? `Provenance: ${p.provenance}` : null,
    p.description,
    p.note,
    p.url,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** Spec 6.7: translated text is flagged; the museum link carries the original. Never dropped for room. */
const MACHINE_TRANSLATION = "[machine translation]";
const MIN_DESCRIPTION = 40;
const MIN_PROVENANCE = 24;

export function renderReply(
  a: Artwork,
  platform: Platform,
  opts: { resized?: boolean; provenance?: ProvenanceNote | null } = {},
): string {
  const limit = LIMITS[platform];
  const p: ReplyParts = {
    type: clean(a.objectType),
    medium: clean(a.medium),
    dimensions: clean(a.dimensions),
    accession: clean(a.accessionNumber),
    credit: clean(a.creditLine),
    rights: rightsLine(a, opts.resized ?? false),
    provenance: opts.provenance?.text ?? null,
    description: clean(a.description),
    note: a.translated ? MACHINE_TRANSLATION : null,
    url: a.objectUrl,
  };
  const fits = () => measure(composeReply(p), platform) <= limit;
  /** Characters left for field `k` when it is the only one being shrunk. */
  const room = (k: keyof ReplyParts, label: string) => {
    const saved = p[k];
    p[k] = null;
    const left = limit - measure(composeReply(p), platform) - 1 - measure(label, platform);
    p[k] = saved;
    return left;
  };

  if (!fits() && p.description) {
    const left = room("description", "");
    p.description = left >= MIN_DESCRIPTION ? truncate(p.description, left, platform) : null;
  }
  if (!fits()) p.dimensions = null;
  if (!fits()) p.medium = null;
  if (!fits() && p.provenance) {
    const left = room("provenance", "Provenance: ");
    p.provenance = left >= MIN_PROVENANCE ? truncate(p.provenance, left, platform) : null;
  }
  // Credit, accession and URL are never dropped (spec 6.2); only if they alone overflow is the credit shortened.
  if (!fits() && p.credit) {
    const left = room("credit", "");
    p.credit = left >= 12 ? truncate(p.credit, left, platform) : null;
  }
  // Last resort for absurd inputs: shorten what is left, least important first, so the output always fits.
  for (const k of ["type", "rights", "accession"] as const) {
    if (fits() || !p[k]) continue;
    const left = room(k, k === "accession" ? "Accession no. " : "");
    p[k] = left >= 8 ? truncate(p[k]!, left, platform) : null;
  }
  return composeReply(p);
}

/** Spec 6.2: `{object_type}: {title}. {culture}, {date}. {medium}. {museum}.` plus the museum's image description, else the first sentence of the description. */
export function renderAlt(a: Artwork): string {
  const type = clean(a.objectType);
  const title = clean(a.title);
  const head = type && title && type.toLowerCase() !== title.toLowerCase() ? `${type}: ${title}` : (title ?? type ?? "Artwork");
  const where = [clean(a.culture) ?? clean(a.country), clean(a.dateDisplay)].filter(Boolean).join(", ");
  const sentence = clean(a.imageAlt) ?? clean(a.description)?.split(SENTENCE_END)[0] ?? null;
  const full = [head, where || null, clean(a.medium), MUSEUMS[a.source] ?? a.source, sentence ? truncate(sentence, 200, "threads") : null]
    .filter(Boolean)
    .map((s) => (/[.!?…]$/u.test(s!) ? s! : `${s}.`))
    .join(" ");
  return truncate(full, ALT_LIMIT, "threads");
}

export interface RenderedPost {
  root: string;
  reply: string;
  alt: string;
  provenance: ProvenanceNote | null;
}

export function renderPost(
  a: Artwork,
  platform: Platform,
  opts: { resized?: boolean; provenanceFlags?: string[] } = {},
): RenderedPost {
  const provenance = pickProvenanceNote(a.provenanceNote, opts.provenanceFlags ?? []);
  return {
    root: renderRoot(a, platform),
    reply: renderReply(a, platform, { resized: opts.resized, provenance }),
    alt: renderAlt(a),
    provenance,
  };
}

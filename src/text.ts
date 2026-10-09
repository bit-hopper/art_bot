const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * SMB's `html_text` is HTML that has itself been entity-escaped (`&lt;div&gt;...`). Decode once to get the markup,
 * turn block breaks into spaces, strip tags, then decode again for the text entities.
 */
export function htmlToText(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = /&lt;|&gt;/.test(input) ? decodeEntities(input) : input;
  s = s.replace(/<\s*(br|\/div|\/p|\/li)\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

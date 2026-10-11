/**
 * Spec 6.7: machine translation of the free-text fields of the one object picked for this hour, with DeepL API Free.
 * Dimensions are included (SMB writes them as "Höhe x Breite x Tiefe: 10 x 8,5 x 1 cm"). Titles, names, places and accession numbers are never sent. Any problem (no key, past the cap, a failed call) returns the
 * artwork unchanged, so a post is never blocked or delayed by translation.
 */
import { loadSourceConfig } from "./config.js";
import type { Artwork } from "./types.js";

const FIELDS = ["objectType", "medium", "dimensions", "description", "provenanceNote"] as const;
/** Spec 6.7: stop at 90% of the 500,000 free characters a month. */
const DEFAULT_CAP = 450_000;
const CONTEXT = "Museum catalogue entry for an African art object. A single word is an object type, e.g. 'Plastik' is a sculpture.";

export interface TranslateOptions {
  key?: string;
  /** Source language per museum id; defaults to `language` in config/sources.yaml (unset or "en" = nothing to translate). */
  language?: (source: string) => string | undefined;
  cap?: number;
  fetchImpl?: typeof fetch;
  log?: (o: Record<string, unknown>) => void;
}

/** DeepL explains a refusal in a JSON body ({"message": ...}); the key itself is never logged. */
async function failure(what: string, res: Response, key: string): Promise<Error> {
  const body = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
  return new Error(`${what} HTTP ${res.status} from ${new URL(base(key)).host}: ${body}`);
}

const defaultLog = (o: Record<string, unknown>) => console.error(JSON.stringify(o));

/** Free keys end in ":fx" and use their own host. */
const base = (key: string) => (key.endsWith(":fx") ? "https://api-free.deepl.com/v2" : "https://api.deepl.com/v2");

export async function translateArtwork(a: Artwork, opts: TranslateOptions = {}): Promise<Artwork> {
  const log = opts.log ?? defaultLog;
  const key = opts.key ?? process.env.DEEPL_API_KEY;
  const lang = (opts.language ?? ((s) => loadSourceConfig(s).language))(a.source)?.toLowerCase();
  if (!lang || lang === "en") return a;
  if (!key) {
    log({ event: "translation-skipped", key: a.key, reason: "no DEEPL_API_KEY" });
    return a;
  }
  const todo = FIELDS.filter((f) => (a[f] ?? "").trim() !== "");
  if (todo.length === 0) return a;
  const texts = todo.map((f) => a[f]!.trim());
  const chars = texts.reduce((n, t) => n + t.length, 0);
  const cap = opts.cap ?? Number(process.env.TRANSLATION_MONTHLY_CAP ?? DEFAULT_CAP);
  const f = opts.fetchImpl ?? fetch;
  const headers = { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" };
  try {
    const usage = await f(`${base(key)}/usage`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!usage.ok) throw await failure("usage", usage, key);
    const used = ((await usage.json()) as { character_count: number }).character_count;
    if (used + chars > cap) {
      log({ event: "translation-skipped", key: a.key, reason: "monthly cap", used, chars, cap });
      return a;
    }
    const res = await f(`${base(key)}/translate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: texts, source_lang: lang.toUpperCase(), target_lang: "EN-US", context: CONTEXT }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw await failure("translate", res, key);
    const out = ((await res.json()) as { translations: Array<{ text: string }> }).translations;
    if (out.length !== texts.length) throw new Error(`expected ${texts.length} translations, got ${out.length}`);
    const next: Artwork = { ...a, translated: true };
    todo.forEach((field, i) => (next[field] = out[i]!.text.trim() || a[field]));
    log({ event: "translated", key: a.key, from: lang, chars, used: used + chars });
    return next;
  } catch (e) {
    log({ event: "translation-failed", key: a.key, error: e instanceof Error ? e.message : String(e) });
    return a;
  }
}

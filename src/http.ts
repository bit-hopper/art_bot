/** Polite HTTP client: identified User-Agent, per-host spacing, retry on 429/5xx, stop on 403/429 for scrapers. */

export const DEFAULT_USER_AGENT = "africana-art-bot/0.1 (+https://github.com/bit-hopper)";

export class StopCrawlError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} from ${url}: stop and back off (spec 7.3)`);
    this.name = "StopCrawlError";
  }
}

export interface HttpOptions {
  userAgent?: string;
  /** Minimum gap between requests to the same client instance, in ms. 1000 = 1 req/s (SMB, spec 7.3). */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Backoff schedule for retryable failures (spec 10: 1 s, 4 s, 16 s). */
  retryDelaysMs?: number[];
  /** When true a 403 or 429 throws StopCrawlError immediately instead of retrying (scraping sources). */
  stopOnBlock?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
  private last = 0;
  private readonly o: Required<Omit<HttpOptions, "fetchImpl" | "sleep">> & Pick<HttpOptions, "fetchImpl" | "sleep">;

  constructor(opts: HttpOptions = {}) {
    this.o = {
      userAgent: opts.userAgent ?? process.env.BOT_USER_AGENT ?? DEFAULT_USER_AGENT,
      minIntervalMs: opts.minIntervalMs ?? 0,
      timeoutMs: opts.timeoutMs ?? 30_000,
      retryDelaysMs: opts.retryDelaysMs ?? [1000, 4000, 16000],
      stopOnBlock: opts.stopOnBlock ?? false,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
    };
  }

  /** Reserves the next request slot synchronously, so concurrent callers are spaced too. */
  private async pace(): Promise<void> {
    const sleep = this.o.sleep ?? realSleep;
    const now = Date.now();
    const at = Math.max(now, this.last + this.o.minIntervalMs);
    this.last = at;
    if (at > now) await sleep(at - now);
  }

  async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.request(url, headers);
  }

  private async request(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<Response> {
    const doFetch = this.o.fetchImpl ?? fetch;
    const sleep = this.o.sleep ?? realSleep;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Response | undefined;
      let failure: unknown;
      try {
        res = await doFetch(url, {
          ...init,
          headers: { "User-Agent": this.o.userAgent, ...headers },
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (e) {
        failure = e;
      }
      if (res) {
        if (this.o.stopOnBlock && (res.status === 403 || res.status === 429)) {
          throw new StopCrawlError(res.status, url);
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) return res;
        if (attempt >= this.o.retryDelaysMs.length) return res;
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.o.retryDelaysMs[attempt]!;
        await res.body?.cancel();
        await sleep(delay);
        continue;
      }
      if (attempt >= this.o.retryDelaysMs.length) throw failure;
      await sleep(this.o.retryDelaysMs[attempt]!);
    }
  }

  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.get(url, { Accept: "application/json", ...headers });
    // A JSON API answering with HTML is a WAF interstitial (the Met's Incapsula did this): back off, do not retry.
    if (/html/i.test(res.headers.get("content-type") ?? "")) throw new StopCrawlError(res.status, url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  }

  async postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.request(url, { Accept: "application/json", "Content-Type": "application/json", ...headers }, { method: "POST", body: JSON.stringify(body) });
    if (/html/i.test(res.headers.get("content-type") ?? "")) throw new StopCrawlError(res.status, url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  }

  async getText(url: string): Promise<string> {
    const res = await this.get(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  }
}

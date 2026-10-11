/**
 * Hourly entrypoint (spec 2, 8.3, 10). Dry run is the default: `DRY_RUN=0` posts for real.
 *   npx tsx src/run.ts [--count=N]   N dry-run picks (in-memory ledger only); a live run always posts one.
 * Env: STATE_DIR, BSKY_IDENTIFIER, BSKY_APP_PASSWORD, BOT_USER_AGENT, PAUSED=true.
 */
import { enabledAdapters } from "./adapters/index.js";
import { loadDenylist, loadProfile, loadSourceWeights } from "./config.js";
import { denyReason } from "./denylist.js";
import { HttpClient } from "./http.js";
import { downloadImage, prepareImage, type PreparedImage } from "./image.js";
import { claimRow, Ledger } from "./ledger.js";
import { login, publish } from "./publishers/bluesky.js";
import { fetchRecentPosts, reconcile } from "./reconcile.js";
import { LIMITS, measure, renderPost } from "./render.js";
import { selectArtwork } from "./selector.js";
import { translateArtwork } from "./translate.js";
import { ledgerFile, readIndex } from "./state.js";
import { pushState } from "./state-sync.js";
import type { Artwork, IndexRow, MuseumAdapter } from "./types.js";

const log = (o: Record<string, unknown>) => console.error(JSON.stringify(o));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dryRun = process.env.DRY_RUN !== "0";
const count = Number(process.argv.find((a) => a.startsWith("--count="))?.slice(8) ?? 1);

if (process.env.PAUSED === "true") {
  log({ event: "paused" });
  process.exit(0);
}

const profile = loadProfile();
const deny = loadDenylist();
const sourceWeights = loadSourceWeights();
const adapters = new Map<string, MuseumAdapter>(enabledAdapters().map((a) => [a.id, a]));
const rows: IndexRow[] = [];
for (const id of adapters.keys()) {
  const idx = readIndex(id);
  if (!idx) log({ event: "no-index", source: id, hint: "run src/build-index.ts" });
  else rows.push(...idx);
}
if (rows.length === 0) {
  log({ event: "POOL_EMPTY", reason: "no index rows for any enabled source" });
  process.exit(1);
}

// A dry run works on an in-memory copy, so nothing reaches the ledger file and the next pick stays distinct.
const stored = Ledger.load(ledgerFile());
const ledger = dryRun ? new Ledger(null, stored.allRows()) : stored;
// A 403 on one image (Mia's S3 host answers AccessDenied for missing files) fails that object, not the run; 429s still back off.
const images = new HttpClient({ minIntervalMs: 1000 });

async function pickOne(): Promise<{ artwork: Artwork; image: PreparedImage } | null> {
  const sel = await selectArtwork<PreparedImage>({
    rows, ledger, profile, sourceWeights,
    fetch: (r) => adapters.get(r.source)!.fetchArtwork(r.sourceObjectId),
    deny: (a) => denyReason(a, deny),
    prepare: async (a) => prepareImage(await downloadImage(a.imageUrl!, images)),
  });
  for (const t of sel.exhaustedTiers) log({ event: "TIER_EXHAUSTED", tier: t });
  for (const a of sel.attempts) log({ event: "attempt", ...a });
  if (!sel.ok) {
    log({ event: sel.reason, candidates: rows.length });
    return null;
  }
  log({ event: "selected", key: sel.artwork.key, class: sel.artwork.objectClass, region: sel.artwork.regionGroup, score: sel.row.score, rights: sel.artwork.rightsStatus });
  return { artwork: sel.artwork, image: sel.prepared };
}

let failures = 0;
let agent: Awaited<ReturnType<typeof login>> | null = null;
if (!dryRun) {
  // Minimum gap: several triggers (GitHub's schedule, an external scheduler, a manual run) may fire in the same hour, and
  // only the first should post. MIN_GAP_MINUTES=0 turns the guard off for a deliberate extra post.
  const gap = Number(process.env.MIN_GAP_MINUTES || 40);
  const since = ledger.minutesSinceLastPost();
  if (since !== null && since < gap) {
    log({ event: "too-soon", minutesSinceLastPost: Math.floor(since), minGap: gap });
    process.exit(0);
  }
  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!identifier || !password) throw new Error("BSKY_IDENTIFIER and BSKY_APP_PASSWORD are required for a live run");
  agent = await login(identifier, password);
  // Spec 8.3 step 4: repair claims a crashed run left behind before picking anything new.
  if (ledger.stuckClaims().length > 0) {
    const outcome = reconcile(ledger, await fetchRecentPosts(agent, agent.session!.did));
    log({ event: "reconcile", ...outcome });
    pushState("reconcile claims");
    if (outcome.ambiguous.length > 0) failures++;
  }
}
for (let i = 0; i < (dryRun ? count : 1); i++) {
  const picked = await pickOne();
  if (!picked) {
    failures++;
    break;
  }
  const { image } = picked;
  const original = picked.artwork;
  // Spec 6.7: free text of non-English sources is translated for the one chosen object; any failure keeps the original.
  const artwork = await translateArtwork(original);
  const opts = { resized: image.resized, provenanceFlags: deny.provenance_flags };
  const bsky = renderPost(artwork, "bluesky", opts);
  const threads = renderPost(artwork, "threads", opts);

  if (dryRun) {
    const size = `${image.width}x${image.height} ${image.mime} ${image.bytes.length} bytes${image.resized ? ` (resized from ${image.originalBytes})` : ""}`;
    console.log(`\n=== ${artwork.key}  [${artwork.objectClass} / ${artwork.regionGroup} / ${artwork.rightsStatus}]  ${size}`);
    console.log(`--- Bluesky root (${measure(bsky.root, "bluesky")}/${LIMITS.bluesky})\n${bsky.root}`);
    console.log(`--- Bluesky reply (${measure(bsky.reply, "bluesky")}/${LIMITS.bluesky})\n${bsky.reply}`);
    console.log(`--- Threads reply (${measure(threads.reply, "threads")}/${LIMITS.threads})\n${threads.reply}`);
    console.log(`--- alt (${measure(bsky.alt, "threads")}/1000)\n${bsky.alt}`);
    if (artwork.translated) console.log(`--- original text, before translation\n${renderPost(original, "bluesky", opts).reply}`);
    ledger.append({ ...claimRow(artwork, artwork.objectClass), status: "posted_all", postedAt: new Date().toISOString() });
    continue;
  }

  // Spec 8.3: the claim is recorded, and pushed to the state branch, before anything is published.
  const claim = claimRow(artwork, artwork.objectClass);
  ledger.append(claim);
  pushState(`claim ${artwork.key}`);
  try {
    const result = await publish(agent!, {
      rootText: bsky.root, replyText: bsky.reply, alt: bsky.alt, image,
    });
    ledger.append({
      ...claim, status: "posted_bluesky", blueskyUri: result.root.uri, blueskyCid: result.root.cid,
      postedAt: new Date().toISOString(), ...(result.replyError ? { error: `reply failed: ${result.replyError}` } : {}),
    });
    pushState(`posted ${artwork.key}`);
    log({ event: "posted", key: artwork.key, uri: result.root.uri, replyError: result.replyError });
    if (result.replyError) failures++;
  } catch (e) {
    ledger.append({ ...claim, status: "failed", error: errText(e) });
    log({ event: "failed", key: artwork.key, error: errText(e) });
    failures++;
  }
}
process.exit(failures > 0 ? 1 : 0);

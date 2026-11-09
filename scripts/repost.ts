/**
 * One-off repost of an object that is already in the ledger, e.g. after its post was deleted by hand to add a self-label:
 *   npx tsx scripts/repost.ts <key> [--label=nudity] [--live]
 * Dry run unless `--live`. Refuses while the old post still exists (so a repost never duplicates), then publishes the same
 * way run.ts does and appends a new ledger row for the key. Env: STATE_DIR, BSKY_IDENTIFIER, BSKY_APP_PASSWORD, DEEPL_API_KEY.
 */
import { createAdapter } from "../src/adapters/index.js";
import { loadDenylist } from "../src/config.js";
import { sensitiveLabel } from "../src/denylist.js";
import { downloadImage, prepareImage } from "../src/image.js";
import { HttpClient } from "../src/http.js";
import { claimRow, Ledger } from "../src/ledger.js";
import { login, publish } from "../src/publishers/bluesky.js";
import { renderPost } from "../src/render.js";
import { ledgerFile } from "../src/state.js";
import { pushState } from "../src/state-sync.js";
import { translateArtwork } from "../src/translate.js";

const key = process.argv[2];
const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8);
const live = process.argv.includes("--live");
if (!key || key.startsWith("--")) throw new Error("usage: repost.ts <key> [--label=nudity] [--live]");

const ledger = Ledger.load(ledgerFile());
const prior = ledger.allRows().filter((r) => r.key === key).at(-1);
if (!prior) throw new Error(`${key} is not in the ledger`);
const [source, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];

const original = await createAdapter(source).fetchArtwork(id);
const artwork = await translateArtwork(original);
const labels = label ? [label] : [sensitiveLabel(original, loadDenylist()) ?? sensitiveLabel(artwork, loadDenylist())].filter((l): l is "nudity" => l !== null);
const bsky = renderPost(artwork, "bluesky", { resized: false, provenanceFlags: loadDenylist().provenance_flags });
const image = await prepareImage(await downloadImage(artwork.imageUrl!, new HttpClient({ minIntervalMs: 1000 })));
console.log(JSON.stringify({ key, labels, previous: prior.blueskyUri ?? null, image: `${image.width}x${image.height}` }));
console.log(`${bsky.root}\n---\n${bsky.reply}\n--- alt\n${bsky.alt}`);
if (!live) process.exit(0);

const identifier = process.env.BSKY_IDENTIFIER;
const password = process.env.BSKY_APP_PASSWORD;
if (!identifier || !password) throw new Error("BSKY_IDENTIFIER and BSKY_APP_PASSWORD are required with --live");
const agent = await login(identifier, password);
if (prior.blueskyUri) {
  const still = await agent.app.bsky.feed.getPosts({ uris: [prior.blueskyUri] });
  if (still.data.posts.length > 0) throw new Error(`the old post is still up (${prior.blueskyUri}): delete it first, then run this again`);
}
const result = await publish(agent, { rootText: bsky.root, replyText: bsky.reply, alt: bsky.alt, image, ...(labels.length ? { labels } : {}) });
ledger.append({
  ...claimRow(artwork, artwork.objectClass), status: "posted_bluesky", blueskyUri: result.root.uri, blueskyCid: result.root.cid,
  postedAt: new Date().toISOString(), ...(result.replyError ? { error: `reply failed: ${result.replyError}` } : {}),
});
pushState(`repost ${key}`);
console.log(JSON.stringify({ event: "reposted", key, uri: result.root.uri, labels, replyError: result.replyError ?? null }));
process.exit(result.replyError ? 1 : 0);

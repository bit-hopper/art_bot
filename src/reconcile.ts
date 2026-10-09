import type { AtpAgent } from "@atproto/api";
import type { Ledger } from "./ledger.js";

/** One of the bot's own recent posts, reduced to what reconcile needs. */
export interface FeedPost {
  uri: string;
  cid: string;
  text: string;
  createdAt: string;
  /** Set on replies: the root post this one belongs to. */
  replyRoot?: { uri: string; cid: string };
}

export interface ReconcileOutcome {
  recovered: Array<{ key: string; uri: string }>;
  released: string[];
  /** Claims left as they are because a post appeared after them that no ledger row explains; a human should look. */
  ambiguous: string[];
}

/** A claim younger than this may belong to a run that is still publishing, so it is left alone. */
const MIN_AGE_MS = 15 * 60 * 1000;

/** The bot's last `limit` posts and replies (spec 8.3 step 4). */
export async function fetchRecentPosts(agent: Pick<AtpAgent, "getAuthorFeed">, actor: string, limit = 50): Promise<FeedPost[]> {
  const res = await agent.getAuthorFeed({ actor, limit, filter: "posts_with_replies" });
  return res.data.feed.map(({ post }) => {
    const rec = post.record as { text?: string; createdAt?: string; reply?: { root?: { uri: string; cid: string } } };
    return { uri: post.uri, cid: post.cid, text: rec.text ?? "", createdAt: rec.createdAt ?? post.indexedAt, replyRoot: rec.reply?.root };
  });
}

/**
 * Repairs rows left `claimed` by a crash. The reply under every root carries the museum page URL, so a claim whose
 * `objectUrl` appears in a recent reply was published: record it as `posted_bluesky` with the root's URI. A claim old
 * enough to be dead is released (`failed`, so the artwork may be picked again) only when no root post appeared after
 * it that the ledger cannot explain; if one did (a crash between the root and its reply), the claim stays blocked and
 * is reported, because releasing it could repeat an artwork. A crash between "posted" and "recorded" therefore never
 * causes a repeat.
 */
export function reconcile(ledger: Ledger, feed: FeedPost[], now = new Date()): ReconcileOutcome {
  const out: ReconcileOutcome = { recovered: [], released: [], ambiguous: [] };
  const known = new Set(ledger.allRows().map((r) => r.blueskyUri).filter(Boolean));
  for (const claim of ledger.stuckClaims()) {
    if (now.getTime() - Date.parse(claim.claimedAt) < MIN_AGE_MS) continue;
    const reply = feed.find((p) => p.replyRoot && p.text.includes(claim.objectUrl));
    if (reply?.replyRoot) {
      ledger.append({ ...claim, status: "posted_bluesky", blueskyUri: reply.replyRoot.uri, blueskyCid: reply.replyRoot.cid, postedAt: reply.createdAt });
      known.add(reply.replyRoot.uri);
      out.recovered.push({ key: claim.key, uri: reply.replyRoot.uri });
      continue;
    }
    const unexplained = feed.some((p) => !p.replyRoot && !known.has(p.uri) && Date.parse(p.createdAt) >= Date.parse(claim.claimedAt) - 60_000);
    if (unexplained) {
      out.ambiguous.push(claim.key);
      continue;
    }
    ledger.append({ ...claim, status: "failed", error: "reconcile: claimed but no matching post found" });
    out.released.push(claim.key);
  }
  return out;
}

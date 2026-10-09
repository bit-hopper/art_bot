import { AtpAgent, RichText } from "@atproto/api";
import type { PreparedImage } from "../image.js";
import { LIMITS } from "../render.js";

export interface PostRef {
  uri: string;
  cid: string;
}

export interface BlueskyResult {
  root: PostRef;
  reply: PostRef | null;
  /** Set when the root went out but the reply did not: next run retries the reply (spec 6.5). */
  replyError?: string;
}

/** The slice of `AtpAgent` this publisher uses, so tests can substitute a recorder. */
export type BlueskyAgent = Pick<AtpAgent, "uploadBlob" | "post" | "resolveHandle">;

export async function login(identifier: string, appPassword: string, service = "https://bsky.social"): Promise<AtpAgent> {
  const agent = new AtpAgent({ service });
  await agent.login({ identifier, password: appPassword });
  return agent;
}

async function richText(agent: BlueskyAgent, text: string): Promise<RichText> {
  const rt = new RichText({ text });
  if (rt.graphemeLength > LIMITS.bluesky) throw new Error(`post is ${rt.graphemeLength} graphemes, limit ${LIMITS.bluesky}`);
  await rt.detectFacets(agent as AtpAgent);
  return rt;
}

/**
 * Root post (image + alt text) then one reply (spec 6.1, 6.2). Both carry `langs: ["en"]`; link and hashtag facets come
 * from the SDK so grapheme counting matches Bluesky's. A reply failure is returned, not thrown: the root is already public.
 */
export async function publish(
  agent: BlueskyAgent,
  post: { rootText: string; replyText: string; alt: string; image: PreparedImage },
): Promise<BlueskyResult> {
  const rootRt = await richText(agent, post.rootText);
  const replyRt = await richText(agent, post.replyText);

  const upload = await agent.uploadBlob(post.image.bytes, { encoding: post.image.mime });
  const root = await agent.post({
    text: rootRt.text,
    facets: rootRt.facets,
    langs: ["en"],
    embed: {
      $type: "app.bsky.embed.images",
      images: [{ image: upload.data.blob, alt: post.alt, aspectRatio: { width: post.image.width, height: post.image.height } }],
    },
  });

  try {
    const reply = await agent.post({
      text: replyRt.text,
      facets: replyRt.facets,
      langs: ["en"],
      reply: { root: { uri: root.uri, cid: root.cid }, parent: { uri: root.uri, cid: root.cid } },
    });
    return { root: { uri: root.uri, cid: root.cid }, reply: { uri: reply.uri, cid: reply.cid } };
  } catch (e) {
    return { root: { uri: root.uri, cid: root.cid }, reply: null, replyError: e instanceof Error ? e.message : String(e) };
  }
}

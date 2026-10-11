import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAlert, raiseAlert } from "../src/alert.js";
import { evaluateHealth } from "../src/health.js";
import { Ledger, type LedgerRow } from "../src/ledger.js";
import { reconcile, type FeedPost } from "../src/reconcile.js";
import { pushState } from "../src/state-sync.js";

const row = (key: string, status: LedgerRow["status"], claimedAt: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  key, source: "met", accessionNumber: null, title: key, objectUrl: `https://museum.example/${key}`, status, culture: null,
  regionGroup: "sub-saharan", objectClass: "mask", claimedAt, ...extra,
});
const now = new Date("2026-10-10T12:00:00Z");

describe("reconcile (spec 8.3 step 4)", () => {
  const reply = (key: string, root: string): FeedPost => ({ uri: `at://reply/${key}`, cid: "c", text: `Details https://museum.example/${key}`, createdAt: "2026-10-10T10:01:00Z", replyRoot: { uri: root, cid: "rc" } });

  it("records a claim whose reply is in the feed as posted, with the root's URI", () => {
    const ledger = new Ledger(null, [row("met:1", "claimed", "2026-10-10T10:00:00Z")]);
    const out = reconcile(ledger, [reply("met:1", "at://root/1")], now);
    expect(out.recovered).toEqual([{ key: "met:1", uri: "at://root/1" }]);
    expect(ledger.get("met:1")).toMatchObject({ status: "posted_bluesky", blueskyUri: "at://root/1" });
  });

  it("releases an old claim with no post, so the artwork can be picked again", () => {
    const ledger = new Ledger(null, [row("met:2", "claimed", "2026-10-10T09:00:00Z")]);
    expect(reconcile(ledger, [], now).released).toEqual(["met:2"]);
    expect(ledger.blocks("met:2")).toBe(false);
  });

  it("keeps a claim blocked when an unexplained root post appeared after it (root posted, reply missing)", () => {
    const ledger = new Ledger(null, [row("met:3", "claimed", "2026-10-10T09:00:00Z")]);
    const root: FeedPost = { uri: "at://root/x", cid: "c", text: "A mask", createdAt: "2026-10-10T09:01:00Z" };
    const out = reconcile(ledger, [root], now);
    expect(out.ambiguous).toEqual(["met:3"]);
    expect(ledger.blocks("met:3")).toBe(true);
  });

  it("leaves a fresh claim alone: its run may still be publishing", () => {
    const ledger = new Ledger(null, [row("met:4", "claimed", "2026-10-10T11:55:00Z")]);
    expect(reconcile(ledger, [], now)).toEqual({ recovered: [], released: [], ambiguous: [] });
    expect(ledger.get("met:4")!.status).toBe("claimed");
  });

  it("does not mistake a root the ledger already knows for an unexplained one", () => {
    const ledger = new Ledger(null, [row("met:5", "posted_all", "2026-10-10T08:00:00Z", { blueskyUri: "at://root/5" }), row("met:6", "claimed", "2026-10-10T08:30:00Z")]);
    const known: FeedPost = { uri: "at://root/5", cid: "c", text: "x", createdAt: "2026-10-10T08:31:00Z" };
    expect(reconcile(ledger, [known], now).released).toEqual(["met:6"]);
  });
});

describe("minimum gap between posts", () => {
  it("measures minutes from the latest published post and ignores claims and failures", () => {
    const ledger = new Ledger(null, [
      row("met:1", "posted_bluesky", "2026-10-10T10:00:00Z", { postedAt: "2026-10-10T10:30:00Z" }),
      row("met:2", "posted_bluesky", "2026-10-10T11:00:00Z", { postedAt: "2026-10-10T11:20:00Z" }),
      row("met:3", "claimed", "2026-10-10T11:50:00Z"),
      row("met:4", "failed", "2026-10-10T11:55:00Z"),
    ]);
    expect(ledger.minutesSinceLastPost(now)).toBe(40);
    expect(new Ledger(null, []).minutesSinceLastPost(now)).toBeNull();
  });
});

describe("alerts (spec 10)", () => {
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };
  const fake = (open: Array<{ number: number; title: string }>) => {
    const calls: Array<[string, string, unknown]> = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push([method, new URL(url).pathname.replace("/repos/o/r", ""), init?.body ? JSON.parse(String(init.body)) : undefined]);
      return new Response(JSON.stringify(method === "GET" ? open : {}), { status: 200 });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  };

  it("opens one issue per type and comments on it the second time", async () => {
    const first = fake([]);
    expect(await raiseAlert("no-post", "msg", env, first.impl)).toBe("created");
    expect(first.calls.at(-1)).toEqual(["POST", "/issues", { title: "[alert] no-post", body: "msg", labels: ["alert"] }]);
    const second = fake([{ number: 7, title: "[alert] no-post" }]);
    expect(await raiseAlert("no-post", "again", env, second.impl)).toBe("commented");
    expect(second.calls.at(-1)).toEqual(["POST", "/issues/7/comments", { body: "again" }]);
  });

  it("closes the open issue when the condition clears, and only logs without a token", async () => {
    const f = fake([{ number: 9, title: "[alert] stale-index" }]);
    expect(await clearAlert("stale-index", env, f.impl)).toBe(true);
    expect(f.calls.at(-1)).toEqual(["PATCH", "/issues/9", { state: "closed" }]);
    expect(await raiseAlert("x", "m", {}, f.impl)).toBe("logged");
  });
});

describe("health (spec 10)", () => {
  const base = { now, lastPostAt: "2026-10-10T11:00:00Z", indexBuiltAt: { met: "2026-10-10T03:00:00Z" }, paused: false };

  it("is quiet when posting and indexing are current", () => {
    expect(evaluateHealth(base)).toEqual([]);
  });

  it("alerts after 3 hours without a post, on a stale or missing index, and never while paused", () => {
    expect(evaluateHealth({ ...base, lastPostAt: "2026-10-10T08:00:00Z" }).map((a) => a.type)).toEqual(["no-post"]);
    expect(evaluateHealth({ ...base, indexBuiltAt: { met: "2026-10-05T00:00:00Z", smb: null } }).map((a) => a.type)).toEqual(["stale-index"]);
    expect(evaluateHealth({ ...base, lastPostAt: null }).map((a) => a.type)).toEqual(["no-post"]);
    expect(evaluateHealth({ ...base, lastPostAt: null, paused: true })).toEqual([]);
  });
});

describe("pushState (spec 8.3: the claim reaches the state branch before anything is published)", () => {
  // Like a CI runner: no global git identity, and git may not guess one.
  const emptyConfig = path.join(mkdtempSync(path.join(tmpdir(), "no-git-config-")), "config");
  writeFileSync(emptyConfig, "");
  const noIdentity = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };
  const saved = Object.fromEntries(Object.keys(noIdentity).map((k) => [k, process.env[k]]));
  beforeEach(() => {
    Object.assign(process.env, noIdentity);
  });
  afterEach(() => {
    delete process.env.STATE_GIT;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  const git =(cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });

  it("commits, rebases over a concurrent push and pushes; does nothing when off or unchanged", () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-sync-"));
    git(root, "init", "-q", "--bare", "remote.git");
    const clone = (name: string) => {
      git(root, "clone", "-q", "remote.git", name);
      git(path.join(root, name), "checkout", "-q", "-B", "state");
      return path.join(root, name);
    };
    const a = clone("a");
    writeFileSync(path.join(a, "ledger.jsonl"), "one\n");
    git(a, "add", "-A");
    git(a, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    git(a, "push", "-q", "origin", "state");
    const b = clone("b");
    git(b, "pull", "-q", "origin", "state");

    expect(pushState("off", { dir: a })).toBe(false);
    process.env.STATE_GIT = "1";
    writeFileSync(path.join(a, "ledger.jsonl"), "one\ntwo\n");
    expect(pushState("claim", { dir: a })).toBe(true);
    // b pushes a different file meanwhile; its push must rebase over a's commit
    writeFileSync(path.join(b, "meta.json"), "{}\n");
    expect(pushState("meta", { dir: b })).toBe(true);
    expect(readFileSync(path.join(b, "ledger.jsonl"), "utf8")).toBe("one\ntwo\n");
    expect(git(root, "--git-dir=remote.git", "show", "state:meta.json")).toBe("{}\n");
    expect(pushState("nothing", { dir: a })).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import { stateDir } from "./state.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
// A runner has no git identity, and a rebase that replays our commit needs one just as the commit itself does.
const identity = ["-c", "user.name=art-bot", "-c", "user.email=art-bot@users.noreply.github.com"];

/**
 * Spec 8.3: the claim row is pushed before anything is published, and again after each publish step. In Actions the
 * `state` branch is checked out into STATE_DIR and `STATE_GIT=1` turns this on; locally it does nothing.
 * Commits whatever changed in the state directory, rebases on the remote branch and pushes, retrying on a race.
 */
export function pushState(message: string, opts: { dir?: string; attempts?: number; branch?: string } = {}): boolean {
  if (process.env.STATE_GIT !== "1") return false;
  const dir = opts.dir ?? stateDir();
  const branch = opts.branch ?? process.env.STATE_BRANCH ?? "state";
  git(["add", "-A"], dir);
  try {
    git(["diff", "--cached", "--quiet"], dir);
    return false; // nothing to commit
  } catch {
    git([...identity, "commit", "-q", "-m", message], dir);
  }
  let lastError = "";
  for (let i = 0; i < (opts.attempts ?? 5); i++) {
    try {
      git([...identity, "pull", "--rebase", "-q", "origin", branch], dir);
      git(["push", "-q", "origin", `HEAD:${branch}`], dir);
      return true;
    } catch (e) {
      const stderr = (e as { stderr?: unknown }).stderr;
      lastError = (typeof stderr === "string" && stderr.trim() ? stderr : e instanceof Error ? e.message : String(e)).trim();
      try {
        git(["rebase", "--abort"], dir);
      } catch {
        /* no rebase in progress */
      }
    }
  }
  throw new Error(`could not push the state branch after retries: ${lastError.split("\n")[0]}`);
}

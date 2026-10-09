/**
 * Alerts are GitHub issues labelled `alert` (spec 10, owner 2026-10-08). One open issue per alert type: raising an alert
 * that is already open adds a comment instead of a duplicate, and `clearAlert` closes it when the condition has passed.
 * Needs GITHUB_TOKEN and GITHUB_REPOSITORY (both provided inside Actions); without them it only logs.
 */
type Fetch = typeof fetch;

interface Issue {
  number: number;
  title: string;
  pull_request?: unknown;
}

const title = (type: string) => `[alert] ${type}`;

function api(fetchImpl: Fetch, repo: string, token: string) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" };
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
}

async function findOpen(call: ReturnType<typeof api>, type: string): Promise<Issue | undefined> {
  const issues = await call<Issue[]>("GET", "/issues?state=open&labels=alert&per_page=100");
  return issues.find((i) => !i.pull_request && i.title === title(type));
}

export async function raiseAlert(type: string, message: string, env = process.env, fetchImpl: Fetch = fetch): Promise<"created" | "commented" | "logged"> {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  console.error(JSON.stringify({ event: "alert", type, message }));
  if (!token || !repo) return "logged";
  const call = api(fetchImpl, repo, token);
  const open = await findOpen(call, type);
  if (open) {
    await call("POST", `/issues/${open.number}/comments`, { body: message });
    return "commented";
  }
  await call("POST", "/issues", { title: title(type), body: message, labels: ["alert"] });
  return "created";
}

export async function clearAlert(type: string, env = process.env, fetchImpl: Fetch = fetch): Promise<boolean> {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  if (!token || !repo) return false;
  const call = api(fetchImpl, repo, token);
  const open = await findOpen(call, type);
  if (!open) return false;
  await call("POST", `/issues/${open.number}/comments`, { body: "The condition has cleared." });
  await call("PATCH", `/issues/${open.number}`, { state: "closed" });
  return true;
}

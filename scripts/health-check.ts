/**
 * Scheduled health check (spec 10): no post in 3 hours, or an enabled source's index older than 3 days. Runs from its
 * own small workflow because the hourly job may be the thing that is broken. Raises each alert that applies and clears
 * the ones that no longer do. STATE_DIR must point at the checked-out `state` branch.
 */
import { enabledAdapters } from "../src/adapters/index.js";
import { clearAlert, raiseAlert } from "../src/alert.js";
import { evaluateHealth, readMeta } from "../src/health.js";
import { Ledger } from "../src/ledger.js";
import { ledgerFile } from "../src/state.js";

const posts = Ledger.load(ledgerFile()).posts();
const last = posts[posts.length - 1];
const meta = readMeta();
const alerts = evaluateHealth({
  now: new Date(),
  lastPostAt: last ? (last.postedAt ?? last.claimedAt) : null,
  indexBuiltAt: Object.fromEntries(enabledAdapters().map((a) => [a.id, meta.indexBuiltAt[a.id] ?? null])),
  paused: process.env.PAUSED === "true" || process.env.LIVE !== "true", // nothing is expected before the owner switches the bot on
});

const active = new Set(alerts.map((a) => a.type));
for (const a of alerts) console.log(a.type, await raiseAlert(a.type, a.message));
for (const type of ["no-post", "stale-index"]) if (!active.has(type)) await clearAlert(type);
console.log(JSON.stringify({ event: "health", alerts: [...active] }));

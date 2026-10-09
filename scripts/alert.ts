/**
 * Raise or clear a GitHub issue alert from a workflow step (spec 10).
 *   npx tsx scripts/alert.ts raise <type> <message...>
 *   npx tsx scripts/alert.ts clear <type>
 */
import { clearAlert, raiseAlert } from "../src/alert.js";

const [action, type, ...rest] = process.argv.slice(2);
if (!type || (action !== "raise" && action !== "clear")) throw new Error("usage: alert.ts raise <type> <message...> | clear <type>");

if (action === "raise") console.log(await raiseAlert(type, rest.join(" ") || "(no message)"));
else console.log((await clearAlert(type)) ? "cleared" : "nothing open");

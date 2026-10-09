/** Final safety net for a workflow: pushes anything still uncommitted in the state directory (`STATE_GIT=1`). */
import { pushState } from "../src/state-sync.js";

console.log(pushState(process.argv[2] ?? "workflow run") ? "pushed" : "nothing to push");

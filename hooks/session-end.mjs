import { firstLine, logRun, readInput } from "./lib.mjs";
import { unregister } from "./messaging.mjs";

// The record comes out whatever messaging.enabled now says: the setting can change mid-session,
// and a record left behind would have `recall listen --status` reporting a session that is gone.
function run(input) {
  if (!input.session_id) return "messaging:no-session";
  unregister(input.session_id);
  return "messaging:unregistered";
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

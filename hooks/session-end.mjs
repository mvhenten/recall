import { firstLine, logRun, readInput, recallDetached } from "./lib.mjs";
import { unregister } from "./messaging.mjs";

// The record comes out whatever messaging.enabled now says: the setting can change mid-session,
// and a record left behind would have `recall listen --status` reporting a session that is gone.
// The service is told too, since a session is gone when its own host says so and nothing else can,
// but the telling is left to run: an unreachable service must not hold up the session's end.
function run(input) {
  if (!input.session_id) return "messaging:no-session";
  unregister(input.session_id);
  const ending = recallDetached(["sessions", "--end", input.session_id], input.cwd);
  return ending ? "messaging:unregistered" : "messaging:unregistered:not-installed";
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

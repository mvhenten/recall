import { firstLine, logRun, readInput, recallDetached } from "./lib.mjs";
import { unregister } from "./messaging.mjs";
import { prepareUsage } from "./usage.mjs";

// The closing stretch of the transcript is read here, so a session's last tokens are counted. The
// record is what carries that delta, so the arm that ends the session is also the one that takes
// the record out, whatever messaging.enabled now says; a host with no CLI to run drops the record
// here instead, since nothing else will, and a record left behind would have
// `recall listen --status` reporting a session that is gone. The service is told a session ended
// by its own host and by nothing else, but the telling is left to run: an unreachable service must
// not hold up the session's end.
function run(input) {
  if (!input.session_id) return "messaging:no-session";
  let usage;
  try {
    usage = prepareUsage(input.session_id, input.transcript_path);
  } catch (error) {
    usage = `failed:${firstLine(error.message)}`;
  }
  const ending = recallDetached(["sessions", "--end", input.session_id], input.cwd);
  if (!ending) unregister(input.session_id);
  return `messaging:${ending ? "ending" : "unregistered:not-installed"} usage:${usage}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

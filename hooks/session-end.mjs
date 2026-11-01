import { firstLine, logRun, readInput } from "./lib.mjs";
import { messagingEnabled, unregister } from "./messaging.mjs";

function run(input) {
  if (!messagingEnabled()) return "messaging:off";
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

import { firstLine, logRun, readInput, recall } from "./lib.mjs";
import { messagingEnabled, unregister } from "./messaging.mjs";

const TIMEOUT_MS = 4000;

async function run(input) {
  if (!messagingEnabled()) return "messaging:off";
  if (!input.session_id) return "messaging:no-session";
  unregister(input.session_id);
  const ended = await recall(["sessions", "--end", input.session_id], { cwd: input.cwd, timeout: TIMEOUT_MS });
  if (ended.ok) return "messaging:unregistered";
  return `messaging:unregistered:end-failed:${firstLine(ended.error)}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 3000;
const INSTALL_HINT = "recall CLI not found; install it from https://github.com/mvhenten/recall#install";

const COMMANDS = [
  "recall search [--any] [--tag <tag>] [--mode hybrid|vector|text] <query>: search by meaning; --any spans every scope",
  "recall get <name> | recall list [--since <time>] [--limit <n>]: print one memory in full, or list the newest",
  "recall save [file] [--global] | recall edit <name> | recall delete <name>: write, change or remove a memory",
  "recall repo | recall login | recall logout | recall devices: repo tag of this directory, sign in or out, list signed-in devices",
  "Add --json to any command for JSON output.",
];

function crib(repoTag) {
  const scope = repoTag ? `Current repo tag: ${repoTag} (searches also cover global).` : "Current scope: global only.";
  return [
    "recall is the durable memory store; local memory files are only a cache and may be missing. Query it directly:",
    ...COMMANDS.map((line) => `- ${line}`),
    scope,
  ].join("\n");
}

async function run(input) {
  const repo = await recall(["repo"], { cwd: input.cwd, timeout: TIMEOUT_MS });
  if (!repo.ok && repo.error.includes("recall CLI not found")) {
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: INSTALL_HINT } });
    return "not-installed";
  }
  const repoTag = repo.ok ? repo.stdout.trim() : "";
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: crib(repoTag) } });
  return repoTag ? "crib:repo" : "crib:global";
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

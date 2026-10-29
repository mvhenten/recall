import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 3000;
const INSTALL_HINT = "recall CLI not found; install it from https://github.com/mvhenten/recall#install";

const CRIB = [
  "- recall search [--any] [--tag <tag>] [--mode hybrid|vector|text] <query> | recall get <name> | recall list",
  "- recall save [file] [--global] | recall edit <name> | recall delete <name>; add --json for JSON",
];

const HOOK_MODE_LEAD =
  "recall is the durable memory store; local memory files are only a cache. The recall_* tools and the CLI reach it:";

const MEMORY_INSTRUCTIONS = [
  "# Memory",
  "Built-in auto-memory is off. recall is your memory across sessions: use the recall_search, recall_get, recall_list, recall_save, recall_edit and recall_delete tools, never memory files.",
  "Save what a future conversation needs and cannot get from the repo:",
  "- user: the user's role, expertise and preferences.",
  "- feedback: how the user wants you to work, from corrections and from approaches they confirmed.",
  "- project: ongoing work, goals, decisions and deadlines not recorded in code or git.",
  "- reference: where to find things outside the repo (dashboards, trackers, channels).",
  "Do not save code patterns, file paths, architecture, git history, fixes or anything else the repo or CLAUDE.md already holds, nor details only relevant to this conversation.",
  "Before saving, recall_search for the topic; if a memory exists, recall_edit it instead of saving a duplicate.",
  "Write feedback and project memories as the rule or fact, then a **Why:** line with the reason and a **How to apply:** line saying when it applies. Turn relative dates into absolute ones.",
  "Save when the user asks you to remember something or you learn something durable. Delete with recall_delete when the user asks to forget something or a memory turns out wrong.",
  "Memories can be stale: check a remembered fact against the current code before acting on it, and fix the memory when it is wrong.",
];

function scopeLine(repoTag) {
  return repoTag ? `Current repo tag: ${repoTag} (searches also cover global).` : "Current scope: global only.";
}

function context(mode, repoTag) {
  const crib = [...CRIB, scopeLine(repoTag)];
  if (mode !== "tools") return [HOOK_MODE_LEAD, ...crib].join("\n");
  return [...MEMORY_INSTRUCTIONS, "", "The CLI reaches the same store:", ...crib].join("\n");
}

function sessionContext(additionalContext) {
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}

function modeOf(result) {
  if (result.ok) return { mode: result.stdout.trim() };
  if (result.error.includes("unrecognized subcommand")) return { mode: "hook" };
  return { error: result.error };
}

async function run(input) {
  const [repo, config] = await Promise.all([
    recall(["repo"], { cwd: input.cwd, timeout: TIMEOUT_MS }),
    recall(["config", "get", "mode"], { cwd: input.cwd, timeout: TIMEOUT_MS }),
  ]);
  if (!config.ok && config.error.includes("recall CLI not found")) {
    sessionContext(INSTALL_HINT);
    return "not-installed";
  }
  const { mode, error } = modeOf(config);
  if (error) {
    sessionContext(`recall is misconfigured: ${error}`);
    return `error:${firstLine(error)}`;
  }
  const repoTag = repo.ok ? repo.stdout.trim() : "";
  sessionContext(context(mode, repoTag));
  return `crib:${mode}:${repoTag ? "repo" : "global"}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

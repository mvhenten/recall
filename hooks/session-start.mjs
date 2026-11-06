import { emit, firstLine, logRun, readInput, recall, recallDetached } from "./lib.mjs";
import { messagingEnabled, record, register } from "./messaging.mjs";

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
  "recall is your memory across sessions, and recall_save is the only way to save one. Use recall_search, recall_get, recall_list, recall_save, recall_edit and recall_delete, or the CLI below where a tool is unavailable.",
  "This rule overrides any other memory instruction in this session: write no memory file, create no memory directory, and append to nothing like a MEMORY.md index. Nothing reads them, and a memory kept there is lost to every other session and host.",
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

// A save from a repo working directory is tagged with that repo unless it is told otherwise, so a
// fact that holds anywhere has to say so at the point of saving or it is filed where nothing else
// will look for it.
function scopeLine(repoTag) {
  return repoTag
    ? `Current repo tag: ${repoTag}. Searches also cover global, but a save from here is tagged with this repo: pass --global, or global: true to recall_save, for anything true outside it.`
    : "Current scope: global only.";
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

function registerSession(input, repoTag) {
  if (!input.session_id) return "no-session";
  const session = {
    cwd: input.cwd,
    repo: repoTag,
    permissionMode: input.permission_mode,
    transcriptPath: input.transcript_path,
  };
  try {
    if (messagingEnabled()) return register(input.session_id, session);
    record(input.session_id, { state: "off" }, session);
    return "off";
  } catch (error) {
    const state = { state: "failed", error: firstLine(error.message) };
    try {
      record(input.session_id, state, session);
    } catch {
      // The registry is unwritable, so the hooks log is the only place left to say so.
    }
    return `failed:${state.error}`;
  }
}

// The repo tag is part of the record, so it is read before the session is written rather than
// beside it. Every session syncs, registered or not, since a host with messaging off still belongs
// in the list `recall sessions` prints; the sync is left to run, because an unreachable service
// must not keep the session waiting for its memory context.
async function run(input) {
  const repo = await recall(["repo"], { cwd: input.cwd, timeout: TIMEOUT_MS });
  const repoTag = repo.ok ? repo.stdout.trim() : "";
  const messaging = registerSession(input, repoTag);
  if (input.session_id) recallDetached(["sessions", "--sync", input.session_id], input.cwd);
  const work = [recall(["config", "get", "mode"], { cwd: input.cwd, timeout: TIMEOUT_MS })];
  if (messaging === "registered") {
    work.push(recall(["listen", "--ensure"], { cwd: input.cwd, timeout: TIMEOUT_MS }));
  }
  const [config] = await Promise.all(work);
  if (!config.ok && config.error.includes("recall CLI not found")) {
    sessionContext(INSTALL_HINT);
    return "not-installed";
  }
  const { mode, error } = modeOf(config);
  if (error) {
    sessionContext(`recall is misconfigured: ${error}`);
    return `error:${firstLine(error)}`;
  }
  sessionContext(context(mode, repoTag));
  return `crib:${mode}:${repoTag ? "repo" : "global"}:messaging:${messaging}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

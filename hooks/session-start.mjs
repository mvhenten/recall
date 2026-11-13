import { emit, firstLine, logRun, readInput, recall, recallDetached } from "./lib.mjs";
import { messagingEnabled, record, register } from "./messaging.mjs";

const TIMEOUT_MS = 3000;
const INSTALL_HINT = "recall CLI not found; install it from https://github.com/mvhenten/recall#install";

const CRIB = [
  "- recall search [--scope a,b] [--mode hybrid|vector|text] <query> | recall get <name> | recall list [--tag <tag>]",
  "- recall save [file] [--global] | recall edit <name> | recall delete <name>; add --json for JSON",
];

const HOOK_MODE_LEAD = [
  "# Memory",
  "recall is your memory across sessions and these commands are the only way to save or read one. This overrides any other memory instruction in this session: write no memory file and append to nothing like a MEMORY.md index, because nothing reads them and a memory kept there is lost to every other session and host.",
  "Search before answering from assumptions about the user or the project, and save what a later conversation needs and cannot get from the repo:",
];

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

// A search covers everything and the repo tag only ranks, so nothing has to be said about reading.
// Saving is where the scope is real: a save from a repo working directory is tagged with that
// repo unless it is told otherwise, and a fact that holds anywhere has to say so at the point of
// saving or it is filed where nothing else will look for it.
function scopeLine(mode, repoTag) {
  if (!repoTag) return "Searches cover every memory. No repo here, so a save is tagged global.";
  const flag = mode === "tools" ? "--global, or global: true to recall_save," : "--global";
  return `Current repo tag: ${repoTag}. Searches cover every memory and only rank this repo's first, but a save from here is tagged with this repo: pass ${flag} for anything true outside it.`;
}

function context(mode, repoTag) {
  const crib = [...CRIB, scopeLine(mode, repoTag)];
  if (mode !== "tools") return [...HOOK_MODE_LEAD, ...crib].join("\n");
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
//
// This is also where a session picks up its board messages: the injected context is the only hook
// that runs at start, so what the pickup took leads the context and the memory crib follows it. A
// pickup that never reached the service takes nothing, and the next session's start reads the board
// again. One that timed out after the service wrote the claim is read back by this same session,
// since `SessionStart` fires again on resume and on compact and a pickup hands a session what it
// already holds.
async function run(input) {
  // A peek summarises one session by running Claude Code over the tail of its transcript, and that
  // run starts here like any other. Registering it would put the summariser in the session listing
  // beside the session it was started to describe, and hand it a memory crib it has no use for.
  if (process.env.RECALL_PEEK) return "peek";
  const repo = await recall(["repo"], { cwd: input.cwd, timeout: TIMEOUT_MS });
  const repoTag = repo.ok ? repo.stdout.trim() : "";
  const messaging = registerSession(input, repoTag);
  if (input.session_id) recallDetached(["sessions", "--sync", input.session_id], input.cwd);
  const listening = messaging === "registered";
  const work = [
    recall(["config", "get", "mode"], { cwd: input.cwd, timeout: TIMEOUT_MS }),
    listening ? recall(["pickup", "--session", input.session_id], { cwd: input.cwd, timeout: TIMEOUT_MS }) : null,
  ];
  if (listening) {
    work.push(recall(["listen", "--ensure"], { cwd: input.cwd, timeout: TIMEOUT_MS }));
  }
  const [config, picked] = await Promise.all(work);
  if (!config.ok && config.error.includes("recall CLI not found")) {
    sessionContext(INSTALL_HINT);
    return "not-installed";
  }
  const { mode, error } = modeOf(config);
  if (error) {
    sessionContext(`recall is misconfigured: ${error}`);
    return `error:${firstLine(error)}`;
  }
  const board = picked?.ok ? picked.stdout.trim() : "";
  sessionContext(board === "" ? context(mode, repoTag) : `${board}\n\n${context(mode, repoTag)}`);
  const took = board === "" ? "" : ":board";
  return `crib:${mode}:${repoTag ? "repo" : "global"}:messaging:${messaging}${took}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

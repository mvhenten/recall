import { emit, firstLine, logRun, readInput, recall, recallDetached } from "./lib.mjs";
import { touch } from "./messaging.mjs";
import { MIN_SCORE, searchQuery, unseen } from "./query.mjs";
import { readShown, recordShown } from "./shown.mjs";
import { flushUsage } from "./usage.mjs";

const TIMEOUT_MS = 4000;
const MIN_WORDS = 3;

function entry({ name, type, tags, description }) {
  const shown = tags.filter((tag) => !tag.startsWith("source:")).join(", ");
  return `- ${name} (${type}; ${shown}): ${description}`;
}

function header(repoTag) {
  const scope = repoTag ? `${repoTag} + global` : "global only";
  return `Memories from recall that may be relevant to this prompt. Searched ${scope}. \`recall search --any "<query>"\` searches every memory; \`recall get <name>\` prints one in full. Read the full text of any that looks relevant before acting on it:`;
}

function contextBlock({ hits, elsewhere }, repoTag) {
  const lines = [header(repoTag), ...hits.map(({ memory }) => entry(memory))];
  if (elsewhere.length > 0) lines.push("In other scopes:", ...elsewhere.map(entry));
  return lines.join("\n");
}

async function repoTagOf(cwd) {
  const result = await recall(["repo"], { cwd, timeout: TIMEOUT_MS });
  return result.ok ? result.stdout.trim() : undefined;
}

// Every prompt moves the focus line on, including the ones too short to search on. The record is
// a local write; the sync behind it, and the usage delta the transcript has grown since the last
// one, are started and left to run, at most once every SYNC_INTERVAL_MS, because this hook's
// budget belongs to the prompt and not to the dashboard.
function refresh(input, prompt) {
  if (!input.session_id || !prompt) return "skipped";
  let touched;
  try {
    touched = touch(input.session_id, prompt, input.permission_mode);
  } catch (error) {
    return `failed:${firstLine(error.message)}`;
  }
  if (!touched) return "unregistered";
  if (!touched.due) return "throttled";
  const synced = recallDetached(["sessions", "--sync", input.session_id], input.cwd) ? "syncing" : "not-installed";
  return `${synced} usage:${flushUsage(input.session_id, input.transcript_path, input.cwd)}`;
}

async function memories(input, prompt) {
  if (prompt.startsWith("/")) return "skipped:slash-command";
  if (prompt.split(/\s+/).filter(Boolean).length < MIN_WORDS) return "skipped:short-prompt";

  const result = await recall(
    ["search", "--json", "--mode", "vector", "--limit", "5", `--min-score=${MIN_SCORE}`, "--", searchQuery(prompt)],
    {
      cwd: input.cwd,
      timeout: TIMEOUT_MS,
    },
  );
  if (!result.ok) {
    emit({ systemMessage: `recall unavailable: ${result.error}` });
    return result.timedOut ? "timeout" : `error:${firstLine(result.error)}`;
  }

  const parsed = JSON.parse(result.stdout);
  const shown = readShown(input.session_id);
  const found = unseen(Array.isArray(parsed) ? { hits: parsed, elsewhere: [] } : parsed, shown);
  if (found.hits.length === 0 && found.elsewhere.length === 0) return "no-hits";
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: contextBlock(found, await repoTagOf(input.cwd)),
    },
  });
  recordShown(input.session_id, [
    ...shown,
    ...found.hits.map(({ memory }) => memory.name),
    ...found.elsewhere.map(({ name }) => name),
  ]);
  return `hits=${found.hits.length} elsewhere=${found.elsewhere.length}`;
}

async function run(input) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const focus = refresh(input, prompt);
  return `${await memories(input, prompt)} focus:${focus}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

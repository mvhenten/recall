import { emit, firstLine, logRun, readInput, recall, recallDetached } from "./lib.mjs";
import { touch } from "./messaging.mjs";
import { MIN_SCORE, searchQuery, unseen } from "./query.mjs";
import { readShown, recordShown } from "./shown.mjs";
import { countUsage } from "./usage.mjs";

const TIMEOUT_MS = 4000;
const MIN_WORDS = 3;

function entry({ name, type, tags, description }) {
  const shown = tags.filter((tag) => !tag.startsWith("source:")).join(", ");
  return `- ${name} (${type}; ${shown}): ${description}`;
}

function header(repoTag) {
  const scope = repoTag ? `${repoTag} + global first` : "global first";
  return `Memories from recall that may be relevant to this prompt. Searched every memory, ${scope}. \`recall search "<query>"\` searches them deliberately; \`recall get <name>\` prints one in full. Read the full text of any that looks relevant before acting on it:`;
}

// One ranked list, so the ones from elsewhere are whatever sorted below the ones from here rather
// than a section held open for them. A prompt whose answer lives in another repo now gets it.
function contextBlock(hits, repoTag) {
  const here = hits.filter((hit) => hit.inScope);
  const elsewhere = hits.filter((hit) => !hit.inScope);
  const lines = [header(repoTag), ...here.map(entry)];
  if (elsewhere.length > 0) lines.push("In other scopes:", ...elsewhere.map(entry));
  return lines.join("\n");
}

async function repoTagOf(cwd) {
  const result = await recall(["repo"], { cwd, timeout: TIMEOUT_MS });
  return result.ok ? result.stdout.trim() : undefined;
}

// Every prompt moves the focus line on, including the ones too short to search on. The record and
// the usage delta the transcript has grown since the last sync are local writes; the sync that
// carries both is started and left to run, at most once every SYNC_INTERVAL_MS, because this
// hook's budget belongs to the prompt and not to the dashboard.
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
  const usage = countUsage(input.session_id, input.transcript_path);
  const synced = recallDetached(["sessions", "--sync", input.session_id], input.cwd) ? "syncing" : "not-installed";
  return `${synced} usage:${usage}`;
}

async function memories(input, prompt) {
  if (prompt.startsWith("/")) return "skipped:slash-command";
  if (prompt.split(/\s+/).filter(Boolean).length < MIN_WORDS) return "skipped:short-prompt";

  const result = await recall(
    ["inject", "--json", "--limit", "5", `--min-score=${MIN_SCORE}`, "--", searchQuery(prompt)],
    {
      cwd: input.cwd,
      timeout: TIMEOUT_MS,
    },
  );
  if (!result.ok) {
    // A host whose CLI predates `recall inject` has nothing to say about it. The Worker deploys on
    // merge and hosts update whenever they next do, so this window is every prompt on every host
    // behind, and a banner on each of them is noise about a state the person cannot act on from
    // here. `recall search` still refuses an old binary loudly, which is where they find out.
    if (result.error.includes("unrecognized subcommand")) return "skipped:old-cli";
    emit({ systemMessage: `recall unavailable: ${result.error}` });
    return result.timedOut ? "timeout" : `error:${firstLine(result.error)}`;
  }

  const shown = readShown(input.session_id);
  const found = unseen(JSON.parse(result.stdout).hits, shown);
  if (found.length === 0) return "no-hits";
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: contextBlock(found, await repoTagOf(input.cwd)),
    },
  });
  recordShown(input.session_id, [...shown, ...found.map(({ name }) => name)]);
  return `hits=${found.length} elsewhere=${found.filter((hit) => !hit.inScope).length}`;
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

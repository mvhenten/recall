import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 4000;
const MIN_WORDS = 3;
// bge-small-en-v1.5 accepts 512 tokens; 2000 chars is about that
const MAX_QUERY_CHARS = 2000;

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`;
}

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

async function run(input) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.startsWith("/")) return "skipped:slash-command";
  if (prompt.split(/\s+/).filter(Boolean).length < MIN_WORDS) return "skipped:short-prompt";

  const result = await recall(["search", "--json", "--limit", "5", "--", truncate(prompt, MAX_QUERY_CHARS)], {
    cwd: input.cwd,
    timeout: TIMEOUT_MS,
  });
  if (!result.ok) {
    emit({ systemMessage: `recall unavailable: ${result.error}` });
    return result.timedOut ? "timeout" : `error:${firstLine(result.error)}`;
  }

  const parsed = JSON.parse(result.stdout);
  const found = Array.isArray(parsed) ? { hits: parsed, elsewhere: [] } : parsed;
  if (found.hits.length === 0 && found.elsewhere.length === 0) return "no-hits";
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: contextBlock(found, await repoTagOf(input.cwd)),
    },
  });
  return `hits=${found.hits.length} elsewhere=${found.elsewhere.length}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

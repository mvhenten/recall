import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 4000;
const MIN_WORDS = 3;
// bge-small-en-v1.5 accepts 512 tokens; 2000 chars is about that
const MAX_QUERY_CHARS = 2000;
const HEADER =
  "Memories from recall that may be relevant to this prompt. For the full text of any that looks relevant, run `recall get <name>` before acting on it:";

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`;
}

function entry({ memory }) {
  return `- ${memory.name} (${memory.type}; ${memory.tags.join(", ")}): ${memory.description}`;
}

function contextBlock(hits) {
  return [HEADER, ...hits.map(entry)].join("\n");
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

  const hits = JSON.parse(result.stdout);
  if (hits.length === 0) return "no-hits";
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: contextBlock(hits) } });
  return `hits=${hits.length}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

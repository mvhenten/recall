import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 4000;
const MIN_WORDS = 3;
const MAX_QUERY_CHARS = 2000;
const MAX_BODY_CHARS = 1200;
const MAX_CONTEXT_BYTES = 4096;

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`;
}

function format(memory) {
  const tags = memory.tags.join(", ");
  return `### ${memory.name} (${memory.type}; ${tags})\n${memory.description}\n\n${truncate(memory.body.trim(), MAX_BODY_CHARS)}`;
}

function contextBlock(hits) {
  let block = "Memories from recall that may be relevant to this prompt:";
  for (const { memory } of hits) {
    const entry = `\n\n${format(memory)}`;
    if (Buffer.byteLength(block + entry) > MAX_CONTEXT_BYTES) break;
    block += entry;
  }
  return block;
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

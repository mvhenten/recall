import { emit, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 2000;
const MIN_WORDS = 3;
const MAX_QUERY_CHARS = 2000;
const MAX_BODY_CHARS = 1200;
const MAX_CONTEXT_BYTES = 4096;

function truncate(text, max, suffix = " …") {
  return text.length <= max ? text : `${text.slice(0, max - suffix.length).trimEnd()}${suffix}`;
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

const input = await readInput();
const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
if (prompt.startsWith("/") || prompt.split(/\s+/).filter(Boolean).length < MIN_WORDS) process.exit(0);

const result = await recall(["search", "--json", "--limit", "5", "--", truncate(prompt, MAX_QUERY_CHARS, "")], {
  cwd: input.cwd,
  timeout: TIMEOUT_MS,
});
if (!result.ok) {
  emit({ systemMessage: `recall unavailable: ${result.error}` });
  process.exit(0);
}

const hits = JSON.parse(result.stdout);
if (hits.length === 0) process.exit(0);
emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: contextBlock(hits) } });

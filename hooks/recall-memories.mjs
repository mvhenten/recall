import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 4000;
const MIN_WORDS = 3;
// bge-small-en-v1.5 accepts 512 tokens; 2000 chars is about that
const MAX_QUERY_CHARS = 2000;
const MAX_BODY_CHARS = 1200;
const MAX_CONTEXT_BYTES = 4096;
const HEADER = "Memories from recall that may be relevant to this prompt:";
const GET_HINT = "Run `recall get <name>` to read the full text of any memory below.";

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`;
}

function heading(memory) {
  return `### ${memory.name} (${memory.type}; ${memory.tags.join(", ")})\n${memory.description}`;
}

function fullEntry(memory) {
  const body = memory.body.trim();
  if (body.length <= MAX_BODY_CHARS) return `${heading(memory)}\n\n${body}`;
  return `${heading(memory)}\n\n${body.slice(0, MAX_BODY_CHARS).trimEnd()} …\n[truncated, full text: recall get ${memory.name}]`;
}

function stubEntry(memory) {
  return `${heading(memory)}\n[not shown, full text: recall get ${memory.name}]`;
}

function byteLength(text) {
  return Buffer.byteLength(text);
}

function contextBlock(hits) {
  const memories = hits.map(({ memory }) => memory);
  const stubs = memories.map((memory) => `\n\n${stubEntry(memory)}`);
  let block = `${HEADER}\n\n${GET_HINT}`;
  memories.forEach((memory, index) => {
    const full = `\n\n${fullEntry(memory)}`;
    const reservedForRest = stubs.slice(index + 1).reduce((total, stub) => total + byteLength(stub), 0);
    const fits = byteLength(block + full) + reservedForRest <= MAX_CONTEXT_BYTES;
    block += fits ? full : stubs[index];
  });
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

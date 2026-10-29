import path from "node:path";
import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";
import { GLOBAL_TYPES, isMemoryFile, isMemoryIndex, memoryType, resolveReal } from "./memory-files.mjs";

const TIMEOUT_MS = 5000;
const INDEX_REASON = "recall needs no index; memories are found by search.";

function decide(permissionDecision, permissionDecisionReason, extra = {}) {
  emit({
    ...extra,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
  });
}

async function saveArgs(name, content, input, started) {
  const args = ["--json", "save", "--name", name];
  if (GLOBAL_TYPES.has(memoryType(content))) return [...args, "--global"];
  const repo = await recall(["repo"], { cwd: input.cwd, timeout: TIMEOUT_MS - (Date.now() - started) });
  return repo.ok ? args : [...args, "--global"];
}

async function save(name, content, input) {
  const started = Date.now();
  const args = await saveArgs(name, content, input, started);
  const timeout = Math.max(TIMEOUT_MS - (Date.now() - started), 500);
  const saved = await recall(args, { cwd: input.cwd, timeout, input: content });
  if (!saved.ok) return saved;
  return { ok: true, tags: JSON.parse(saved.stdout).memory.tags };
}

async function run(input) {
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string") return "skipped";
  const file = resolveReal(filePath);

  if (isMemoryIndex(file)) {
    decide("deny", INDEX_REASON);
    return "redirect:index";
  }
  if (!isMemoryFile(file)) return "skipped";

  const name = path.basename(file, ".md");
  if (input.tool_name !== "Write") {
    decide(
      "deny",
      `Memories live in recall: use \`recall edit ${name}\` (or \`recall get ${name}\` then \`recall save\`).`,
    );
    return "redirect:edit";
  }

  const saved = await save(name, String(input.tool_input.content ?? ""), input);
  if (!saved.ok) {
    const error = firstLine(saved.error);
    decide("allow", `recall save failed; writing ${name} locally instead.`, {
      systemMessage: `recall: saving memory ${name} failed, so it was kept locally: ${error}`,
    });
    return `redirect:fallback:${error}`;
  }
  decide(
    "deny",
    `Saved to recall as ${name} [${saved.tags.join(", ")}]. Local memory files are not used; read with \`recall get ${name}\`, change with \`recall edit ${name}\`.`,
  );
  return `redirect:saved:${name}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

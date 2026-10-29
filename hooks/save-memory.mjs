import { readFileSync } from "node:fs";
import path from "node:path";
import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";
import { GLOBAL_TYPES, isMemoryFile, memoryType, resolveReal } from "./memory-files.mjs";

const TIMEOUT_MS = 5000;

async function run(input) {
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string") return "skipped";
  const file = resolveReal(filePath);
  if (!isMemoryFile(file)) return "skipped";

  const started = Date.now();
  const name = path.basename(file, ".md");
  const args = ["save", file];
  if (GLOBAL_TYPES.has(memoryType(readFileSync(file, "utf8")))) {
    args.push("--global");
  } else {
    const repo = await recall(["repo"], { cwd: input.cwd, timeout: TIMEOUT_MS });
    if (!repo.ok) args.push("--global");
  }

  const saved = await recall(args, { cwd: input.cwd, timeout: Math.max(TIMEOUT_MS - (Date.now() - started), 500) });
  if (!saved.ok) {
    emit({ systemMessage: `recall: memory ${name} was saved locally but not synced: ${saved.error}` });
    return `error:${firstLine(saved.error)}`;
  }
  return `saved:${name}`;
}

const started = Date.now();
const input = await readInput();
try {
  logRun(input.session_id, await run(input), started);
} catch (error) {
  logRun(input.session_id, `error:${firstLine(error.message)}`, started);
  throw error;
}

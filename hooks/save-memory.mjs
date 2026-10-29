import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { emit, firstLine, logRun, readInput, recall } from "./lib.mjs";

const TIMEOUT_MS = 5000;
const GLOBAL_TYPES = new Set(["user", "feedback"]);

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function resolveReal(file) {
  try {
    return realpathSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return path.resolve(file);
    throw error;
  }
}

function expandHome(dir) {
  return dir === "~" || dir.startsWith("~/") ? path.join(homedir(), dir.slice(1)) : dir;
}

function configuredMemoryDir(configDir) {
  const settings = readOptional(path.join(configDir, "settings.json"));
  const dir = settings ? JSON.parse(settings).autoMemoryDirectory : undefined;
  return typeof dir === "string" && dir ? resolveReal(expandHome(dir)) : undefined;
}

function inside(dir, file) {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isMemoryFile(file) {
  if (!file.endsWith(".md") || path.basename(file) === "MEMORY.md") return false;
  const configDir = resolveReal(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"));
  const memoryDir = configuredMemoryDir(configDir);
  if (memoryDir) return inside(memoryDir, file);
  const relative = path.relative(path.join(configDir, "projects"), file).split(path.sep);
  return relative.length >= 3 && relative[0] !== ".." && relative[1] === "memory";
}

function memoryType(text) {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const type = header?.[1]?.match(/^\s*type:\s*["']?([a-z]+)/m);
  return type?.[1];
}

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

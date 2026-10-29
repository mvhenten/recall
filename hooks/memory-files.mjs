import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const GLOBAL_TYPES = new Set(["user", "feedback"]);

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function resolveReal(file) {
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

function inMemoryDir(file) {
  if (!file.endsWith(".md")) return false;
  const configDir = resolveReal(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"));
  const memoryDir = configuredMemoryDir(configDir);
  if (memoryDir) return inside(memoryDir, file);
  const relative = path.relative(path.join(configDir, "projects"), file).split(path.sep);
  return relative.length >= 3 && relative[0] !== ".." && relative[1] === "memory";
}

export function isMemoryIndex(file) {
  return path.basename(file) === "MEMORY.md" && inMemoryDir(file);
}

export function isMemoryFile(file) {
  return path.basename(file) !== "MEMORY.md" && inMemoryDir(file);
}

export function memoryType(text) {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const type = header?.[1]?.match(/^\s*type:\s*["']?([a-z]+)/m);
  return type?.[1];
}

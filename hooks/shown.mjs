import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "./lib.mjs";

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function sessionsDir() {
  return path.join(stateDir(), "sessions");
}

function sessionFile(sessionId) {
  return path.join(sessionsDir(), `${path.basename(sessionId)}.json`);
}

export function readShown(sessionId) {
  if (!sessionId) return new Set();
  const file = sessionFile(sessionId);
  return new Set(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
}

function pruneStale(dir) {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
  }
}

export function recordShown(sessionId, shown) {
  if (!sessionId) return;
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(sessionFile(sessionId), JSON.stringify([...shown]));
  pruneStale(dir);
}

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export function configFile(env = process.env) {
  if (env.RECALL_CONFIG_FILE) return env.RECALL_CONFIG_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(configHome, "recall", "config.json");
}

// Read here rather than through `recall config get`: SessionStart has a five second budget and
// already spawns the CLI twice.
export function messagingEnabled(env = process.env) {
  try {
    return JSON.parse(readFileSync(configFile(env), "utf8")).messaging_enabled === true;
  } catch {
    return false;
  }
}

// Mirrors runtime_dir() in cli/src/listen.rs; the daemon reads what these hooks write.
export function runtimeDir(env = process.env, uid = process.getuid()) {
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "recall") : path.join(tmpdir(), `recall-${uid}`);
}

export function sessionsDir(env = process.env, uid = process.getuid()) {
  return path.join(runtimeDir(env, uid), "sessions");
}

export function registryPath(sessionId, env = process.env, uid = process.getuid()) {
  return path.join(sessionsDir(env, uid), `${sessionId}.json`);
}

// Absent means Claude's cross-session inbox is gated off for this account, which is a no-op and
// never an error.
export function inbox(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socket || !token) return undefined;
  return { socket, token, pid: Number(env.CLAUDE_PID) || process.ppid };
}

export function register(sessionId, cwd, env = process.env, uid = process.getuid()) {
  const session = inbox(env);
  if (!session) return false;
  const dir = sessionsDir(env, uid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = registryPath(sessionId, env, uid);
  writeFileSync(file, `${JSON.stringify({ ...session, cwd: cwd || process.cwd() })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return true;
}

export function unregister(sessionId, env = process.env, uid = process.getuid()) {
  const file = registryPath(sessionId, env, uid);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

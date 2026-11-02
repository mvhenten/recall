import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  if (env.RECALL_MESSAGING_ENABLED) return env.RECALL_MESSAGING_ENABLED === "true";
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
// never an error. The socket is named for the Claude process that owns it, and that pid is the
// one the daemon checks for liveness; the hook's own parent is a shell that exits immediately.
function inbox(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  const pid = Number(path.basename(socket ?? "", ".sock"));
  if (!socket || !token || !pid) return undefined;
  return { socket, token, pid };
}

// The registry is the one record of what became of a session, so a session the hook passed over
// gets a file too, carrying the state and no inbox. `recall listen --status` reads them all; the
// daemon delivers only to the ones carrying a socket.
export function record(sessionId, state, cwd, env = process.env, uid = process.getuid()) {
  const dir = sessionsDir(env, uid);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const file = registryPath(sessionId, env, uid);
  writeFileSync(file, `${JSON.stringify({ ...state, cwd })}\n`);
  chmodSync(file, 0o600);
}

export function register(sessionId, cwd, env = process.env, uid = process.getuid()) {
  const session = inbox(env);
  const state = session ? { state: "registered", ...session } : { state: "no-inbox" };
  record(sessionId, state, cwd, env, uid);
  return state.state;
}

export function unregister(sessionId, env = process.env, uid = process.getuid()) {
  rmSync(registryPath(sessionId, env, uid), { force: true });
}

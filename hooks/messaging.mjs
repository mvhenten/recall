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
// never an error. The socket is named for the Claude process that owns it.
function inbox(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  const pid = Number(path.basename(socket ?? "", ".sock"));
  if (!socket || !token || !pid) return undefined;
  return { pid, inbox: { socket, token } };
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);

function procStatus(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return {
    comm: readFileSync(`/proc/${pid}/comm`, "utf8").trim(),
    ppid: Number(status.match(/^PPid:\s+(\d+)$/m)[1]),
  };
}

// Claude runs each hook through a shell that exits the moment the hook does, so the hook's own
// parent is no liveness handle at all. The first ancestor that is not a shell is the Claude
// process that owns the session, and it is the same pid the inbox socket is named for.
function ancestorPid() {
  let pid = process.ppid;
  try {
    for (let hop = 0; hop < 8 && pid > 1; hop += 1) {
      const { comm, ppid } = procStatus(pid);
      if (!SHELLS.has(comm)) return pid;
      pid = ppid;
    }
  } catch {
    // Without procfs there is no chain to walk, so the record keeps the pid reached so far. A pid
    // that outlives the session only delays the record's removal; it never removes a live one.
  }
  return pid;
}

// The pid the daemon checks to decide a session is gone, for every state: a skipped session has no
// socket to take it from, so its Claude process is found by walking up from the hook.
export function sessionPid(env = process.env) {
  return inbox(env)?.pid ?? ancestorPid();
}

// The registry is the one record of what became of a session, so a session the hook passed over
// gets a file too, carrying the state and no inbox. `recall listen --status` reads them all; the
// daemon delivers only to the ones carrying a socket.
export function record(sessionId, state, cwd, env = process.env, uid = process.getuid()) {
  const dir = sessionsDir(env, uid);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const file = registryPath(sessionId, env, uid);
  writeFileSync(file, `${JSON.stringify({ ...state, pid: sessionPid(env), cwd })}\n`);
  chmodSync(file, 0o600);
}

export function register(sessionId, cwd, env = process.env, uid = process.getuid()) {
  const found = inbox(env);
  const state = found ? { state: "registered", ...found.inbox } : { state: "no-inbox" };
  record(sessionId, state, cwd, env, uid);
  return state.state;
}

export function unregister(sessionId, env = process.env, uid = process.getuid()) {
  rmSync(registryPath(sessionId, env, uid), { force: true });
}

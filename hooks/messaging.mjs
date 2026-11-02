import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import { truncate } from "./focus.mjs";
import { isoNow } from "./lib.mjs";

const GIT_TIMEOUT_MS = 2000;

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

// One git call for both the branch and the last subject. %D decorates the tip with "HEAD -> " and
// the branch it points at; a detached head, a repo with no commits and no repo at all give "".
export function head(cwd) {
  try {
    const shown = execFileSync("git", ["-C", cwd, "log", "-1", "--no-color", "--format=%D%n%s"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
    const refs = shown[0] ?? "";
    const pointer = refs.split(", ").find((ref) => ref.startsWith("HEAD -> "));
    return { branch: pointer ? pointer.slice("HEAD -> ".length) : "", commit: (shown[1] ?? "").trim() };
  } catch {
    return { branch: "", commit: "" };
  }
}

// `claude -p` runs headless. The Claude process is the one the inbox socket is named for, not the
// hook's own parent, which is the shell Claude ran the hook command with.
export function invocation(pid) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return argv.includes("-p") || argv.includes("--print") ? "headless" : "interactive";
  } catch {
    return "";
  }
}

function read(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function write(file, record) {
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  chmodSync(file, 0o600);
}

export function register(sessionId, cwd, repo, permissionMode, env = process.env, uid = process.getuid()) {
  const session = inbox(env);
  if (!session) return false;
  const dir = sessionsDir(env, uid);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const now = isoNow();
  write(registryPath(sessionId, env, uid), {
    ...session,
    sessionId,
    host: hostname(),
    cwd,
    repo: repo ?? "",
    ...head(cwd),
    startedAt: now,
    lastActivityAt: now,
    prompts: 0,
    focus: { first: "", latest: "" },
    mode: invocation(session.pid),
    permissionMode: permissionMode ?? "",
  });
  return true;
}

// Each prompt counts, moves the focus on and marks the session active. The branch, the commit and
// the permission mode all change under a running session, so they are read again here.
export function touch(sessionId, prompt, permissionMode, env = process.env, uid = process.getuid()) {
  const file = registryPath(sessionId, env, uid);
  const record = read(file);
  if (!record) return false;
  const latest = truncate(prompt);
  write(file, {
    ...record,
    ...head(record.cwd),
    lastActivityAt: isoNow(),
    prompts: (record.prompts ?? 0) + 1,
    focus: { first: record.focus?.first || latest, latest },
    permissionMode: permissionMode ?? "",
  });
  return true;
}

export function unregister(sessionId, env = process.env, uid = process.getuid()) {
  rmSync(registryPath(sessionId, env, uid), { force: true });
}

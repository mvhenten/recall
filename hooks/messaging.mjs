import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";

export const FOCUS_PART_CHARS = 72;
export const SYNC_INTERVAL_MS = 30_000;
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

// A prompt cut to what one terminal row can hold. The focus line is the first prompt and the
// latest; no model is involved.
export function truncate(text, max = FOCUS_PART_CHARS) {
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
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
    const pointer = (shown[0] ?? "").split(", ").find((ref) => ref.startsWith("HEAD -> "));
    return { branch: pointer ? pointer.slice("HEAD -> ".length) : "", commit: (shown[1] ?? "").trim() };
  } catch {
    return { branch: "", commit: "" };
  }
}

// `claude -p` runs headless. The process to read is the one that owns the session, not the hook's
// own parent, which is the shell Claude ran the hook command with.
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

export function readRecord(sessionId, env = process.env, uid = process.getuid()) {
  return read(registryPath(sessionId, env, uid));
}

export function writeRecord(sessionId, document, env = process.env, uid = process.getuid()) {
  const file = registryPath(sessionId, env, uid);
  writeFileSync(file, `${JSON.stringify(document)}\n`);
  chmodSync(file, 0o600);
}

function size(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// Where the usage reader picks the transcript up. A session carried on in the same file — a resume,
// a restart, a clear — keeps the offset this host already counted from. Anything else starts at
// the file's end: what came before was counted by the run that wrote it. The chunk numbers already
// spent come along whatever the transcript, since they are the session's and may never be reused,
// and the prompt mark starts at nothing because the prompt count does.
function transcript(stored, transcriptPath) {
  const spent = { usageHighWater: stored?.usageHighWater ?? 0, usagePrompts: 0 };
  if (!transcriptPath) return { ...spent, transcriptPath: "", usageOffset: 0, usageMessageId: "" };
  if (stored?.transcriptPath === transcriptPath && Number.isInteger(stored.usageOffset)) {
    return {
      ...spent,
      transcriptPath,
      usageOffset: stored.usageOffset,
      usageMessageId: stored.usageMessageId ?? "",
      usagePending: stored.usagePending,
    };
  }
  return { ...spent, transcriptPath, usageOffset: size(transcriptPath), usageMessageId: "" };
}

// The registry is the one record of what became of a session, so a session the hook passed over
// gets a file too, carrying the state and no inbox. `recall listen --status` reads them all, the
// daemon delivers only to the ones carrying a socket, and `recall sessions --sync` sends the rest
// of the document to the service, whatever the state, so every host's sessions are listed.
export function record(sessionId, state, session, env = process.env, uid = process.getuid()) {
  const { cwd, repo, permissionMode, transcriptPath } = session;
  const dir = sessionsDir(env, uid);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const stored = readRecord(sessionId, env, uid);
  const pid = sessionPid(env);
  const now = Date.now();
  writeRecord(
    sessionId,
    {
      ...state,
      pid,
      cwd,
      sessionId,
      host: hostname(),
      repo: repo ?? "",
      ...head(cwd),
      startedAt: now,
      lastActivityAt: now,
      syncStartedAt: 0,
      prompts: 0,
      focus: { first: "", latest: "" },
      mode: invocation(pid),
      permissionMode: permissionMode ?? "",
      ...transcript(stored, transcriptPath),
    },
    env,
    uid,
  );
}

function inboxState(env) {
  const found = inbox(env);
  return found ? { state: "registered", ...found.inbox } : { state: "no-inbox" };
}

export function register(sessionId, session, env = process.env, uid = process.getuid()) {
  const state = inboxState(env);
  record(sessionId, state, session, env, uid);
  return state.state;
}

// A record `recall sessions --adopt` wrote carries a state no hook set, and the daemon keeps
// rewriting that record from the transcript for as long as it does. The first prompt a current
// hook sees takes the session back: the state becomes this session's own, the pid becomes the one
// the hook can see, and the daemon leaves the record alone from there on.
function taken(stored, env) {
  if (stored.state !== "adopted") return undefined;
  const state = messagingEnabled(env) ? inboxState(env) : { state: "off" };
  return { ...state, pid: sessionPid(env) };
}

// Each prompt counts, moves the focus on and marks the session active. The branch, the commit and
// the permission mode all change under a running session, so they are read again here. `due` says
// whether the caller should fire a sync: at most one every SYNC_INTERVAL_MS, and the stamp goes in
// before the spawn, because the hook never learns whether the sync it started arrived.
export function touch(sessionId, prompt, permissionMode, env = process.env, uid = process.getuid()) {
  const stored = readRecord(sessionId, env, uid);
  if (!stored) return undefined;
  const now = Date.now();
  const due = now - (stored.syncStartedAt ?? 0) >= SYNC_INTERVAL_MS;
  const latest = truncate(prompt);
  writeRecord(
    sessionId,
    {
      ...stored,
      ...taken(stored, env),
      ...head(stored.cwd),
      lastActivityAt: now,
      syncStartedAt: due ? now : stored.syncStartedAt,
      prompts: (stored.prompts ?? 0) + 1,
      focus: { first: stored.focus?.first || latest, latest },
      permissionMode: permissionMode ?? "",
    },
    env,
    uid,
  );
  return { due };
}

export function unregister(sessionId, env = process.env, uid = process.getuid()) {
  rmSync(registryPath(sessionId, env, uid), { force: true });
}

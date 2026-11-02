import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FOCUS_PART_CHARS,
  head,
  messagingEnabled,
  record,
  register,
  registryPath,
  runtimeDir,
  SYNC_INTERVAL_MS,
  sessionPid,
  sessionsDir,
  touch,
  truncate,
  unregister,
} from "./messaging.mjs";

const INBOX = {
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/42.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "t-inbox",
};

const REPO = "repo:github.com/mvhenten/recall";

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-hooks-"));
  return { dir, env: { ...INBOX, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_RUNTIME_DIR: path.join(dir, "run") } };
}

function repository(dir, subject) {
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, ".git"))) git("init", "-q", "-b", "work");
  git("commit", "-q", "--allow-empty", "-m", subject);
  return dir;
}

test("messaging stays off until the config file turns it on", () => {
  const { dir, env } = sandbox();
  assert.equal(messagingEnabled(env), false);

  const configDir = path.join(env.XDG_CONFIG_HOME, "recall");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "config.json"), '{"mode":"hook"}\n');
  assert.equal(messagingEnabled(env), false);

  writeFileSync(path.join(configDir, "config.json"), '{"mode":"hook","messaging_enabled":true}\n');
  assert.equal(messagingEnabled(env), true);

  writeFileSync(path.join(configDir, "config.json"), "not json\n");
  assert.equal(messagingEnabled(env), false);

  assert.equal(messagingEnabled({ ...env, RECALL_MESSAGING_ENABLED: "true" }), true);
  writeFileSync(path.join(configDir, "config.json"), '{"messaging_enabled":true}\n');
  assert.equal(messagingEnabled({ ...env, RECALL_MESSAGING_ENABLED: "false" }), false);

  rmSync(dir, { recursive: true, force: true });
});

test("a session registers one document the daemon and recall sessions both read", () => {
  const { dir, env } = sandbox();
  assert.equal(sessionsDir(env), path.join(env.XDG_RUNTIME_DIR, "recall", "sessions"));
  assert.equal(runtimeDir({}, 1000), path.join(tmpdir(), "recall-1000"));

  const cwd = repository(path.join(dir, "work"), "feat(sessions): list every host's sessions");
  assert.equal(register("s-1", cwd, REPO, "acceptEdits", env), "registered");
  const file = registryPath("s-1", env);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(stored, {
    state: "registered",
    socket: INBOX.CLAUDE_CODE_MESSAGING_SOCKET,
    token: INBOX.CLAUDE_CODE_MESSAGING_TOKEN,
    pid: 42,
    sessionId: "s-1",
    host: hostname(),
    cwd,
    repo: REPO,
    branch: "work",
    commit: "feat(sessions): list every host's sessions",
    startedAt: stored.startedAt,
    lastActivityAt: stored.startedAt,
    syncStartedAt: 0,
    prompts: 0,
    focus: { first: "", latest: "" },
    mode: stored.mode,
    permissionMode: "acceptEdits",
  });
  assert.equal(Math.abs(Date.now() - stored.startedAt) < 60_000, true, "the start is epoch milliseconds");
  assert.equal(sessionPid(env), 42, "a registered session takes its pid from the socket name");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(sessionsDir(env)).mode & 0o777, 0o700);

  unregister("s-1", env);
  assert.equal(existsSync(file), false);
  unregister("s-1", env);

  rmSync(dir, { recursive: true, force: true });
});

test("a session the hook passed over is recorded with the reason, a live pid and no inbox", () => {
  const { dir, env } = sandbox();
  const noInbox = { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR };

  assert.equal(register("s-2", "/tmp", REPO, "default", noInbox), "no-inbox");
  const skipped = JSON.parse(readFileSync(registryPath("s-2", env), "utf8"));
  assert.deepEqual(
    { state: skipped.state, cwd: skipped.cwd, repo: skipped.repo },
    { state: "no-inbox", cwd: "/tmp", repo: REPO },
  );
  assert.equal(existsSync(`/proc/${skipped.pid}`), true, "the recorded pid outlives the hook");

  const parentSocket = { ...env, CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/parent.sock" };
  assert.equal(register("s-3", "/tmp", REPO, "default", parentSocket), "no-inbox");

  record("s-4", { state: "off" }, "/tmp", "", "default", env);
  assert.equal(JSON.parse(readFileSync(registryPath("s-4", env), "utf8")).state, "off");

  record("s-5", { state: "failed", error: "EACCES, permission denied" }, "/tmp", "", "default", env);
  const failed = JSON.parse(readFileSync(registryPath("s-5", env), "utf8"));
  assert.deepEqual(
    { state: failed.state, error: failed.error, cwd: failed.cwd },
    { state: "failed", error: "EACCES, permission denied", cwd: "/tmp" },
  );
  assert.equal(statSync(registryPath("s-5", env)).mode & 0o777, 0o600);

  rmSync(dir, { recursive: true, force: true });
});

test("each prompt counts, moves the focus on and reads the head again", () => {
  const { dir, env } = sandbox();
  const cwd = repository(path.join(dir, "work"), "chore: start");
  const first = `${"why does the deploy time out ".repeat(10)}on stage two`;

  assert.equal(touch("s-1", "anything", "default", env), undefined, "with no record there is nothing to move on");
  register("s-1", cwd, REPO, "default", env);
  const read = () => JSON.parse(readFileSync(registryPath("s-1", env), "utf8"));
  const started = read().startedAt;

  assert.deepEqual(touch("s-1", first, "default", env), { due: true }, "the first prompt owes a sync");
  assert.equal(read().focus.first, truncate(first));
  assert.equal(read().focus.latest, truncate(first));
  assert.equal(read().prompts, 1);
  assert.equal(read().syncStartedAt >= started, true);

  repository(cwd, "fix(sessions): keep the first prompt");
  assert.deepEqual(touch("s-1", "why is CI red", "plan", env), { due: false }, "a sync has just gone out");
  const stored = read();
  assert.equal(stored.focus.first, truncate(first));
  assert.equal(stored.focus.latest, "why is CI red");
  assert.equal(stored.prompts, 2);
  assert.equal(stored.commit, "fix(sessions): keep the first prompt");
  assert.equal(stored.permissionMode, "plan");
  assert.equal(stored.startedAt, started);
  assert.equal(stored.lastActivityAt >= started, true);
  assert.equal(stored.token, INBOX.CLAUDE_CODE_MESSAGING_TOKEN);
  assert.equal(statSync(registryPath("s-1", env)).mode & 0o777, 0o600);

  writeFileSync(
    registryPath("s-1", env),
    JSON.stringify({ ...stored, syncStartedAt: Date.now() - SYNC_INTERVAL_MS - 1 }),
  );
  assert.deepEqual(touch("s-1", "ship it", "plan", env), { due: true }, "the throttle window has passed");

  rmSync(dir, { recursive: true, force: true });
});

test("a prompt is cut to a focus line that fits on one row", () => {
  assert.equal(truncate(`${"x".repeat(200)}!`), `${"x".repeat(FOCUS_PART_CHARS - 1)}…`);
  assert.equal(truncate("  ship\n  it  "), "ship it");
  assert.equal(truncate("x".repeat(FOCUS_PART_CHARS)), "x".repeat(FOCUS_PART_CHARS));

  const long = `${"why does the deploy time out ".repeat(10)}on stage two`;
  assert.equal(truncate(long).length <= FOCUS_PART_CHARS, true);
  assert.equal(truncate(long).endsWith("…"), true);
});

test("the head reads empty rather than guessing", () => {
  const { dir } = sandbox();

  assert.deepEqual(head(path.join(dir, "not-a-repo")), { branch: "", commit: "" });
  assert.deepEqual(head(repository(path.join(dir, "work"), "chore: start")), {
    branch: "work",
    commit: "chore: start",
  });

  rmSync(dir, { recursive: true, force: true });
});

test("the session pid skips the shell Claude runs the hook through", () => {
  assert.equal(sessionPid(INBOX), 42, "an inbox socket names the session's process");
  assert.equal(sessionPid({}), sessionPid({ CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/nan.sock" }));

  const module = JSON.stringify(path.join(import.meta.dirname, "messaging.mjs"));
  const script = `import { sessionPid } from ${module}; console.log(sessionPid({}));`;
  const through = execFileSync("sh", ["-c", `node --input-type=module -e ${JSON.stringify(script)}`], {
    encoding: "utf8",
  });

  assert.equal(
    Number(through.trim()),
    process.pid,
    "the walk passes the sh that exits with the hook and lands on this process",
  );
});

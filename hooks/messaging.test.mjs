import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { truncate } from "./focus.mjs";
import {
  head,
  invocation,
  messagingEnabled,
  register,
  registryPath,
  runtimeDir,
  sessionsDir,
  touch,
  unregister,
} from "./messaging.mjs";

const INBOX = {
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/42.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "t-inbox",
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

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
  const repo = "repo:github.com/mvhenten/recall";
  assert.equal(register("s-1", cwd, repo, "acceptEdits", env), true);
  const file = registryPath("s-1", env);
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(record, {
    socket: INBOX.CLAUDE_CODE_MESSAGING_SOCKET,
    token: INBOX.CLAUDE_CODE_MESSAGING_TOKEN,
    pid: 42,
    sessionId: "s-1",
    host: hostname(),
    cwd,
    repo,
    branch: "work",
    commit: "feat(sessions): list every host's sessions",
    startedAt: record.startedAt,
    lastActivityAt: record.startedAt,
    prompts: 0,
    focus: { first: "", latest: "" },
    mode: record.mode,
    permissionMode: "acceptEdits",
  });
  assert.equal(["interactive", "headless", ""].includes(record.mode), true);
  assert.match(record.startedAt, ISO);
  assert.equal(Math.abs(Date.now() - Date.parse(record.startedAt)) < 60_000, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(sessionsDir(env)).mode & 0o777, 0o700);

  unregister("s-1", env);
  assert.equal(existsSync(file), false);
  unregister("s-1", env);
  assert.equal(register("s-2", cwd, repo, "", { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR }), false);
  assert.equal(
    register("s-3", cwd, repo, "", { ...env, CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/parent.sock" }),
    false,
  );

  rmSync(dir, { recursive: true, force: true });
});

test("each prompt counts, moves the focus on and reads the head again", () => {
  const { dir, env } = sandbox();
  const cwd = repository(path.join(dir, "work"), "chore: start");
  const first = `${"why does the deploy time out ".repeat(10)}on stage two`;

  assert.equal(touch("s-1", "anything", "default", env), false);
  assert.equal(register("s-1", cwd, "repo:github.com/mvhenten/recall", "default", env), true);
  const read = () => JSON.parse(readFileSync(registryPath("s-1", env), "utf8"));
  const started = read().startedAt;

  assert.equal(touch("s-1", first, "default", env), true);
  assert.equal(read().focus.first, truncate(first));
  assert.equal(read().focus.latest, truncate(first));
  assert.equal(read().prompts, 1);

  repository(cwd, "fix(sessions): keep the first prompt");
  assert.equal(touch("s-1", "why is CI red", "plan", env), true);
  const record = read();
  assert.equal(record.focus.first, truncate(first));
  assert.equal(record.focus.latest, "why is CI red");
  assert.equal(record.prompts, 2);
  assert.equal(record.commit, "fix(sessions): keep the first prompt");
  assert.equal(record.permissionMode, "plan");
  assert.equal(record.startedAt, started);
  assert.match(record.lastActivityAt, ISO);
  assert.equal(Date.parse(record.lastActivityAt) >= Date.parse(started), true);
  assert.equal(record.token, INBOX.CLAUDE_CODE_MESSAGING_TOKEN);
  assert.equal(statSync(registryPath("s-1", env)).mode & 0o777, 0o600);

  rmSync(dir, { recursive: true, force: true });
});

test("the head and the invocation mode read empty rather than guessing", () => {
  const { dir } = sandbox();

  assert.deepEqual(head(path.join(dir, "not-a-repo")), { branch: "", commit: "" });
  assert.equal(invocation(0), "");
  assert.equal(["interactive", "headless", ""].includes(invocation(process.pid)), true);

  rmSync(dir, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  messagingEnabled,
  record,
  register,
  registryPath,
  runtimeDir,
  sessionPid,
  sessionsDir,
  unregister,
} from "./messaging.mjs";

const INBOX = {
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/42.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "t-inbox",
};

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-hooks-"));
  return { dir, env: { ...INBOX, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_RUNTIME_DIR: path.join(dir, "run") } };
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

test("a session registers into the directory the daemon reads", () => {
  const { dir, env } = sandbox();
  assert.equal(sessionsDir(env), path.join(env.XDG_RUNTIME_DIR, "recall", "sessions"));
  assert.equal(runtimeDir({}, 1000), path.join(tmpdir(), "recall-1000"));

  assert.equal(register("s-1", "/home/you/src/recall", env), "registered");
  const file = registryPath("s-1", env);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    state: "registered",
    socket: INBOX.CLAUDE_CODE_MESSAGING_SOCKET,
    token: INBOX.CLAUDE_CODE_MESSAGING_TOKEN,
    pid: 42,
    cwd: "/home/you/src/recall",
  });
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

  assert.equal(register("s-2", "/tmp", noInbox), "no-inbox");
  const skipped = JSON.parse(readFileSync(registryPath("s-2", env), "utf8"));
  assert.deepEqual({ state: skipped.state, cwd: skipped.cwd }, { state: "no-inbox", cwd: "/tmp" });
  assert.equal(existsSync(`/proc/${skipped.pid}`), true, "the recorded pid outlives the hook");

  const parentSocket = { ...env, CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/parent.sock" };
  assert.equal(register("s-3", "/tmp", parentSocket), "no-inbox");

  record("s-4", { state: "off" }, "/tmp", env);
  assert.equal(JSON.parse(readFileSync(registryPath("s-4", env), "utf8")).state, "off");

  record("s-5", { state: "failed", error: "EACCES, permission denied" }, "/tmp", env);
  const failed = JSON.parse(readFileSync(registryPath("s-5", env), "utf8"));
  assert.deepEqual(
    { state: failed.state, error: failed.error, cwd: failed.cwd },
    { state: "failed", error: "EACCES, permission denied", cwd: "/tmp" },
  );
  assert.equal(statSync(registryPath("s-5", env)).mode & 0o777, 0o600);

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

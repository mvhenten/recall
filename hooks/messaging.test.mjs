import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { messagingEnabled, register, registryPath, runtimeDir, sessionsDir, unregister } from "./messaging.mjs";

const INBOX = {
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/42.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "t-inbox",
  CLAUDE_PID: "42",
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

  rmSync(dir, { recursive: true, force: true });
});

test("a session registers into the directory the daemon reads", () => {
  const { dir, env } = sandbox();
  assert.equal(sessionsDir(env), path.join(env.XDG_RUNTIME_DIR, "recall", "sessions"));
  assert.equal(runtimeDir({}, 1000), path.join(tmpdir(), "recall-1000"));

  assert.equal(register("s-1", "/home/you/src/recall", env), true);
  const file = registryPath("s-1", env);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    socket: INBOX.CLAUDE_CODE_MESSAGING_SOCKET,
    token: INBOX.CLAUDE_CODE_MESSAGING_TOKEN,
    pid: 42,
    cwd: "/home/you/src/recall",
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(sessionsDir(env)).mode & 0o777, 0o700);

  assert.equal(unregister("s-1", env), true);
  assert.equal(unregister("s-1", env), false);
  assert.equal(register("s-2", "/tmp", { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR }), false);

  rmSync(dir, { recursive: true, force: true });
});

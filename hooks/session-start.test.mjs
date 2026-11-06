import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const HOOK = path.join(import.meta.dirname, "session-start.mjs");
const PLUGIN_ROOT = path.dirname(import.meta.dirname);
const REPO = "repo:github.com/mvhenten/recall";

const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(\`\${process.env.STUB_REPO}\\n\`);
if (args[0] === "config") process.stdout.write(\`\${process.env.STUB_MODE}\\n\`);
`;

function sessionStart(mode, repo = REPO) {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-session-start-"));
  const stub = path.join(dir, "recall");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const stdout = execFileSync(process.execPath, [HOOK], {
    cwd: dir,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-1", cwd: dir, permission_mode: "default" }),
    encoding: "utf8",
    env: {
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      HOME: dir,
      STUB_MODE: mode,
      STUB_REPO: repo,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_RUNTIME_DIR: path.join(dir, "run"),
      XDG_STATE_HOME: path.join(dir, "state"),
    },
  });
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

test("hook mode names the CLI as the memory path and no local store", () => {
  const context = sessionStart("hook");

  for (const command of ["recall search", "recall get", "recall list", "recall save", "recall edit", "recall delete"]) {
    assert.ok(context.includes(command), `${command} in ${context}`);
  }
  assert.match(context, /write no memory file and append to nothing like a MEMORY\.md index/);
  assert.match(context, /pass --global for anything true outside it/);
  assert.doesNotMatch(context, /recall_/, "hook mode has no tools to name");
});

test("tools mode keeps naming the tools, with the CLI beside them", () => {
  const context = sessionStart("tools");
  assert.match(context, /recall_save is the only way to save one/);
  assert.match(context, /pass --global, or global: true to recall_save, for anything/);
  assert.ok(context.includes("- recall save [file] [--global]"), context);
});

test("outside a repo the scope is global", () => {
  assert.match(sessionStart("hook", ""), /Current scope: global only\./);
});

test("the plugin registers no mcp server", () => {
  assert.equal(existsSync(path.join(PLUGIN_ROOT, ".mcp.json")), false);
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal("mcpServers" in manifest, false);
});

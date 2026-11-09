import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const HOOK = path.join(import.meta.dirname, "recall-memories.mjs");

const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write("repo:github.com/mvhenten/recall\\n");
if (args[0] === "inject") process.stdout.write(process.env.STUB_INJECT);
`;

// What `recall inject --json` prints: the /v2 wire shape, where a memory is named by memoryName.
const INJECTED = {
  hits: [
    {
      score: 0.75,
      memoryName: "recall-v2-programme",
      type: "project",
      tags: ["repo:github.com/mvhenten/recall", "source:cli"],
      description: "recall's architecture after v1 was fully retired",
      inScope: true,
    },
    {
      score: 0.7,
      memoryName: "nightly-janitor-run",
      type: "reference",
      tags: ["repo:github.com/mvhenten/dotfiles"],
      description: "where the janitor keeps its ledger",
      inScope: false,
    },
  ],
};

function session() {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-memories-"));
  const stub = path.join(dir, "recall");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  return (sessionId) =>
    execFileSync(process.execPath, [HOOK], {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: dir,
        permission_mode: "default",
        prompt: "what did we decide about the architecture",
      }),
      encoding: "utf8",
      env: {
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        HOME: dir,
        STUB_INJECT: JSON.stringify(INJECTED),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_RUNTIME_DIR: path.join(dir, "run"),
        XDG_STATE_HOME: path.join(dir, "state"),
      },
    });
}

test("every injected line names the memory `recall get` takes", () => {
  const context = JSON.parse(session()("s-1")).hookSpecificOutput.additionalContext;

  assert.ok(
    context.includes("- recall-v2-programme (project; repo:github.com/mvhenten/recall): recall's architecture"),
    context,
  );
  assert.ok(context.includes("- nightly-janitor-run (reference; repo:github.com/mvhenten/dotfiles):"), context);
  assert.doesNotMatch(context, /undefined/);
});

test("a memory already shown this session is not injected again", () => {
  const run = session();
  run("s-2");

  assert.equal(run("s-2"), "");
});

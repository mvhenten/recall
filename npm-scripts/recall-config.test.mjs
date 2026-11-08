import assert from "node:assert/strict";
import test from "node:test";
import { envFilePath, recallConfig } from "./recall-config.mjs";

// The file `recall login` writes, as `cli/src/config.rs` writes and re-reads it: comments, blank
// lines, `export ` prefixes and either quote. An operator script that reads it differently from
// the CLI tells a signed-in host it is not signed in.
const FILE = `# recall
RECALL_ENDPOINT=https://recall.example.com/
export RECALL_TOKEN="rt_from_the_file"
RECALL_MODE=hook

`;

test("reads the endpoint and the token the way the CLI wrote them", () => {
  assert.deepEqual(recallConfig({}, FILE), {
    endpoint: "https://recall.example.com",
    token: "rt_from_the_file",
  });
});

test("the environment wins over the file, and an empty value counts as absent", () => {
  const env = { RECALL_ENDPOINT: "https://other.example.com", RECALL_TOKEN: "" };
  assert.deepEqual(recallConfig(env, FILE), {
    endpoint: "https://other.example.com",
    token: "rt_from_the_file",
  });
});

test("a value holding an equals sign survives, and a single-quoted one is unwrapped", () => {
  const { token } = recallConfig({}, "RECALL_TOKEN='rt_a=b=c'\n");
  assert.equal(token, "rt_a=b=c");
});

test("names no file where there is no home to hold one", () => {
  assert.equal(envFilePath({ RECALL_ENV_FILE: "/etc/recall/env" }), "/etc/recall/env");
  assert.equal(envFilePath({ HOME: "/home/you" }), "/home/you/.config/recall/env");
  assert.equal(envFilePath({ XDG_CONFIG_HOME: "/cfg" }), "/cfg/recall/env");
  assert.equal(envFilePath({}), "");
});

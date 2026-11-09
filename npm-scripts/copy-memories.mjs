#!/usr/bin/env node
// A one-shot copy of an account's memories out of D1 and into that account's own Durable Object,
// run by hand and never from a request path. The corpus is the one store recall cannot rebuild: a
// transcript is still on the host that wrote it and `recall sessions --backfill` sends it again, a
// published artifact's bytes are still in R2 and both stores address them the same way, and a
// memory is its row and nothing else.
//
//   npm run copy-memories
//
// Options: --help.
//
// It copies the one account the signed-in token names, so a deployment serving several accounts
// runs it once for each, signed in as each. The endpoint and the token are read the way the CLI
// reads them: the environment first, then the file `recall login` writes. Neither reaches argv or
// stdout.
//
// Safe to run again. A memory the object already holds is left exactly as it stands, a tag already
// written conflicts with itself, and a memory saved after the cutover is never written over, so an
// interrupted run is finished by the next one and a second run copies nothing.
//
// The D1 rows stay where they are. Rolling the deployment back reads them again.
//
// It prints what it did for the account it ran against and then what it checked: the row and tag
// count on each side, the memory ids each side holds, whether every embedding comes back out of
// the object as the bytes D1 holds, what SQLite makes of the full-text index against the rows it
// indexes, and the memory ids a query set drawn from the corpus ranks out of each store in hybrid,
// vector and text mode, tagged and untagged. It exits non-zero when any of those disagree, and on
// a memory passed over: that one is D1's alone, and the operator reads it before anything drops
// the row.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { envFilePath, recallConfig } from "./recall-config.mjs";

const die = (message) => {
  console.error(`copy-memories: ${message}`);
  process.exit(1);
};
const say = (message) => console.log(`copy-memories: ${message}`);

const usage = [
  "Copies an account's memories out of D1 into that account's own Durable Object, once.",
  "A memory is its row and nothing else, so this is the one copy with no second source.",
  "",
  "  npm run copy-memories",
  "",
  "Options: --help.",
  "",
  "It copies the account the signed-in token names, so run it once for each account of the",
  "deployment. RECALL_ENDPOINT and RECALL_TOKEN come from the environment, or from the file",
  "recall login writes; neither reaches argv or stdout. Safe to run again.",
].join("\n");

const { values: options } = parseArgs({ options: { help: { type: "boolean", default: false } } });
if (options.help) {
  console.log(usage);
  process.exit(0);
}

const path = envFilePath(process.env);
const text = (() => {
  if (path === "") return "";
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
})();
const { endpoint, token } = recallConfig(process.env, text);
if (endpoint === "") die(`RECALL_ENDPOINT names no deployment, in the environment or in ${path}\n${usage}`);
if (token === "") die(`this host is not signed in to ${endpoint}; run recall login\n${usage}`);

const response = await fetch(`${endpoint}/v2/memories/copy`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(600_000),
});
const body = await response.text();
if (!response.ok) die(`POST ${endpoint}/v2/memories/copy returned ${response.status}: ${body}`);

const report = JSON.parse(body);
const { userId, memories, tags, moved, checks } = report;
const some = (list) => (list.length === 0 ? "none" : list.join(", "));

say(`${userId}: copied ${memories.copied} memories, left ${memories.held} the object already held`);
say(`${userId}: copied ${tags.copied} tags, left ${tags.held} already written`);
say(`${userId}: ${checks.rows.account} rows in D1, ${checks.rows.tenant} in the object`);
say(`${userId}: ${checks.tags.account} tags in D1, ${checks.tags.tenant} in the object`);
say(`${userId}: missing ${some(checks.missing)}; held only by the object: ${some(checks.extra)}`);
say(`${userId}: tags that did not arrive: ${some(checks.missingTags)}`);
say(`${userId}: embeddings that did not round-trip byte for byte: ${some(checks.embeddings)}`);
say(`${userId}: full-text index against the rows it indexes: ${checks.index === "" ? "sound" : checks.index}`);
say(`${userId}: ${checks.queries} rankings replayed, ranked differently: ${some(checks.ranking)}`);

if (moved.length > 0) {
  say(
    `${userId}: moved ${some(moved)} up the sequence. Each was saved after the deployment cut over and took a memory_seq D1 had already handed out, which is the id the search index ranks by; the copied rows keep theirs and these moved above them.`,
  );
}
if (memories.superseded.length > 0) {
  die(
    `${userId}: passed over ${some(memories.superseded)}. Each is a D1 memory whose name the object already holds under another id, which is a save made after the cutover; the later save stands and the D1 row was not written over it. D1 holds the only copy of the prose in those rows, so read them before anything drops them. Nothing in D1 was changed.`,
  );
}
if (!checks.ok) die(`${userId}: the copy does not verify against D1; nothing in D1 was changed`);
say(`${userId}: verified`);

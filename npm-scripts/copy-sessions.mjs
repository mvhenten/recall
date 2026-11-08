#!/usr/bin/env node
// A one-shot copy of an account's sessions out of D1 and into that account's own Durable Object,
// run by hand and never from a request path. The deployment that moved a tenant into its own
// object copied no row, so every session the account held before it is addressed at an object that
// has never heard of it: the session and its transcript both answer 404 while D1 still holds the
// rows and R2 still holds the archive.
//
//   npm run copy-sessions
//
// Options: --help.
//
// It copies the one account the signed-in token names, so a deployment serving several accounts
// runs it once for each, signed in as each. The endpoint and the token are read the way the CLI
// reads them: the environment first, then the file `recall login` writes. Neither reaches argv or
// stdout.
//
// Safe to run again, and a corpus of hundreds of megabytes may want it: a run that stops part way
// has committed every page before it, and the next one walks from the start and passes over what
// is already there. A session the object already holds keeps its own row, a chunk brought over by
// an earlier run is found under the sequence it came in with, and nothing is written twice.
//
// The D1 rows stay where they are. Rolling the deployment back reads them again.
//
// It prints what it copied table by table and then what it checked: the row count on each side,
// the session ids each side holds, whether every embedding comes back out of the object as the
// bytes D1 holds, and what SQLite makes of the two full-text indexes against the rows they index.
// It exits non-zero when any of those disagree.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { envFilePath, recallConfig } from "./recall-config.mjs";

const die = (message) => {
  console.error(`copy-sessions: ${message}`);
  process.exit(1);
};
const say = (message) => console.log(`copy-sessions: ${message}`);

const usage = [
  "Copies an account's sessions out of D1 into that account's own Durable Object.",
  "The archive never moves; what moves is the rows that address it.",
  "",
  "  npm run copy-sessions",
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

const response = await fetch(`${endpoint}/v1/sessions/copy`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(600_000),
});
const body = await response.text();
if (!response.ok) die(`POST ${endpoint}/v1/sessions/copy returned ${response.status}: ${body}`);

const report = JSON.parse(body);
const { userId, chunks, straddling, checks } = report;
const some = (list) => (list.length === 0 ? "none" : list.join(", "));
const tally = (name, counted) => say(`${userId}: copied ${counted.copied} ${name}, left ${counted.held} already held`);

tally("sessions", report.sessions);
tally("history rows", report.history);
tally("index marks", report.index);
tally("record marks", report.records);
tally("open chunks", report.openChunks);
tally("counted files", report.countedFiles);
tally("usage events", report.usageEvents);
tally("usage days", report.usageDaily);
tally("labels", report.labels);
tally("board messages", report.boardMessages);
tally("board pickups", report.boardPickups);
say(`${userId}: copied ${chunks.copied} chunks, left ${chunks.held} already held`);

for (const [table, sides] of Object.entries(checks.rows)) {
  say(`${userId}: ${sides.account} ${table} rows in D1, ${sides.tenant} in the object`);
}
say(`${userId}: missing ${some(checks.missing)}; held only by the object: ${some(checks.extra)}`);
say(`${userId}: chunks that did not arrive: ${checks.missingChunks}`);
say(`${userId}: embeddings that did not round-trip byte for byte: ${some(checks.embeddings)}`);
say(`${userId}: chunk index against the rows it indexes: ${checks.chunkIndex === "" ? "sound" : checks.chunkIndex}`);
say(
  `${userId}: history index against the rows it indexes: ${checks.historyIndex === "" ? "sound" : checks.historyIndex}`,
);

if (straddling.length > 0) {
  say(
    `${userId}: ${some(straddling)} were held by both stores. Each kept the object's own row, which is the later one, and what D1 held of it that the object did not was added beside it. Nothing in D1 was changed.`,
  );
}
if (chunks.moved > 0) {
  say(
    `${userId}: moved ${chunks.moved} of the object's own chunks up the sequence. Each stood on a chunk_seq a copied chunk came in under, which is what the search index ranks by; the copied rows keep theirs and these moved above them, where the newest prose belongs.`,
  );
}
if (chunks.shifted > 0) {
  say(
    `${userId}: ${chunks.shifted} copied chunks climbed past an ordinal the object already indexes. Those belong to a session both stores wrote, where the ordinals name different prose; every chunk arrived and none was written over.`,
  );
}
if (!checks.ok) die(`${userId}: the copy does not verify against D1; nothing in D1 was changed`);
say(`${userId}: verified`);

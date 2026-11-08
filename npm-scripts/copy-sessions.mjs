#!/usr/bin/env node
// A copy of an account's sessions out of D1 and into that account's own Durable Object, run by
// hand and never from a request path. The deployment that moved a tenant into its own object
// copied no row, so every session the account held before it is addressed at an object that has
// never heard of it: the session and its transcript both answer 404 while D1 still holds the rows
// and R2 still holds the archive.
//
//   npm run copy-sessions
//   npm run copy-sessions -- --after=120400
//
// Options: --after, --help.
//
// It copies the one account the signed-in token names, so a deployment serving several accounts
// runs it once for each, signed in as each. The endpoint and the token are read the way the CLI
// reads them: the environment first, then the file `recall login` writes. Neither reaches argv or
// stdout.
//
// The prose is walked over as many calls as it takes, each opening where the one before it left
// off, so a corpus of hundreds of megabytes crosses without any one request having to hold it.
// The loop below is that, and `--after` is how a run interrupted part way is picked up: the
// frontier is printed on every call, and passing the last one back carries on from there rather
// than re-reading what already landed.
//
// Safe to run again whatever happens. A session the object already holds keeps its own row, a
// chunk brought over by an earlier run is found under the sequence and the instant it came in
// with, and nothing is written twice.
//
// The D1 rows stay where they are. Rolling the deployment back reads them again.
//
// It prints what it copied table by table with the row count each store holds of it, and then
// what it checked: the tables the object is short of, the session ids each side holds, whether
// every embedding comes back out of the object as the bytes D1 holds, and what SQLite makes of
// the two full-text indexes against the rows they index. It exits non-zero when any of those
// disagree.

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
  "  npm run copy-sessions -- --after=120400   # pick up an interrupted run at its last frontier",
  "",
  "Options: --after, --help.",
  "",
  "It copies the account the signed-in token names, so run it once for each account of the",
  "deployment. RECALL_ENDPOINT and RECALL_TOKEN come from the environment, or from the file",
  "recall login writes; neither reaches argv or stdout. Safe to run again.",
].join("\n");

const { values: options } = parseArgs({
  options: { after: { type: "string", default: "0" }, help: { type: "boolean", default: false } },
});
if (options.help) {
  console.log(usage);
  process.exit(0);
}
const opened = Number(options.after);
if (!Number.isSafeInteger(opened) || opened < 0) die(`--after takes a chunk_seq, not ${options.after}\n${usage}`);

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

const some = (list) => (list.length === 0 ? "none" : list.join(", "));

const call = async (after) => {
  const response = await fetch(`${endpoint}/v1/sessions/copy?after=${after}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(600_000),
  });
  const body = await response.text();
  if (!response.ok) {
    die(
      `POST ${endpoint}/v1/sessions/copy returned ${response.status}: ${body}\n` +
        `Nothing in D1 was changed. Run again with --after=${after} to carry on from where this call opened.`,
    );
  }
  return JSON.parse(body);
};

// The prose is walked over as many calls as it takes, and what each of them found of it goes no
// further than its own report. Only the run can say whether the corpus crossed, so the totals are
// kept here: a call that read forty chunks whose vector did not survive the crossing is the whole
// point of the check, and reading them off the last report would throw it away.
const run = { walked: 0, copied: 0, missing: 0, embeddings: [], moved: 0, shifted: 0, calls: 0 };

let after = opened;
let report = await call(after);
// Which sessions both stores held is a thing only the call that opened the run could see, so it
// is kept here rather than read off the last one.
const straddling = report.straddling;
for (;;) {
  const { chunks } = report;
  run.calls += 1;
  run.walked += chunks.copied + chunks.held;
  run.copied += chunks.copied;
  run.moved += chunks.moved;
  run.shifted += chunks.shifted;
  run.missing += report.checks.missingChunks;
  run.embeddings.push(...report.checks.embeddings);
  if (chunks.done) break;
  say(`${report.userId}: ${chunks.copied} chunks this call, up to chunk_seq ${chunks.frontier}`);
  after = chunks.frontier;
  report = await call(after);
}

const { userId, chunks, checks } = report;
if (run.calls > 1) say(`${userId}: the prose took ${run.calls} calls; the tables below are the last of them`);

for (const row of report.tables) {
  const walked = row.table === "chunks" ? run.copied : row.copied;
  say(
    `${userId}: ${row.table}: copied ${walked}, left ${row.held} already held; ${row.account} in D1, ${row.tenant} in the object`,
  );
}
say(`${userId}: tables the object is short of: ${some(checks.short)}`);
say(`${userId}: missing ${some(checks.missing)}; held only by the object: ${some(checks.extra)}`);
say(`${userId}: ${run.walked} of D1's ${chunks.account} chunks were walked over this run`);
say(`${userId}: chunks that did not arrive: ${run.missing}`);
say(`${userId}: embeddings that did not round-trip byte for byte: ${some(run.embeddings)}`);

for (const [name, check] of [
  ["chunk", checks.chunkIndex],
  ["history", checks.historyIndex],
]) {
  if (check.error === "") {
    say(`${userId}: ${name} index against the rows it indexes: sound`);
    continue;
  }
  // A check that did not run is not the same finding as an index that disagrees with its rows,
  // and reading one as the other would have an operator looking for a corruption that is not
  // there — or taking a real one for a bad statement.
  say(
    check.corrupt
      ? `${userId}: ${name} index and the rows it indexes DISAGREE: ${check.error}`
      : `${userId}: ${name} index was NOT CHECKED, the check itself failed: ${check.error}`,
  );
}

if (straddling.length > 0) {
  say(
    `${userId}: ${some(straddling)} were held by both stores. Each kept the object's own row, which is the later one, and what D1 held of it that the object did not was added beside it. Nothing in D1 was changed.`,
  );
}
// A host resuming a session from before the cutover while this ran makes a straddler no call could
// have named: the object writes the row, the copy finds it there and leaves it, and the list above
// was taken before that happened. Same outcome, and nothing to put right — but an operator
// comparing the list against what the dashboard shows should know why it can be one short.
say(`${userId}: a session a host resumed while this ran straddles the two stores too, and is not in that list`);
if (run.moved > 0) {
  say(
    `${userId}: moved ${run.moved} of the object's own chunks up the sequence. Each stood on a chunk_seq a copied chunk came in under, which is what the search index ranks by; the copied rows keep theirs and these moved above them, where the newest prose belongs.`,
  );
}
if (run.shifted > 0) {
  say(
    `${userId}: ${run.shifted} copied chunks climbed past an ordinal the object already indexes. Those belong to a session both stores wrote, where the ordinals name different prose; every chunk arrived and none was written over.`,
  );
}

// What the last call could not answer: whether the run walked the whole of D1's prose. The object
// holds the chunks it indexed itself as well as the ones it was given, so its row count is
// satisfied by an account nothing was ever copied into — only the walk accounts for the corpus.
if (run.walked < chunks.account) {
  die(
    `${userId}: the run walked ${run.walked} of D1's ${chunks.account} chunks, so the prose did not all cross. Run again from --after=0. Nothing in D1 was changed.`,
  );
}
if (run.missing > 0 || run.embeddings.length > 0) {
  die(`${userId}: the prose does not verify against D1; nothing in D1 was changed`);
}
if (!checks.ok) die(`${userId}: the copy does not verify against D1; nothing in D1 was changed`);
say(`${userId}: verified`);

#!/usr/bin/env node
// A one-shot copy of an account's artifact metadata out of D1 and into that account's own Durable
// Object, run by hand and never from a request path. The artifacts' bytes are in R2 and move
// nowhere; what moves is the half of an artifact nothing can rebuild — its type, title,
// description, permissions, revision, file list and search index — which exists in these rows and
// in no other place.
//
//   npm run copy-artifacts
//
// Options: --help.
//
// It copies the one account the signed-in token names, so a deployment serving several accounts
// runs it once for each, signed in as each. The endpoint and the token are read the way the CLI
// reads them: the environment first, then the file `recall login` writes. Neither reaches argv or
// stdout.
//
// Safe to run again. A name the object already holds is left exactly as it stands, a revision
// counter is raised and never lowered, and the claim on a name is taken again to the same effect,
// so an interrupted run is finished by the next one and a second run copies nothing.
//
// The D1 rows stay where they are. Rolling the deployment back reads them again.
//
// It prints what it did for the account it ran against and then what it checked: the row count on
// each side, the names each side holds, the artifact ids a fixed set of queries ranks out of each
// search index, and every live share against the artifact it resolved to before. It exits
// non-zero when any of those disagree, and when two accounts publish one name for the whole
// account to read — that name is claimed by neither, because the address can only hold one
// artifact and nothing here is entitled to choose which.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { envFilePath, recallConfig } from "./recall-config.mjs";

const die = (message) => {
  console.error(`copy-artifacts: ${message}`);
  process.exit(1);
};
const say = (message) => console.log(`copy-artifacts: ${message}`);

const usage = [
  "Copies an account's artifact metadata out of D1 into that account's own Durable Object, once.",
  "The bytes in R2 move nowhere; the rows are the half of an artifact nothing can rebuild.",
  "",
  "  npm run copy-artifacts",
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

const response = await fetch(`${endpoint}/v1/artifacts/copy`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(600_000),
});
const body = await response.text();
if (!response.ok) die(`POST ${endpoint}/v1/artifacts/copy returned ${response.status}: ${body}`);

const report = JSON.parse(body);
const { userId, artifacts, revisions, names, checks } = report;
const some = (list) => (list.length === 0 ? "none" : list.join(", "));

say(`${userId}: copied ${artifacts.copied} artifacts, left ${artifacts.held} the object already held`);
say(`${userId}: revisions ${revisions.copied} copied, ${revisions.raised} raised, ${revisions.held} left`);
say(`${userId}: claimed ${names.claimed.length} names, ${names.heldElsewhere.length} held by another account`);
say(`${userId}: ${checks.rows.account} rows in D1, ${checks.rows.tenant} in the object`);
say(`${userId}: missing ${some(checks.missing)}; held only by the object: ${some(checks.extra)}`);
say(`${userId}: ${checks.queries} queries replayed, ranked differently: ${some(checks.ranking)}`);
say(`${userId}: ${checks.shares} live shares, resolving elsewhere: ${some(checks.resolution)}`);

if (names.contested.length > 0) {
  console.error(
    `copy-artifacts: ${userId} publishes ${some(names.contested)} for the whole account to read, and so does another account.
The artifact hostname has no user segment, so one name is one address and only one artifact can
answer at it. The name is claimed by neither account: both still reach their own artifact through
their own account, and no reader of the other account reaches either. Settle it by making all but
one of them private, or by republishing under another name, then run this again.`,
  );
  process.exit(1);
}
if (!checks.ok) die(`${userId}: the copy does not verify against D1; nothing in D1 was changed`);
say(`${userId}: verified`);

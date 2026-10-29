#!/usr/bin/env node
// For the Workers Builds deploy: writes the recall env file for one (user, host)
// service token, read from the tofu state in R2. RECALL_ACCOUNT_ID,
// TFSTATE_ACCESS_KEY_ID and TFSTATE_SECRET_ACCESS_KEY come from the environment.
//
//   npm run service-token -- <user> <host> [env-file]
//
// The env file defaults to ~/.config/recall/env and is written mode 600.
// Nothing secret reaches argv or stdout.

import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const [user, host, target = join(homedir(), ".config", "recall", "env")] = process.argv.slice(2);
if (!user || !host) {
  console.error("usage: npm run service-token -- <user> <host> [env-file]");
  process.exit(2);
}

const die = (message) => {
  console.error(`service-token: ${message}`);
  process.exit(1);
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, text) => createHmac("sha256", key).update(text).digest();

const readState = async (accountId, accessKeyId, secretAccessKey) => {
  const hostName = `${accountId}.r2.cloudflarestorage.com`;
  const path = "/recall-tfstate/recall.tfstate";
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const payloadHash = sha256("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [
    "GET",
    path,
    "",
    `host:${hostName}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = ["auto", "s3", "aws4_request"].reduce(hmac, hmac(`AWS4${secretAccessKey}`, amzDate.slice(0, 8)));
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const response = await fetch(`https://${hostName}${path}`, {
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    die(`reading r2://recall-tfstate/recall.tfstate returned ${response.status}; has Workers Builds applied yet?`);
  return response.json();
};

const required = (name) => process.env[name] || die(`${name} is not set`);
const state = await readState(
  required("RECALL_ACCOUNT_ID"),
  required("TFSTATE_ACCESS_KEY_ID"),
  required("TFSTATE_SECRET_ACCESS_KEY"),
);

const token = state.resources
  ?.find(
    (r) => r.mode === "managed" && r.type === "cloudflare_zero_trust_access_service_token" && r.name === "principal",
  )
  ?.instances.find((instance) => instance.index_key === `${user}/${host}`)?.attributes;
if (!token) die(`no service token for ${user}/${host}; add the host to the RECALL_USERS build variable and redeploy`);
const hostname = state.outputs?.hostname?.value ?? die("the state has no hostname output yet");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `RECALL_ENDPOINT=https://${hostname}\nRECALL_CLIENT_ID=${token.client_id}\nRECALL_CLIENT_SECRET=${token.client_secret}\n`,
  { mode: 0o600 },
);
chmodSync(target, 0o600);
console.log(`wrote the recall env file for ${user}/${host} to ${target}`);

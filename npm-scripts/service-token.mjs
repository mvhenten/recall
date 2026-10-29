#!/usr/bin/env node
// Writes the recall env file for one (user, host) service token, read from the
// tofu state in R2 with the state keys tofu-bootstrap stored in dotfiles.
//
//   npm run service-token -- <user> <host> [env-file]
//
// The env file defaults to ~/.config/recall/env and is written mode 600.
// Nothing secret reaches argv or stdout.

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const scratchRoot = join(homedir(), "development", ".tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "recall-service-token-"));

const decrypt = (name) => {
  const file = join(scratch, name);
  const result = spawnSync("dotfiles-key", ["decrypt", name, "-o", file], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error || result.status !== 0)
    die(`dotfiles-key decrypt ${name} failed: ${result.error?.message ?? result.stderr}`);
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
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

const state = await (async () => {
  const debug = decrypt("recall-debug-token");
  const keys = decrypt("recall-tfstate-s3");
  return readState(debug.CLOUDFLARE_ACCOUNT_ID, keys.TFSTATE_ACCESS_KEY_ID, keys.TFSTATE_SECRET_ACCESS_KEY);
})().finally(() => rmSync(scratch, { recursive: true, force: true }));

const token = state.resources
  ?.find(
    (r) => r.mode === "managed" && r.type === "cloudflare_zero_trust_access_service_token" && r.name === "principal",
  )
  ?.instances.find((instance) => instance.index_key === `${user}/${host}`)?.attributes;
if (!token) die(`no service token for ${user}/${host}; add the host to infra/users.auto.tfvars and merge`);
const hostname = state.outputs?.hostname?.value ?? die("the state has no hostname output yet");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `RECALL_ENDPOINT=https://${hostname}\nRECALL_CLIENT_ID=${token.client_id}\nRECALL_CLIENT_SECRET=${token.client_secret}\n`,
  { mode: 0o600 },
);
chmodSync(target, 0o600);
console.log(`wrote the recall env file for ${user}/${host} to ${target}`);

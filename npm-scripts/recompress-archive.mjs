#!/usr/bin/env node
// A one-shot pass over the transcript archive, run by hand and never from a request path. Every
// object still in a legacy key form is read, gzipped, written under `<start>.<end>.<inflates>`, read
// back and compared byte for byte against what it came from, and only then is the legacy object
// removed. Once no legacy object is left, the read paths that carry those forms can go.
//
// It re-keys and compresses, and that is all. It is not a redaction pass: these bytes were archived
// before client-side redaction existed, and they go back up exactly as they came down.
//
//   npm run recompress-archive                 reports what it would do, reading only
//   npm run recompress-archive -- --apply      converts, one session at a time
//
// Options: --bucket <name> (default recall-transcripts).
//
// It is resumable and safe to run again: what is already converted is read off the listing, a session
// whose every key names three segments is passed over, and an interruption leaves a session's earlier
// stretches converted and its later ones as they were. A stretch that does not read back as the bytes
// it came from leaves both objects in place and stops the run, naming the session and the key.
//
// Run it while nothing is appending: a stretch is written in its new form before the old one goes, so
// a reader catching the archive between the two sees one span named twice.
//
// Credentials follow deploy.mjs. CLOUDFLARE_API_TOKEN reads the private builder bucket, which must
// hold TRANSCRIPTS_ACCESS_KEY_ID and TRANSCRIPTS_SECRET_ACCESS_KEY — R2 S3 credentials with object
// read and write on the transcript bucket. No token reaches argv or stdout.
import { createHash, createHmac } from "node:crypto";
import { parseArgs } from "node:util";
import { rekeyArchive } from "./stretch-rekey.mjs";

const API = "https://api.cloudflare.com/client/v4";
const BUILDER_BUCKET = "recall-builder-secrets";

const die = (message) => {
  console.error(`recompress: ${message}`);
  process.exit(1);
};
const say = (message) => console.log(`recompress: ${message}`);

const { values: options } = parseArgs({
  options: {
    bucket: { type: "string", default: "recall-transcripts" },
    apply: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const usage = [
  "Re-keys every legacy object of the transcript archive into the gzipped three-segment form, one",
  "session at a time: each object is read, gzipped, written under <start>.<end>.<inflates>, read back",
  "and compared byte for byte against what it came from, and only then is the legacy object removed.",
  "",
  "It re-keys and compresses, and that is all. It does not redact: these bytes were archived before",
  "client-side redaction existed and they go back up exactly as they came down.",
  "",
  "  CLOUDFLARE_API_TOKEN=... RECALL_ACCOUNT_ID=... npm run recompress-archive",
  "    reports what it would do, reading only",
  "  CLOUDFLARE_API_TOKEN=... RECALL_ACCOUNT_ID=... npm run recompress-archive -- --apply",
  "    converts, and is safe to run again after an interruption",
  "",
  "Options: --bucket <name> (default recall-transcripts), --apply, --help.",
  "",
  `${BUILDER_BUCKET} must hold TRANSCRIPTS_ACCESS_KEY_ID and TRANSCRIPTS_SECRET_ACCESS_KEY, R2 S3`,
  "credentials with object read and write on the bucket. No token reaches argv or stdout.",
].join("\n");
if (options.help) {
  console.log(usage);
  process.exit(0);
}
const token = process.env.CLOUDFLARE_API_TOKEN || die(`CLOUDFLARE_API_TOKEN is not set\n${usage}`);
const accountId = process.env.RECALL_ACCOUNT_ID || die(`RECALL_ACCOUNT_ID is not set\n${usage}`);
const bucket = options.bucket;

const builderObject = async (key) => {
  const path = `/accounts/${accountId}/r2/buckets/${BUILDER_BUCKET}/objects/${encodeURIComponent(key)}`;
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    die(
      `GET ${path} returned ${response.status}; ${BUILDER_BUCKET} must hold ${key}, an R2 S3 credential with object read and write on ${bucket}`,
    );
  }
  return (await response.text()).trim();
};

const keyId = await builderObject("TRANSCRIPTS_ACCESS_KEY_ID");
const secret = await builderObject("TRANSCRIPTS_SECRET_ACCESS_KEY");

const HOST = `${accountId}.r2.cloudflarestorage.com`;
const REGION = "auto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// Every character S3 wants escaped in a path segment or a query value, which is everything outside
// the unreserved set. A session id or a file name may hold any of them.
const escaped = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (found) => `%${found.charCodeAt(0).toString(16).toUpperCase()}`);

// One signed request to the archive's S3 endpoint. `host` is signed and never sent: fetch sets it
// from the URL itself and refuses the header.
const signed = (method, segments, query, body, extra) => {
  const stamp = new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const payload = sha256(body ?? "");
  const path = `/${segments.map(escaped).join("/")}`;
  const search = [...query.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => `${escaped(name)}=${escaped(value)}`)
    .join("&");
  const headers = { ...extra, host: HOST, "x-amz-content-sha256": payload, "x-amz-date": stamp };
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    path,
    search,
    `${names.map((name) => `${name}:${String(headers[name]).trim()}`).join("\n")}\n`,
    names.join(";"),
    payload,
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  let signing = `AWS4${secret}`;
  for (const part of [day, REGION, "s3", "aws4_request"]) signing = hmac(signing, part);
  const signature = createHmac("sha256", signing).update(toSign).digest("hex");
  return {
    url: `https://${HOST}${path}${search === "" ? "" : `?${search}`}`,
    headers: {
      ...extra,
      "x-amz-content-sha256": payload,
      "x-amz-date": stamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    },
  };
};

const s3 = async (method, segments, query, body, extra = {}) => {
  const request = signed(method, segments, query, body, extra);
  const response = await fetch(request.url, {
    method,
    headers: request.headers,
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    die(`${method} ${segments.join("/")} returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  return response;
};

const unescaped = (value) => decodeURIComponent(value);

// The archive as this pass reads and writes it. A listing is the whole of what the plan rests on; the
// three object operations are what one conversion costs.
const archive = {
  list: async (prefix) => {
    const found = [];
    let token;
    do {
      const query = new Map([
        ["list-type", "2"],
        ["max-keys", "1000"],
        ["encoding-type", "url"],
      ]);
      if (prefix !== "") query.set("prefix", prefix);
      if (token !== undefined) query.set("continuation-token", token);
      const response = await s3("GET", [bucket], query);
      if (response === null) die(`the bucket ${bucket} is not there`);
      const xml = await response.text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(entry)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(entry)?.[1];
        if (key === undefined || size === undefined) die(`a listing of ${bucket} named an object with no key or size`);
        found.push({ key: unescaped(key), size: Number(size) });
      }
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next !== undefined ? unescaped(next) : undefined;
    } while (token !== undefined);
    return found;
  },
  get: async (key) => {
    const response = await s3("GET", [bucket, ...key.split("/")], new Map());
    return response === null ? null : Buffer.from(await response.arrayBuffer());
  },
  put: async (key, body) => {
    await s3(
      "PUT",
      [bucket, ...key.split("/")],
      new Map(),
      body,
      // What putStretch writes a gzipped stretch with, so a converted object is indistinguishable
      // from one a host sent compressed.
      { "content-encoding": "gzip", "content-type": "application/x-ndjson" },
    );
  },
  delete: async (key) => {
    await s3("DELETE", [bucket, ...key.split("/")], new Map());
  },
};

say(`${options.apply ? "converting" : "reading"} ${bucket} in the account ${accountId}`);
say("this re-keys and compresses; it does not redact anything");
const plan = await rekeyArchive(archive, { apply: options.apply, say });
if (plan.left.length > 0) {
  die(`${plan.left.length} sessions were left alone, named above; they need a reading before anything touches them`);
}

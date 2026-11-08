#!/usr/bin/env node
// Self-hosts recall in your own Cloudflare account. Safe to run again: it finds
// what exists and creates the rest. Each host then signs in with recall login.
//
//   CLOUDFLARE_API_TOKEN=... npm run setup -- --hostname recall.example.com --user alice --email alice@example.com
//
// Options: --email again for more addresses, --account <id> (when the token sees
// several), --name <worker> (default recall), --artifact-hostname
// <pages.example.com> to publish pages on a second host, --mcp-connector to
// serve the MCP connector at <hostname>/mcp, --dry-run.
// The token is read from the environment only and never printed.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readWranglerConfig } from "./wrangler-config.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORK = join(ROOT, ".tmp", "setup");
const API = "https://api.cloudflare.com/client/v4";
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

const die = (message) => {
  console.error(`setup: ${message}`);
  process.exit(1);
};
const say = (message) => console.log(`setup: ${message}`);

const { values: options } = parseArgs({
  options: {
    hostname: { type: "string" },
    "artifact-hostname": { type: "string" },
    "mcp-connector": { type: "boolean", default: false },
    user: { type: "string" },
    email: { type: "string", multiple: true, default: [] },
    account: { type: "string" },
    name: { type: "string", default: "recall" },
    "dry-run": { type: "boolean", default: false },
  },
});
const usage =
  "usage: CLOUDFLARE_API_TOKEN=... npm run setup -- --hostname <host.example.com> --user <user> --email <email>";
const token = process.env.CLOUDFLARE_API_TOKEN || die(`CLOUDFLARE_API_TOKEN is not set\n${usage}`);
const { hostname, user, name } = options;
const artifactHostname = options["artifact-hostname"] ?? "";
const mcpConnector = options["mcp-connector"];
const emails = options.email.map((email) => email.trim().toLowerCase());
if (!hostname || !user || emails.length === 0) die(usage);
if (artifactHostname === hostname) die("--artifact-hostname is a second host, so it cannot be --hostname");
for (const email of emails) if (!/^[^@\s]+@[^@\s]+$/.test(email)) die(`--email ${email} is not an email address`);
for (const [label, value] of [
  ["--user", user],
  ["--name", name],
]) {
  if (!SLUG.test(value)) die(`${label} must be lower-case letters, digits and dashes`);
}
const dryRun = options["dry-run"];

const cf = async (method, path, body, { optional = false } = {}) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    if (optional) return null;
    const errors = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
    die(
      `${method} ${path} returned ${response.status}${errors ? `: ${errors}` : ""}; check the token permissions in the README`,
    );
  }
  return json.result;
};

const list = async (path) => {
  const items = [];
  for (let page = 1; page < 100; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await cf("GET", `${path}${separator}page=${page}&per_page=50`);
    items.push(...(result ?? []));
    if (!result || result.length < 50) return items;
  }
  return items;
};

const create = async (what, run) => {
  if (dryRun) {
    say(`would create ${what}`);
    return null;
  }
  const created = await run();
  say(`created ${what}`);
  return created;
};

const verified = await cf("GET", "/user/tokens/verify", undefined, { optional: true });
if (verified?.status && verified.status !== "active") die("CLOUDFLARE_API_TOKEN is not active");

const accountId = await (async () => {
  if (options.account) return options.account;
  const accounts = await list("/accounts");
  if (accounts.length !== 1) die(`the token sees ${accounts.length} accounts; pass --account <id>`);
  return accounts[0].id;
})();
const account = `/accounts/${accountId}`;

const zones = await list(`/zones?account.id=${accountId}`);
const zoneFor = (host) => {
  const found = zones
    .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!found) die(`no zone in this account holds ${host}; add the domain to Cloudflare first`);
  say(`zone ${found.name} holds ${host}`);
  return found;
};
const zone = zoneFor(hostname);
const artifactZone = artifactHostname === "" ? null : zoneFor(artifactHostname);

const organization = await cf("GET", `${account}/access/organizations`, undefined, { optional: true });
const teamDomain =
  organization?.auth_domain ??
  die("this account has no Zero Trust organization; open Zero Trust in the dashboard once and pick a team name");
say(`Access team ${teamDomain}`);

const database =
  (await list(`${account}/d1/database?name=${name}`)).find((db) => db.name === name) ??
  (await create(`D1 database ${name}`, () => cf("POST", `${account}/d1/database`, { name })));
const databaseId = database?.uuid ?? database?.id ?? "00000000-0000-0000-0000-000000000000";

const ensureBucket = async (bucket) => {
  if (await cf("GET", `${account}/r2/buckets/${bucket}`, undefined, { optional: true })) return bucket;
  await create(`R2 bucket ${bucket}`, () =>
    cf("POST", `${account}/r2/buckets`, { name: bucket, locationHint: "weur" }),
  );
  return bucket;
};

const transcriptBucket = await ensureBucket(`${name}-transcripts`);
// The artifact bucket is touched only when pages are published.
const artifactBucket = artifactHostname === "" ? "" : await ensureBucket(`${name}-artifacts`);

const ensureQueue = async (queue) =>
  (await list(`${account}/queues`)).find((found) => found.queue_name === queue) ??
  (await create(`queue ${queue}`, () => cf("POST", `${account}/queues`, { queue_name: queue })));

const transcriptQueue = await ensureQueue(`${name}-transcripts`);
const deadQueue = await ensureQueue(`${name}-transcripts-dead`);

// Every stretch written to the archive wakes the Worker that derives the rest from it. The rules
// are written whole rather than added to, so running the setup again leaves this one rule and no
// copy of it.
const notificationPath = `${account}/event_notifications/r2/${transcriptBucket}/configuration/queues/${transcriptQueue?.queue_id}`;
const notification = {
  rules: [{ actions: ["PutObject", "CompleteMultipartUpload"], description: "a transcript stretch landed" }],
};
if (dryRun) {
  say(`would send ${transcriptBucket} writes to queue ${name}-transcripts`);
} else {
  await cf("PUT", notificationPath, notification);
  say(`${transcriptBucket} writes go to queue ${transcriptQueue.queue_name}`);
}

const otp =
  (await list(`${account}/access/identity_providers`)).find((idp) => idp.type === "onetimepin") ??
  (await create("the One-time PIN login method", () =>
    cf("POST", `${account}/access/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} }),
  ));

const policies = await list(`${account}/access/policies`);
const upsertPolicy = async (policyName, body, sameAs) => {
  const existing = policies.find((p) => p.name === policyName);
  if (!existing) return create(`Access policy ${policyName}`, () => cf("POST", `${account}/access/policies`, body));
  if (sameAs(existing)) return existing;
  if (dryRun) {
    say(`would update Access policy ${policyName}`);
    return existing;
  }
  say(`updated Access policy ${policyName}`);
  return cf("PUT", `${account}/access/policies/${existing.id}`, body);
};

const bypassName = `${name} api`;
const bypass = await upsertPolicy(
  bypassName,
  { name: bypassName, decision: "bypass", include: [{ everyone: {} }] },
  (existing) => existing.decision === "bypass",
);

const approversName = `${name} device approvers`;
const approverEmails = await (async () => {
  const existing = policies.find((p) => p.name === approversName);
  const known = (existing?.include ?? []).map((rule) => rule.email?.email).filter((email) => typeof email === "string");
  return [...new Set([...known, ...emails])].sort();
})();
const approvers = await upsertPolicy(
  approversName,
  { name: approversName, decision: "allow", include: approverEmails.map((email) => ({ email: { email } })) },
  (existing) => (existing.include ?? []).length === approverEmails.length,
);

// One service token for this user, named for the user it acts for. Its secret is shown by
// Cloudflare once, at creation, and is never read or printed here: rotate the token in the
// dashboard to get a secret you can paste into the desktop app.
const connectorTokenName = `${name}-${user}-connector`;
const connectorToken = mcpConnector
  ? ((await list(`${account}/access/service_tokens`)).find((entry) => entry.name === connectorTokenName) ??
    (await create(`Access service token ${connectorTokenName}`, () =>
      cf("POST", `${account}/access/service_tokens`, { name: connectorTokenName, duration: "forever" }),
    )))
  : null;

const connectorPolicyName = `${name} connector tokens`;
const connectorPolicy = connectorToken
  ? await upsertPolicy(
      connectorPolicyName,
      {
        name: connectorPolicyName,
        decision: "non_identity",
        include: [{ service_token: { token_id: connectorToken.id } }],
      },
      (existing) => (existing.include ?? []).some((rule) => rule.service_token?.token_id === connectorToken.id),
    )
  : null;

const apps = await list(`${account}/access/apps`);
const upsertApp = async (domain, body) => {
  const existing = apps.find((app) => app.domain === domain);
  if (!existing) return create(`Access application for ${domain}`, () => cf("POST", `${account}/access/apps`, body));
  const policyIds = (existing.policies ?? []).map((p) => p.id);
  const wanted = body.policies.map((p) => p.id);
  const samePolicies = policyIds.length === wanted.length && wanted.every((id) => policyIds.includes(id));
  const wantedUris = body.destinations?.map((destination) => destination.uri) ?? null;
  const uris = (existing.destinations ?? []).map((destination) => destination.uri);
  const sameDestinations =
    wantedUris === null || (wantedUris.length === uris.length && wantedUris.every((uri) => uris.includes(uri)));
  if (samePolicies && sameDestinations && existing.name === body.name) return existing;
  if (dryRun) {
    say(`would update the Access application for ${domain}`);
    return existing;
  }
  say(`updated the Access application for ${domain}`);
  return cf("PUT", `${account}/access/apps/${existing.id}`, body);
};

await upsertApp(hostname, {
  name,
  domain: hostname,
  type: "self_hosted",
  session_duration: "24h",
  app_launcher_visible: false,
  policies: bypass ? [{ id: bypass.id, precedence: 1 }] : [],
});
const deviceDomain = `${hostname}/device`;
const browserApp = await upsertApp(deviceDomain, {
  name: `${name} browser pages`,
  type: "self_hosted",
  session_duration: "24h",
  app_launcher_visible: false,
  allowed_idps: otp ? [otp.id] : [],
  auto_redirect_to_identity: true,
  destinations: [
    { type: "public", uri: deviceDomain },
    { type: "public", uri: `${hostname}/dashboard` },
  ],
  policies: approvers ? [{ id: approvers.id, precedence: 1 }] : [],
});

const artifactApp =
  artifactHostname === ""
    ? null
    : await upsertApp(artifactHostname, {
        name: `${name} artifacts`,
        domain: artifactHostname,
        type: "self_hosted",
        session_duration: "24h",
        app_launcher_visible: false,
        allowed_idps: otp ? [otp.id] : [],
        auto_redirect_to_identity: true,
        policies: approvers ? [{ id: approvers.id, precedence: 1 }] : [],
      });

const mcpDomain = `${hostname}/mcp`;
const mcpApp = mcpConnector
  ? await upsertApp(mcpDomain, {
      name: `${name} connector`,
      type: "self_hosted",
      session_duration: "24h",
      app_launcher_visible: false,
      allowed_idps: otp ? [otp.id] : [],
      service_auth_401_redirect: true,
      destinations: [{ type: "public", uri: mcpDomain }],
      policies: [
        ...(connectorPolicy ? [{ id: connectorPolicy.id, precedence: 1 }] : []),
        ...(approvers ? [{ id: approvers.id, precedence: 2 }] : []),
      ],
    })
  : null;

if (dryRun) {
  say(`would deploy the Worker ${name} to ${hostname}`);
  process.exit(0);
}

const run = (args) => {
  const result = spawnSync(join(ROOT, "node_modules", ".bin", "wrangler"), args, {
    cwd: ROOT,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio: "inherit",
    timeout: 600_000,
  });
  if (result.error) die(`wrangler ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`wrangler ${args.join(" ")} exited with ${result.status}`);
};

const base = readWranglerConfig();
const config = {
  ...base,
  $schema: undefined,
  name,
  main: join(ROOT, base.main),
  d1_databases: base.d1_databases.map((db) => ({
    ...db,
    database_name: name,
    database_id: databaseId,
    migrations_dir: join(ROOT, db.migrations_dir),
  })),
  r2_buckets: [
    { binding: "TRANSCRIPTS", bucket_name: transcriptBucket },
    ...(artifactBucket === "" ? [] : [{ binding: "ARTIFACTS", bucket_name: artifactBucket }]),
  ],
  queues: {
    consumers: base.queues.consumers.map((consumer) => ({
      ...consumer,
      queue: `${name}-transcripts`,
      dead_letter_queue: deadQueue?.queue_name ?? `${name}-transcripts-dead`,
    })),
  },
  routes: [
    { pattern: hostname, custom_domain: true, zone_id: zone.id },
    ...(artifactZone ? [{ pattern: artifactHostname, custom_domain: true, zone_id: artifactZone.id }] : []),
  ],
  vars: {
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: browserApp.aud,
    // The dashboard's own host is bound with the artifact host, because every artifact page
    // carries one link back to the dashboard and the artifact host cannot derive its address.
    ...(artifactApp
      ? {
          ARTIFACT_HOSTNAME: artifactHostname,
          ARTIFACT_ACCESS_AUD: artifactApp.aud,
          DASHBOARD_HOSTNAME: hostname,
        }
      : {}),
    ...(mcpApp && connectorToken ? { MCP_ACCESS_AUD: mcpApp.aud } : {}),
  },
};
mkdirSync(WORK, { recursive: true });
const configPath = join(WORK, "wrangler.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const principalPath = join(WORK, "principals.sql");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
// Which account the connector's service token acts for is a row rather than a Worker variable, so
// it is written here beside the invitations and off the same credentials.
const connectorRow = connectorToken
  ? `INSERT INTO mcp_clients (client_id, user_id) VALUES (${quote(connectorToken.client_id)}, ${quote(user)}) ON CONFLICT (client_id) DO UPDATE SET user_id = excluded.user_id;\n`
  : "";
writeFileSync(
  principalPath,
  emails
    .map(
      (email) =>
        `INSERT INTO principals (email, user_id) VALUES (${quote(email)}, ${quote(user)}) ON CONFLICT (email) DO UPDATE SET user_id = excluded.user_id;\n`,
    )
    .join("") + connectorRow,
);

run(["d1", "migrations", "apply", name, "--remote", "-c", configPath]);
run(["d1", "execute", name, "--remote", "--yes", `--file=${principalPath}`, "-c", configPath]);
run(["deploy", "-c", configPath]);

const probe = async () => {
  const deadline = Date.now() + 120_000;
  for (let delay = 5_000; ; delay = Math.min(delay * 2, 20_000)) {
    const response = await fetch(`https://${hostname}/v1/memories?limit=1`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    }).catch((error) => ({ status: 0, statusText: error.message }));
    if (response.status === 401) {
      if (mcpApp && connectorToken) {
        say(`connector URL: https://${hostname}/mcp, as Access service token ${connectorToken.client_id}`);
        say(
          `rotate ${connectorTokenName} under Zero Trust, Access, Service Auth to read its Client Secret; setup never prints it`,
        );
      }
      return say(`https://${hostname} answers; on each host run: recall login --endpoint https://${hostname}`);
    }
    if (Date.now() + delay > deadline) {
      return say(
        `https://${hostname} still answers ${response.status}; Access and the certificate can take a few minutes, then run: recall login --endpoint https://${hostname}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};
await probe();

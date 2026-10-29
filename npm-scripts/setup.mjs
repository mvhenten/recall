#!/usr/bin/env node
// Self-hosts recall in your own Cloudflare account and writes this host's
// recall env file. Safe to run again: it finds what exists and creates the rest.
//
//   CLOUDFLARE_API_TOKEN=... npm run setup -- --hostname recall.example.com --user alice --host laptop
//
// Options: --account <id> (when the token sees several), --name <worker> (default
// recall), --env-path <path> (default ~/.config/recall/env), --dry-run.
// The token is read from the environment only and never printed.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
    user: { type: "string" },
    host: { type: "string" },
    account: { type: "string" },
    name: { type: "string", default: "recall" },
    "env-path": { type: "string", default: join(homedir(), ".config", "recall", "env") },
    "dry-run": { type: "boolean", default: false },
  },
});
const usage =
  "usage: CLOUDFLARE_API_TOKEN=... npm run setup -- --hostname <host.example.com> --user <user> --host <host>";
const token = process.env.CLOUDFLARE_API_TOKEN || die(`CLOUDFLARE_API_TOKEN is not set\n${usage}`);
const { hostname, user, host, name } = options;
if (!hostname || !user || !host) die(usage);
for (const [label, value] of [
  ["--user", user],
  ["--host", host],
  ["--name", name],
]) {
  if (!SLUG.test(value)) die(`${label} must be lower-case letters, digits and dashes`);
}
const dryRun = options["dry-run"];
const envFile = options["env-path"];

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

const zone = (await list(`/zones?account.id=${accountId}`))
  .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
  .sort((a, b) => b.name.length - a.name.length)[0];
if (!zone) die(`no zone in this account holds ${hostname}; add the domain to Cloudflare first`);
say(`zone ${zone.name} holds ${hostname}`);

const organization = await cf("GET", `${account}/access/organizations`, undefined, { optional: true });
const teamDomain =
  organization?.auth_domain ??
  die("this account has no Zero Trust organization; open Zero Trust in the dashboard once and pick a team name");
say(`Access team ${teamDomain}`);

const database =
  (await list(`${account}/d1/database?name=${name}`)).find((db) => db.name === name) ??
  (await create(`D1 database ${name}`, () => cf("POST", `${account}/d1/database`, { name })));
const databaseId = database?.uuid ?? database?.id ?? "00000000-0000-0000-0000-000000000000";

const readEnvFile = () =>
  existsSync(envFile)
    ? Object.fromEntries(
        readFileSync(envFile, "utf8")
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
      )
    : {};

const tokenName = `${name}-${user}-${host}`;
const credentials = await (async () => {
  const existing = (await list(`${account}/access/service_tokens`)).find((t) => t.name === tokenName);
  const local = readEnvFile();
  if (existing && local.RECALL_CLIENT_ID === existing.client_id && local.RECALL_CLIENT_SECRET) {
    say(`reusing service token ${tokenName} from ${envFile}`);
    return { id: existing.id, clientId: existing.client_id, clientSecret: local.RECALL_CLIENT_SECRET };
  }
  if (existing) {
    if (dryRun) {
      say(`would rotate the secret of service token ${tokenName}, since ${envFile} does not hold it`);
      return { id: existing.id, clientId: existing.client_id, clientSecret: "" };
    }
    const rotated = await cf("POST", `${account}/access/service_tokens/${existing.id}/rotate`);
    say(`rotated the secret of service token ${tokenName}; other copies of the old secret stop working`);
    return { id: existing.id, clientId: existing.client_id, clientSecret: rotated.client_secret };
  }
  const created = await create(`service token ${tokenName}`, () =>
    cf("POST", `${account}/access/service_tokens`, { name: tokenName, duration: "forever" }),
  );
  return { id: created?.id ?? "", clientId: created?.client_id ?? "", clientSecret: created?.client_secret ?? "" };
})();

const policyName = `${name} service tokens`;
const policy = await (async () => {
  const existing = (await list(`${account}/access/policies`)).find((p) => p.name === policyName);
  const tokenIds = new Set(
    (existing?.include ?? []).map((rule) => rule.service_token?.token_id).filter((id) => typeof id === "string"),
  );
  if (credentials.id) tokenIds.add(credentials.id);
  const body = {
    name: policyName,
    decision: "non_identity",
    include: [...tokenIds].map((id) => ({ service_token: { token_id: id } })),
  };
  if (!existing) return create(`Access policy ${policyName}`, () => cf("POST", `${account}/access/policies`, body));
  if (existing.include?.length === body.include.length) return existing;
  if (dryRun) {
    say(`would add ${tokenName} to Access policy ${policyName}`);
    return existing;
  }
  say(`added ${tokenName} to Access policy ${policyName}`);
  return cf("PUT", `${account}/access/policies/${existing.id}`, body);
})();

const application = await (async () => {
  const existing = (await list(`${account}/access/apps`)).find((app) => app.domain === hostname);
  const body = {
    name,
    domain: hostname,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    service_auth_401_redirect: true,
    policies: policy ? [{ id: policy.id, precedence: 1 }] : [],
  };
  if (!existing) return create(`Access application for ${hostname}`, () => cf("POST", `${account}/access/apps`, body));
  if (existing.policies?.some((p) => p.id === policy?.id)) return existing;
  if (dryRun) {
    say(`would attach ${policyName} to the Access application for ${hostname}`);
    return existing;
  }
  say(`attached ${policyName} to the Access application for ${hostname}`);
  return cf("PUT", `${account}/access/apps/${existing.id}`, body);
})();

if (dryRun) {
  say(`would deploy the Worker ${name} to ${hostname} and write ${envFile}`);
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

const base = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
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
  routes: [{ pattern: hostname, custom_domain: true, zone_id: zone.id }],
  vars: { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: application.aud },
};
mkdirSync(WORK, { recursive: true });
const configPath = join(WORK, "wrangler.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const principalPath = join(WORK, "principal.sql");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
writeFileSync(
  principalPath,
  `INSERT INTO principals (client_id, user_id) VALUES (${quote(credentials.clientId)}, ${quote(user)})
  ON CONFLICT (client_id) DO UPDATE SET user_id = excluded.user_id;\n`,
);

run(["d1", "migrations", "apply", name, "--remote", "-c", configPath]);
run(["d1", "execute", name, "--remote", "--yes", `--file=${principalPath}`, "-c", configPath]);
run(["deploy", "-c", configPath]);

mkdirSync(dirname(envFile), { recursive: true });
writeFileSync(
  envFile,
  `RECALL_ENDPOINT=https://${hostname}\nRECALL_CLIENT_ID=${credentials.clientId}\nRECALL_CLIENT_SECRET=${credentials.clientSecret}\n`,
  { mode: 0o600 },
);
chmodSync(envFile, 0o600);
say(`wrote ${envFile}`);

const probe = async () => {
  const deadline = Date.now() + 120_000;
  for (let delay = 5_000; ; delay = Math.min(delay * 2, 20_000)) {
    const response = await fetch(`https://${hostname}/v1/memories?limit=1`, {
      headers: { "cf-access-client-id": credentials.clientId, "cf-access-client-secret": credentials.clientSecret },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    }).catch((error) => ({ status: 0, statusText: error.message }));
    if (response.status === 200) return say(`https://${hostname} answers; try: recall list --any`);
    if (Date.now() + delay > deadline) {
      return say(
        `https://${hostname} still answers ${response.status}; Access and the certificate can take a few minutes`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};
await probe();

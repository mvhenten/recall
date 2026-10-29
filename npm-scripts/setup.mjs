#!/usr/bin/env node
// Self-hosts recall in your own Cloudflare account. Safe to run again: it finds
// what exists and creates the rest. Each host then signs in with recall login.
//
//   CLOUDFLARE_API_TOKEN=... npm run setup -- --hostname recall.example.com --user alice --email alice@example.com
//
// Options: --email again for more addresses, --account <id> (when the token sees
// several), --name <worker> (default recall), --dry-run.
// The token is read from the environment only and never printed.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const emails = options.email.map((email) => email.trim().toLowerCase());
if (!hostname || !user || emails.length === 0) die(usage);
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

const apps = await list(`${account}/access/apps`);
const upsertApp = async (domain, body) => {
  const existing = apps.find((app) => app.domain === domain);
  if (!existing) return create(`Access application for ${domain}`, () => cf("POST", `${account}/access/apps`, body));
  const policyIds = (existing.policies ?? []).map((p) => p.id);
  const wanted = body.policies.map((p) => p.id);
  if (policyIds.length === wanted.length && wanted.every((id) => policyIds.includes(id))) return existing;
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
const deviceApp = await upsertApp(deviceDomain, {
  name: `${name} device approval`,
  domain: deviceDomain,
  type: "self_hosted",
  session_duration: "24h",
  app_launcher_visible: false,
  allowed_idps: otp ? [otp.id] : [],
  auto_redirect_to_identity: true,
  policies: approvers ? [{ id: approvers.id, precedence: 1 }] : [],
});

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
  vars: { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: deviceApp.aud },
};
mkdirSync(WORK, { recursive: true });
const configPath = join(WORK, "wrangler.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const principalPath = join(WORK, "principals.sql");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
writeFileSync(
  principalPath,
  emails
    .map(
      (email) =>
        `INSERT INTO principals (email, user_id) VALUES (${quote(email)}, ${quote(user)}) ON CONFLICT (email) DO UPDATE SET user_id = excluded.user_id;\n`,
    )
    .join(""),
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
    if (response.status === 401)
      return say(`https://${hostname} answers; on each host run: recall login --endpoint https://${hostname}`);
    if (Date.now() + delay > deadline) {
      return say(
        `https://${hostname} still answers ${response.status}; Access and the certificate can take a few minutes, then run: recall login --endpoint https://${hostname}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};
await probe();

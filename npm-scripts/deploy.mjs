#!/usr/bin/env node
// Workers Builds deploy step: applies infra/ with OpenTofu, migrates D1, syncs
// users and legacy service tokens into D1, and deploys the Worker. Every value that
// names this deployment comes from build variables (see README, Deploy), and a
// plan that would destroy anything stops the deploy.
// Reads the runner token and state keys from recall-builder-secrets with the
// token Builds injects; no secret reaches argv or stdout.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORK = join(ROOT, ".tmp", "deploy");
const TOFU_VERSION = "1.13.2";
const BUILDER_BUCKET = "recall-builder-secrets";
const API = "https://api.cloudflare.com/client/v4";

const die = (message) => {
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const BUILD_VARIABLES = {
  CLOUDFLARE_API_TOKEN: "the token Workers Builds injects",
  RECALL_ACCOUNT_ID: "the Cloudflare account id",
  RECALL_ZONE_ID: "the id of the zone that holds RECALL_HOSTNAME",
  RECALL_HOSTNAME: "the hostname the Worker serves, behind Access",
  RECALL_USERS: 'users and the emails that sign in as them, as JSON, {"<user>": {"emails": ["<email>"]}}',
};
const missing = Object.keys(BUILD_VARIABLES).filter((name) => !process.env[name]);
if (missing.length > 0) {
  die(
    `missing build variables: ${missing.map((name) => `${name} (${BUILD_VARIABLES[name]})`).join("; ")}; set them on the Workers Builds trigger`,
  );
}
const buildsToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.RECALL_ACCOUNT_ID;
const zoneId = process.env.RECALL_ZONE_ID;
const hostname = process.env.RECALL_HOSTNAME;

const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isUsers = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (user) => isStrings(user?.emails) && user.emails.length > 0 && (user.hosts === undefined || isStrings(user.hosts)),
  );
const users = (() => {
  try {
    return JSON.parse(process.env.RECALL_USERS);
  } catch (error) {
    return die(`RECALL_USERS is not JSON: ${error.message}`);
  }
})();
if (!isUsers(users)) die(`RECALL_USERS must look like ${BUILD_VARIABLES.RECALL_USERS}`);
const emailOwners = Object.entries(users).flatMap(([userId, user]) =>
  user.emails.map((email) => [email.trim().toLowerCase(), userId]),
);
const duplicate = emailOwners.find(([email], index) => emailOwners.findIndex(([other]) => other === email) !== index);
if (duplicate) die(`RECALL_USERS lists ${duplicate[0]} under more than one user`);

const builderObject = async (key) => {
  const path = `/accounts/${accountId}/r2/buckets/${BUILDER_BUCKET}/objects/${encodeURIComponent(key)}`;
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${buildsToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    die(
      `GET ${path} returned ${response.status}; it must hold CLOUDFLARE_TOFU_TOKEN, TFSTATE_ACCESS_KEY_ID and TFSTATE_SECRET_ACCESS_KEY (see README, Deploying from CI)`,
    );
  return (await response.text()).trim();
};

const tofuToken = await builderObject("CLOUDFLARE_TOFU_TOKEN");
const stateKeyId = await builderObject("TFSTATE_ACCESS_KEY_ID");
const stateSecret = await builderObject("TFSTATE_SECRET_ACCESS_KEY");

const run = (command, args, { env = {}, cwd = ROOT, capture = false, allowFailure = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    timeout: 600_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) die(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result;
};

const installTofu = async () => {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? die(`no OpenTofu build for ${process.arch}`);
  const dir = join(WORK, `tofu-${TOFU_VERSION}`);
  const binary = join(dir, "tofu");
  if (existsSync(binary)) return binary;
  mkdirSync(dir, { recursive: true });
  const base = `https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}`;
  const archive = `tofu_${TOFU_VERSION}_linux_${arch}.tar.gz`;
  const download = async (name) => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) die(`downloading ${name} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [tarball, sums] = await Promise.all([download(archive), download(`tofu_${TOFU_VERSION}_SHA256SUMS`)]);
  const expected = sums
    .toString("utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(" ")[0];
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (!expected || expected !== actual) die(`${archive} does not match its published SHA256 sum`);
  writeFileSync(join(dir, archive), tarball);
  run("tar", ["-xzf", archive, "tofu"], { cwd: dir });
  chmodSync(binary, 0o755);
  return binary;
};

const otpIdpId = await (async () => {
  const path = `/accounts/${accountId}/access/identity_providers`;
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${tofuToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) die(`GET ${path} returned ${response.status}; the tofu token needs Access identity providers read`);
  const { result } = await response.json();
  const otp = (result ?? []).find((provider) => provider.type === "onetimepin");
  return (
    otp?.id ??
    die(
      "the account has no One-time PIN login method; add it under Zero Trust, Settings, Authentication, Login methods",
    )
  );
})();

const tofu = await installTofu();
const infra = join(ROOT, "infra");
const tofuEnv = {
  CLOUDFLARE_API_TOKEN: tofuToken,
  AWS_ACCESS_KEY_ID: stateKeyId,
  AWS_SECRET_ACCESS_KEY: stateSecret,
  TF_DATA_DIR: join(WORK, "tofu-data"),
  TF_IN_AUTOMATION: "1",
  TF_VAR_account_id: accountId,
  TF_VAR_hostname: hostname,
  TF_VAR_otp_idp_id: otpIdpId,
  TF_VAR_users: JSON.stringify(users),
};

run(tofu, ["init", "-input=false", `-backend-config=endpoints={s3="https://${accountId}.r2.cloudflarestorage.com"}`], {
  cwd: infra,
  env: tofuEnv,
});
const planPath = join(WORK, "recall.tfplan");
run(tofu, ["plan", "-input=false", `-out=${planPath}`], { cwd: infra, env: tofuEnv });
const plan = JSON.parse(run(tofu, ["show", "-json", planPath], { cwd: infra, env: tofuEnv, capture: true }).stdout);
const destroyed = (plan.resource_changes ?? []).filter((change) => change.change.actions.includes("delete"));
if (destroyed.length > 0) {
  die(`the plan destroys ${destroyed.map((change) => change.address).join(", ")}; refusing to apply`);
}
console.log("deploy: the plan destroys nothing");
run(tofu, ["apply", "-input=false", planPath], { cwd: infra, env: tofuEnv });
const outputs = JSON.parse(run(tofu, ["output", "-json"], { cwd: infra, env: tofuEnv, capture: true }).stdout);
const output = (name) => outputs[name]?.value ?? die(`tofu output ${name} is missing`);

const wranglerEnv = { CLOUDFLARE_API_TOKEN: tofuToken, CLOUDFLARE_ACCOUNT_ID: accountId };
const wrangler = (args, options = {}) =>
  run(join(ROOT, "node_modules", ".bin", "wrangler"), args, { env: wranglerEnv, ...options });

const base = JSON.parse(
  readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
);
const deployConfig = {
  ...base,
  $schema: undefined,
  d1_databases: base.d1_databases.map((database) => ({ ...database, database_id: output("d1_database_id") })),
  routes: [{ pattern: hostname, custom_domain: true, zone_id: zoneId }],
  vars: { ACCESS_TEAM_DOMAIN: output("access_team_domain"), ACCESS_AUD: output("access_aud") },
};
const deployConfigPath = join(ROOT, "wrangler.deploy.json");
writeFileSync(deployConfigPath, `${JSON.stringify(deployConfig, null, 2)}\n`);

wrangler(["d1", "migrations", "apply", "recall", "--remote", "-c", deployConfigPath]);

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const principals = output("principals");
const sync = [
  "DELETE FROM service_tokens;",
  ...principals.map(
    (p) =>
      `INSERT INTO service_tokens (client_id, user_id, secret_sha256) VALUES (${quote(p.client_id)}, ${quote(p.user_id)}, ${quote(p.secret_sha256)});`,
  ),
  `DELETE FROM principals WHERE email NOT IN (${emailOwners.map(([email]) => quote(email)).join(", ")});`,
  ...emailOwners.map(
    ([email, userId]) =>
      `INSERT INTO principals (email, user_id) VALUES (${quote(email)}, ${quote(userId)}) ON CONFLICT (email) DO UPDATE SET user_id = excluded.user_id;`,
  ),
  "DELETE FROM devices WHERE user_id NOT IN (SELECT user_id FROM principals);",
].join("\n");
mkdirSync(WORK, { recursive: true });
const syncPath = join(WORK, "principals.sql");
writeFileSync(syncPath, `${sync}\n`);
wrangler(["d1", "execute", "recall", "--remote", "--yes", `--file=${syncPath}`, "-c", deployConfigPath]);
console.log(`users: ${Object.keys(users).join(", ")}; legacy service tokens: ${principals.length}`);

wrangler(["deploy", "-c", deployConfigPath]);

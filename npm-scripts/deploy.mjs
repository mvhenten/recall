#!/usr/bin/env node
// Workers Builds deploy step: applies infra/ with OpenTofu, makes sure the
// Vectorize index exists (the Cloudflare provider has no Vectorize resource),
// migrates D1, syncs the principals table from tofu and deploys the Worker.
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
const VECTORIZE_INDEX = "recall-memories";
const API = "https://api.cloudflare.com/client/v4";

const die = (message) => {
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const required = (name) =>
  process.env[name] || die(`${name} is not set; run this as the Workers Builds deploy command`);

const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const buildsToken = required("CLOUDFLARE_API_TOKEN");

const builderObject = async (key) => {
  const path = `/accounts/${accountId}/r2/buckets/${BUILDER_BUCKET}/objects/${encodeURIComponent(key)}`;
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${buildsToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) die(`GET ${path} returned ${response.status}; run tofu-bootstrap recall`);
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

const tofu = await installTofu();
const infra = join(ROOT, "infra");
const tofuEnv = {
  CLOUDFLARE_API_TOKEN: tofuToken,
  AWS_ACCESS_KEY_ID: stateKeyId,
  AWS_SECRET_ACCESS_KEY: stateSecret,
  TF_VAR_account_id: accountId,
  TF_DATA_DIR: join(WORK, "tofu-data"),
  TF_IN_AUTOMATION: "1",
};

run(tofu, ["init", "-input=false", `-backend-config=endpoints={s3="https://${accountId}.r2.cloudflarestorage.com"}`], {
  cwd: infra,
  env: tofuEnv,
});
run(tofu, ["apply", "-input=false", "-auto-approve"], { cwd: infra, env: tofuEnv });
const outputs = JSON.parse(run(tofu, ["output", "-json"], { cwd: infra, env: tofuEnv, capture: true }).stdout);
const output = (name) => outputs[name]?.value ?? die(`tofu output ${name} is missing`);

const wranglerEnv = { CLOUDFLARE_API_TOKEN: tofuToken, CLOUDFLARE_ACCOUNT_ID: accountId };
const wrangler = (args, options = {}) =>
  run(join(ROOT, "node_modules", ".bin", "wrangler"), args, { env: wranglerEnv, ...options });

const index = wrangler(["vectorize", "get", VECTORIZE_INDEX], { capture: true, allowFailure: true });
if (index.status !== 0) {
  wrangler(["vectorize", "create", VECTORIZE_INDEX, "--dimensions=384", "--metric=cosine"]);
}

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
  routes: [{ pattern: output("hostname"), custom_domain: true }],
  vars: { ACCESS_TEAM_DOMAIN: output("access_team_domain"), ACCESS_AUD: output("access_aud") },
};
const deployConfigPath = join(ROOT, "wrangler.deploy.json");
writeFileSync(deployConfigPath, `${JSON.stringify(deployConfig, null, 2)}\n`);

wrangler(["d1", "migrations", "apply", "recall", "--remote", "-c", deployConfigPath]);

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const principals = output("principals");
const sync = [
  "DELETE FROM principals;",
  ...principals.map(
    (p) => `INSERT INTO principals (client_id, user_id) VALUES (${quote(p.client_id)}, ${quote(p.user_id)});`,
  ),
].join("\n");
mkdirSync(WORK, { recursive: true });
const syncPath = join(WORK, "principals.sql");
writeFileSync(syncPath, `${sync}\n`);
wrangler(["d1", "execute", "recall", "--remote", "--yes", `--file=${syncPath}`, "-c", deployConfigPath]);
console.log(`principals: ${principals.map((p) => `${p.user_id}/${p.host}`).join(", ")}`);

wrangler(["deploy", "-c", deployConfigPath]);

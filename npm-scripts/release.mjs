#!/usr/bin/env node
// Cuts a CLI release: sets the version in cli/Cargo.toml, commits, tags vX.Y.Z
// and pushes both. The tag push starts the cargo-dist release workflow.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, "cli", "Cargo.toml");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout.trim();
}

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("usage: npm run release -- <X.Y.Z>");
const tag = `v${version}`;

if (run("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") fail("check out main first");
if (run("git", ["status", "--porcelain"]) !== "") fail("the working tree has uncommitted changes");
run("git", ["fetch", "--tags", "origin", "main"]);
if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", "origin/main"])) {
  fail("main is not at origin/main; pull or push first");
}
if (run("git", ["tag", "--list", tag]) !== "") fail(`tag ${tag} already exists`);

const manifest = readFileSync(MANIFEST, "utf8");
const versionLine = /^version = "[^"]*"$/m;
if (!versionLine.test(manifest)) fail("no version line in cli/Cargo.toml");
writeFileSync(MANIFEST, manifest.replace(versionLine, `version = "${version}"`));

run("cargo", ["update", "--workspace"]);
run("git", ["add", "cli/Cargo.toml", "Cargo.lock"]);
run("git", ["commit", "-m", `chore(release): ${tag}`]);
run("git", ["tag", "-a", tag, "-m", tag]);
run("git", ["push", "--atomic", "origin", "main", tag]);
console.log(`released ${tag}; the release workflow builds and publishes it`);

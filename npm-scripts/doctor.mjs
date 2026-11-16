#!/usr/bin/env node
// Quick environment sanity check: reports the Node version (against the
// required version) and whether node_modules is installed.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_MODULES = join(ROOT, "node_modules");

const say = (message) => console.log(`doctor: ${message}`);

const [major, minor] = process.versions.node.split(".").map(Number);
const [minMajor, minMinor] = "22.0.0".split(".").map(Number);
const nodeOk =
  major > minMajor || (major === minMajor && minor >= minMinor);
say(`node ${process.versions.node} ${nodeOk ? "" : "(needs >= 22)"}`);

const installed = existsSync(NODE_MODULES);
say(`node_modules ${installed ? "installed" : "NOT installed (run npm install)"}`);

if (!nodeOk || !installed) process.exitCode = 1;

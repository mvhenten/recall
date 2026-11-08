#!/usr/bin/env node
// Runs drizzle-kit over one of the two schemas and reads what it wrote before anyone applies it.
//
// SQLite cannot alter a column in place, so a change drizzle-kit cannot express as `ALTER TABLE`
// comes out as `CREATE TABLE __new_x; INSERT ... SELECT; DROP TABLE x; ALTER TABLE __new_x RENAME`.
// That drop takes the table's FTS5 triggers, its DESC indexes and its partial unique indexes with
// it, and nothing fails afterwards: the search index simply stops being maintained. So a generated
// file carrying either shape is taken back off disk and the script stops.
//
// `--listed-in` is the tenant store's second source of truth: its migrations are applied by
// `migrateDurableObject` off a hand-written list rather than by wrangler off the journal, so a file
// the list does not name is a migration that never runs.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const [config, ...flags] = process.argv.slice(2);
if (!config) throw new Error("usage: generate-migrations.mjs <drizzle config> [--listed-in=<file>]");

const listedIn = flags.find((flag) => flag.startsWith("--listed-in="))?.slice("--listed-in=".length);

const out = /\bout:\s*"([^"]+)"/.exec(readFileSync(join(ROOT, config), "utf8"))?.[1];
if (!out) throw new Error(`${config} names no out directory`);

const dir = join(ROOT, out);
const journal = join(dir, "meta", "_journal.json");
// The sql files and the snapshots beside them, which drizzle-kit writes as one set per migration.
const files = () => [...readdirSync(dir), ...readdirSync(join(dir, "meta")).map((name) => join("meta", name))];

const before = new Set(files());
const held = readFileSync(journal, "utf8");

const generate = spawnSync("drizzle-kit", ["generate", `--config=${config}`], { cwd: ROOT, stdio: "inherit" });
if (generate.status !== 0) process.exit(generate.status ?? 1);

const written = files().filter((name) => !before.has(name));
const sql = written.filter((name) => name.endsWith(".sql"));

const rebuilds = sql.filter((name) => /\bDROP TABLE\b|__new_/i.test(readFileSync(join(dir, name), "utf8")));
if (rebuilds.length > 0) {
  // Taken back off disk, journal and all, so re-running reproduces the failure rather than passing
  // over a migration already written.
  for (const name of written) rmSync(join(dir, name));
  writeFileSync(journal, held);
  console.error(`drizzle-kit wrote a rebuild of a table rather than an alter: ${rebuilds.join(", ")}

SQLite has no in-place column change, so it copies the rows into a new table and drops the old one.
The drop silently takes every FTS5 trigger, DESC index and partial unique index that table carries,
and search then drifts with no error at all. The generated file has been removed.

Write the change by hand with \`drizzle-kit generate --custom\`, re-creating the triggers and the
indexes the drop would have taken.`);
  process.exit(1);
}

if (listedIn === undefined) process.exit(0);

const list = readFileSync(join(ROOT, listedIn), "utf8");
const unlisted = readdirSync(dir).filter((name) => name.endsWith(".sql") && !list.includes(name));
if (unlisted.length > 0) {
  console.error(`${listedIn} does not name ${unlisted.join(", ")}, so nothing applies them.

The tenant store is migrated from that list, not from the journal drizzle-kit writes. Import each
file there and add it to TENANT_MIGRATIONS, in order.`);
  process.exit(1);
}

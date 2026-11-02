import assert from "node:assert/strict";
import test from "node:test";
import { FOCUS_PART_CHARS, truncate } from "./focus.mjs";
import { isoNow } from "./lib.mjs";

test("a prompt is cut to a focus line that fits on one row", () => {
  assert.equal(truncate(`${"x".repeat(200)}!`), `${"x".repeat(FOCUS_PART_CHARS - 1)}…`);
  assert.equal(truncate("  ship\n  it  "), "ship it");
  assert.equal(truncate("ship it"), "ship it");
  assert.equal(truncate("x".repeat(FOCUS_PART_CHARS)), "x".repeat(FOCUS_PART_CHARS));
  assert.equal(truncate(undefined), "");

  const long = `${"why does the deploy time out ".repeat(10)}on stage two`;
  assert.equal(truncate(long).length <= FOCUS_PART_CHARS, true);
  assert.equal(truncate(long).endsWith("…"), true);
});

test("a record timestamp is ISO 8601 with the host's own offset", () => {
  assert.match(isoNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(isoNow(new Date(1_762_000_000_000))), 1_762_000_000_000);
});

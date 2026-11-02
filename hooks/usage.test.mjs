import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readRecord, record, writeRecord } from "./messaging.mjs";
import { account, aggregate, events, PROVIDER, prepareUsage, tail, UNKNOWN_ACCOUNT } from "./usage.mjs";

const UID = process.getuid();

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-usage-"));
  return { dir, env: { XDG_RUNTIME_DIR: path.join(dir, "run") }, transcript: path.join(dir, "session.jsonl") };
}

// The shape Claude Code writes: one API response arrives as several entries, one per content
// block, each repeating the response's usage.
function answer(id, model, usage, { blocks = 1, at = "2026-11-02T10:32:44.529Z" } = {}) {
  const [input, output, write, read] = usage;
  return Array.from({ length: blocks }, () => ({
    type: "assistant",
    timestamp: at,
    requestId: `req-${id}`,
    message: {
      id,
      model,
      role: "assistant",
      content: [{ type: "text", text: "." }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
        service_tier: "standard",
      },
    },
  }));
}

const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const toolResult = () => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
});
const lines = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const OPUS = "claude-opus-4";
const HAIKU = "claude-haiku-4";

test("usage is summed per model over a transcript, counting one answer once", () => {
  const text = lines([
    { type: "summary", summary: "an entry with no usage at all" },
    prompt("count what this session costs"),
    ...answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 3 }),
    toolResult(),
    ...answer("msg-2", OPUS, [1, 2, 3, 4]),
    { type: "user", isMeta: true, message: { role: "user", content: "a note the harness wrote" } },
    ...answer("msg-3", HAIKU, [5, 6, 7, 8]),
    { type: "assistant", message: { id: "msg-4", model: "<synthetic>", content: [] } },
    prompt("ship it"),
  ]);

  const aggregated = aggregate(text);

  assert.deepEqual(aggregated.models, [
    {
      model: OPUS,
      at: Date.parse("2026-11-02T10:32:44.529Z"),
      inputTokens: 11,
      outputTokens: 22,
      cacheWriteTokens: 33,
      cacheReadTokens: 44,
    },
    {
      model: HAIKU,
      at: Date.parse("2026-11-02T10:32:44.529Z"),
      inputTokens: 5,
      outputTokens: 6,
      cacheWriteTokens: 7,
      cacheReadTokens: 8,
    },
  ]);
  assert.equal(aggregated.prompts, 2, "a tool result and a note the harness wrote are not prompts");
  assert.equal(aggregated.messageId, "msg-4", "the last message read is where the next range carries on");
});

test("an answer split across the end of a range is counted once", () => {
  const first = lines(answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 2 }));
  const second = lines([...answer("msg-1", OPUS, [10, 20, 30, 40]), ...answer("msg-2", OPUS, [1, 1, 1, 1])]);

  const opening = aggregate(first);
  assert.equal(opening.models[0].inputTokens, 10);

  const rest = aggregate(second, opening.messageId);
  assert.deepEqual(
    [rest.models[0].inputTokens, rest.models[0].outputTokens],
    [1, 1],
    "the blocks of the answer the last range counted are skipped",
  );
});

test("a delta is one event per model, carrying the prompts of the range once", () => {
  const aggregated = aggregate(
    lines([
      prompt("one"),
      ...answer("msg-1", OPUS, [1, 1, 1, 1]),
      prompt("two"),
      ...answer("msg-2", HAIKU, [2, 2, 2, 2]),
    ]),
  );

  const sent = events(aggregated, { seq: 1200, now: 1_762_000_000_000, account: "you@example.com" });

  assert.deepEqual(
    sent.map(({ seq, model, prompts, provider, account: on }) => ({ seq, model, prompts, provider, on })),
    [
      { seq: 1200, model: OPUS, prompts: 2, provider: PROVIDER, on: "you@example.com" },
      { seq: 1201, model: HAIKU, prompts: 0, provider: PROVIDER, on: "you@example.com" },
    ],
    "the second model takes the next chunk number, and the prompts are not counted twice",
  );
  assert.equal(sent[0].at, Date.parse("2026-11-02T10:32:44.529Z"));

  const undated = { model: OPUS, at: 0, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 1, cacheReadTokens: 1 };
  const now = 1_762_000_000_000;
  assert.equal(
    events({ models: [undated], prompts: 0 }, { seq: 0, now, account: "you@example.com" })[0].at,
    now,
    "an entry with no timestamp of its own is counted as the delta's own time",
  );
});

test("the tail stops at the last complete line and resets on a shorter file", () => {
  const { dir, transcript } = sandbox();
  writeFileSync(transcript, `${lines([prompt("one")])}{"type":"assist`);
  const complete = lines([prompt("one")]).length;

  assert.deepEqual(tail(transcript, 0), { text: lines([prompt("one")]), end: complete });
  assert.deepEqual(tail(transcript, complete), { text: "", end: complete }, "a half-written line waits");
  assert.deepEqual(tail(transcript, 4096), { reset: statSync(transcript).size });
  assert.deepEqual(tail(path.join(dir, "gone.jsonl"), 0), { missing: true });

  rmSync(dir, { recursive: true, force: true });
});

test("the range is fixed before the post and re-sent unchanged until it lands", () => {
  const { dir, env, transcript } = sandbox();
  record("s-1", { state: "off" }, { cwd: dir, repo: "", permissionMode: "default", transcriptPath: transcript }, env);
  writeFileSync(transcript, lines([prompt("count this"), ...answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 2 })]));

  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000), "pending");
  const fixed = readRecord("s-1", env, UID).usagePending;
  assert.equal(fixed.seq, 0);
  assert.equal(fixed.end, statSync(transcript).size, "the end is fixed at the last complete line");
  assert.deepEqual(
    fixed.events.map(({ seq, model, prompts, inputTokens, cacheReadTokens }) => ({
      seq,
      model,
      prompts,
      inputTokens,
      cacheReadTokens,
    })),
    [{ seq: 0, model: OPUS, prompts: 1, inputTokens: 10, cacheReadTokens: 40 }],
  );

  appendFileSync(transcript, lines(answer("msg-2", HAIKU, [1, 2, 3, 4])));
  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_100_000), "retry");
  assert.deepEqual(
    readRecord("s-1", env, UID).usagePending,
    fixed,
    "a range that has not landed is re-sent byte for byte, never re-read to the end of the file",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("the next range starts where the one that landed ended", () => {
  const { dir, env, transcript } = sandbox();
  record("s-1", { state: "off" }, { cwd: dir, repo: "", permissionMode: "default", transcriptPath: transcript }, env);
  writeFileSync(transcript, lines([prompt("count this"), ...answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 2 })]));
  prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000);

  // What `recall sessions --usage` writes back once the service has taken every event.
  const landed = readRecord("s-1", env, UID).usagePending;
  const posted = { ...readRecord("s-1", env, UID), usageOffset: landed.end, usageMessageId: landed.messageId };
  delete posted.usagePending;
  writeRecord("s-1", posted, env, UID);

  assert.equal(
    prepareUsage("s-1", transcript, env, UID, 1_762_000_100_000),
    "none",
    "a file that has not grown owes nothing",
  );

  appendFileSync(
    transcript,
    lines([...answer("msg-1", OPUS, [10, 20, 30, 40]), ...answer("msg-2", HAIKU, [1, 2, 3, 4])]),
  );
  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_200_000), "pending");
  const next = readRecord("s-1", env, UID).usagePending;
  assert.equal(next.seq, landed.end, "the chunk number is the offset the range started from");
  assert.deepEqual(
    next.events.map(({ model, inputTokens, prompts }) => ({ model, inputTokens, prompts })),
    [{ model: HAIKU, inputTokens: 1, prompts: 0 }],
    "the answer the range before it counted is not counted again",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("a transcript that is gone, unreadable or rewritten shorter never fails a session", () => {
  const { dir, env, transcript } = sandbox();
  record("s-1", { state: "off" }, { cwd: dir, repo: "", permissionMode: "default", transcriptPath: transcript }, env);

  assert.equal(prepareUsage("s-2", transcript, env, UID), "unregistered");
  assert.equal(prepareUsage("s-1", undefined, env, UID), "no-transcript");
  assert.equal(prepareUsage("s-1", transcript, env, UID), "no-transcript", "a transcript not written yet owes nothing");

  writeFileSync(transcript, lines([prompt("count this")]));
  writeRecord("s-1", { ...readRecord("s-1", env, UID), usageOffset: 9000, usageMessageId: "msg-1" }, env, UID);
  assert.equal(prepareUsage("s-1", transcript, env, UID), "reset");
  assert.deepEqual(
    { offset: readRecord("s-1", env, UID).usageOffset, messageId: readRecord("s-1", env, UID).usageMessageId },
    { offset: statSync(transcript).size, messageId: "" },
    "a transcript shorter than the offset is another file: counting starts at its end",
  );

  writeRecord("s-1", { ...readRecord("s-1", env, UID), usageOffset: 0 }, env, UID);
  assert.equal(prepareUsage("s-1", transcript, env, UID), "none", "prompts wait for the answer they paid for");
  assert.equal(readRecord("s-1", env, UID).usagePending, undefined);
  assert.equal(readRecord("s-1", env, UID).usageOffset, 0, "the prompt stays in the range its answer will join");

  rmSync(dir, { recursive: true, force: true });
});

test("the account is the one the host signed in with", () => {
  const { dir } = sandbox();

  assert.equal(account(dir), UNKNOWN_ACCOUNT, "a host that cannot name its account still counts");
  writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "you@example.com" } }));
  assert.equal(account(dir), "you@example.com");
  writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: {} }));
  assert.equal(account(dir), UNKNOWN_ACCOUNT);
  writeFileSync(path.join(dir, ".claude.json"), "not json");
  assert.equal(account(dir), UNKNOWN_ACCOUNT);

  rmSync(dir, { recursive: true, force: true });
});

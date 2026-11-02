import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readRecord, record, writeRecord } from "./messaging.mjs";
import { account, aggregate, events, PROVIDER, prepareUsage, tail } from "./usage.mjs";

const UID = process.getuid();

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-usage-"));
  return {
    dir,
    env: { XDG_RUNTIME_DIR: path.join(dir, "run"), HOME: dir },
    transcript: path.join(dir, "session.jsonl"),
  };
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
const lines = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const session = (dir, transcript) => ({ cwd: dir, repo: "", permissionMode: "default", transcriptPath: transcript });

const OPUS = "claude-opus-4";
const HAIKU = "claude-haiku-4";
const HOME = { oauthAccount: { emailAddress: "you@example.com" } };

const withAccount = (dir) => writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(HOME));

test("usage is summed per model over a transcript, counting one answer once", () => {
  const text = lines([
    { type: "summary", summary: "an entry with no usage at all" },
    prompt("count what this session costs"),
    ...answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 3 }),
    ...answer("msg-2", OPUS, [1, 2, 3, 4]),
    ...answer("msg-3", HAIKU, [5, 6, 7, 8]),
    { type: "assistant", message: { id: "msg-4", model: "<synthetic>", content: [] } },
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
  const { models } = aggregate(
    lines([...answer("msg-1", OPUS, [1, 1, 1, 1]), ...answer("msg-2", HAIKU, [2, 2, 2, 2])]),
  );

  const sent = events(models, { seq: 1200, now: 1_762_000_000_000, prompts: 2, account: "you@example.com" });

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
    events([undated], { seq: 0, now, prompts: 0, account: "you@example.com" })[0].at,
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
  withAccount(dir);
  record("s-1", { state: "off" }, session(dir, transcript), env);
  writeFileSync(transcript, lines([prompt("count this"), ...answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 2 })]));

  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000), "pending");
  const fixed = readRecord("s-1", env, UID).usagePending;
  assert.equal(fixed.seq, 0);
  assert.equal(
    fixed.files.main.offset,
    statSync(transcript).size,
    "the end of each file is fixed at its last complete line",
  );
  assert.deepEqual(
    fixed.events.map(({ seq, model, inputTokens, cacheReadTokens }) => ({ seq, model, inputTokens, cacheReadTokens })),
    [{ seq: 0, model: OPUS, inputTokens: 10, cacheReadTokens: 40 }],
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

// What `recall sessions --sync` writes back once the service has taken every event of a range.
function landed(sessionId, env) {
  const stored = readRecord(sessionId, env, UID);
  const { files, highWater, prompts } = stored.usagePending;
  const posted = { ...stored, usageFiles: files, usageHighWater: highWater, usagePrompts: prompts };
  delete posted.usagePending;
  writeRecord(sessionId, posted, env, UID);
  return stored.usagePending;
}

test("the next range starts where the one that landed ended", () => {
  const { dir, env, transcript } = sandbox();
  withAccount(dir);
  record("s-1", { state: "off" }, session(dir, transcript), env);
  writeFileSync(transcript, lines([prompt("count this"), ...answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 2 })]));
  prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000);
  const first = landed("s-1", env);

  assert.equal(prepareUsage("s-1", transcript, env, UID), "none", "a file that has not grown owes nothing");

  appendFileSync(
    transcript,
    lines([...answer("msg-1", OPUS, [10, 20, 30, 40]), ...answer("msg-2", HAIKU, [1, 2, 3, 4])]),
  );
  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_200_000), "pending");
  const next = readRecord("s-1", env, UID).usagePending;
  assert.equal(next.seq, first.highWater, "the chunk numbers carry on where the range before them stopped");
  assert.deepEqual(
    next.events.map(({ model, inputTokens }) => ({ model, inputTokens })),
    [{ model: HAIKU, inputTokens: 1 }],
    "the answer the range before it counted is not counted again",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("the prompts a delta carries are the ones the record counted and no delta has taken", () => {
  const { dir, env, transcript } = sandbox();
  withAccount(dir);
  record("s-1", { state: "off" }, session(dir, transcript), env);
  writeFileSync(transcript, lines(answer("msg-1", OPUS, [10, 20, 30, 40])));
  writeRecord("s-1", { ...readRecord("s-1", env, UID), prompts: 3 }, env, UID);

  prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000);
  assert.equal(readRecord("s-1", env, UID).usagePending.events[0].prompts, 3, "three prompts, none taken yet");
  landed("s-1", env);
  assert.equal(readRecord("s-1", env, UID).usagePrompts, 3);

  writeRecord("s-1", { ...readRecord("s-1", env, UID), prompts: 5 }, env, UID);
  appendFileSync(transcript, lines(answer("msg-2", OPUS, [1, 1, 1, 1])));
  prepareUsage("s-1", transcript, env, UID, 1_762_000_100_000);
  assert.equal(
    readRecord("s-1", env, UID).usagePending.events[0].prompts,
    2,
    "only the prompts counted since the last delta",
  );

  landed("s-1", env);
  writeRecord("s-1", { ...readRecord("s-1", env, UID), prompts: 1 }, env, UID);
  appendFileSync(transcript, lines(answer("msg-3", OPUS, [1, 1, 1, 1])));
  prepareUsage("s-1", transcript, env, UID, 1_762_000_200_000);
  assert.equal(
    readRecord("s-1", env, UID).usagePending.events[0].prompts,
    1,
    "a prompt count that restarted under a resumed session owes what it has, not a negative",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("chunk numbers climb past a transcript that was rewritten shorter", () => {
  const { dir, env, transcript } = sandbox();
  withAccount(dir);
  record("s-1", { state: "off" }, session(dir, transcript), env);
  writeFileSync(transcript, lines(answer("msg-1", OPUS, [10, 20, 30, 40], { blocks: 4 })));
  prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000);
  const first = landed("s-1", env);

  writeFileSync(transcript, lines(answer("msg-2", OPUS, [1, 1, 1, 1])));
  assert.equal(prepareUsage("s-1", transcript, env, UID), "reset");
  assert.equal(readRecord("s-1", env, UID).usageFiles.main.offset, statSync(transcript).size);

  appendFileSync(transcript, lines(answer("msg-3", HAIKU, [2, 2, 2, 2])));
  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_200_000), "pending");
  const next = readRecord("s-1", env, UID).usagePending;
  assert.equal(
    next.seq,
    first.highWater,
    "a reader back at the start of a shorter file carries on from the numbers already spent",
  );
  assert.equal(next.events[0].seq, first.highWater);
  assert.equal(next.highWater > first.highWater, true, "the mark climbs with every range");

  rmSync(dir, { recursive: true, force: true });
});

test("a transcript that is gone, unreadable or rewritten shorter never fails a session", () => {
  const { dir, env, transcript } = sandbox();
  withAccount(dir);
  record("s-1", { state: "off" }, session(dir, transcript), env);

  assert.equal(prepareUsage("s-2", transcript, env, UID), "unregistered");
  assert.equal(prepareUsage("s-1", undefined, env, UID), "no-transcript");
  assert.equal(prepareUsage("s-1", transcript, env, UID), "no-transcript", "a transcript not written yet owes nothing");

  writeFileSync(transcript, lines([prompt("count this")]));
  const marked = (offset, messageId) => ({
    ...readRecord("s-1", env, UID),
    usageFiles: { main: { offset, messageId } },
  });
  writeRecord("s-1", marked(9000, "msg-1"), env, UID);
  assert.equal(prepareUsage("s-1", transcript, env, UID), "reset");
  assert.deepEqual(
    readRecord("s-1", env, UID).usageFiles.main,
    { offset: statSync(transcript).size, messageId: "" },
    "a transcript shorter than the offset is another file: counting starts at its end",
  );

  writeRecord("s-1", marked(0, ""), env, UID);
  assert.equal(prepareUsage("s-1", transcript, env, UID), "none", "prompts wait for the answer they paid for");
  assert.equal(readRecord("s-1", env, UID).usagePending, undefined);
  assert.equal(
    readRecord("s-1", env, UID).usageFiles.main.offset,
    0,
    "the prompt stays in the range its answer will join",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("a delegated turn is counted with the session that delegated it", () => {
  const { dir, env, transcript } = sandbox();
  withAccount(dir);
  const delegated = path.join(dir, "session", "subagents", "agent-7f21.jsonl");
  mkdirSync(path.dirname(delegated), { recursive: true });
  writeFileSync(transcript, lines([prompt("delegate it")]));
  record("s-1", { state: "off" }, session(dir, transcript), env);
  writeFileSync(delegated, lines(answer("msg-a1", OPUS, [700, 70, 0, 0])));
  appendFileSync(transcript, lines(answer("msg-1", OPUS, [10, 20, 30, 40])));

  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000), "pending");

  const pending = readRecord("s-1", env, UID).usagePending;
  assert.deepEqual(
    pending.events.map(({ model, inputTokens }) => ({ model, inputTokens })),
    [{ model: OPUS, inputTokens: 710 }],
    "one model answering in both files spends once on the session",
  );
  assert.equal(pending.files["agent-7f21"].offset, statSync(delegated).size);
  assert.equal(pending.files.main.offset, statSync(transcript).size);

  landed("s-1", env);
  assert.equal(prepareUsage("s-1", transcript, env, UID), "none", "neither file owes anything twice");

  rmSync(dir, { recursive: true, force: true });
});

test("a delegated turn opened after the session started is counted from nothing", () => {
  const { dir, env, transcript } = sandbox();
  withAccount(dir);
  writeFileSync(transcript, lines([prompt("start")]));
  record("s-1", { state: "off" }, session(dir, transcript), env);
  const delegated = path.join(dir, "session", "subagents", "agent-7f21.jsonl");
  mkdirSync(path.dirname(delegated), { recursive: true });
  writeFileSync(delegated, lines(answer("msg-a1", OPUS, [700, 70, 0, 0])));

  assert.equal(prepareUsage("s-1", transcript, env, UID, 1_762_000_000_000), "pending");

  assert.equal(
    readRecord("s-1", env, UID).usagePending.events[0].inputTokens,
    700,
    "a file the session opens after it starts is read whole",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("the account is the identity the host signed in with", () => {
  const { dir, env, transcript } = sandbox();

  writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(HOME));
  assert.equal(account(dir), "you@example.com");
  writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ userID: "7f3a" }));
  assert.equal(account(dir), "7f3a", "a host whose account was swapped out still has its user id");
  writeFileSync(path.join(dir, ".claude.json"), "not json");
  assert.equal(account(dir), "");

  record("s-1", { state: "off" }, session(dir, transcript), env);
  writeFileSync(transcript, lines(answer("msg-1", OPUS, [10, 20, 30, 40])));
  assert.equal(prepareUsage("s-1", transcript, env, UID), "no-account", "a delta no account can be named for waits");
  assert.equal(readRecord("s-1", env, UID).usagePending, undefined);

  rmSync(dir, { recursive: true, force: true });
});

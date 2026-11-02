import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { firstLine } from "./lib.mjs";
import { readRecord, writeRecord } from "./messaging.mjs";

export const PROVIDER = "claude";

const NEWLINE = 0x0a;
const COUNTERS = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"];

// The subscription the tokens are spent on. A host whose account was swapped out has no
// `oauthAccount` left, so the user id the harness always writes is the identity to fall back on.
export function account(home = homedir()) {
  try {
    const { oauthAccount, userID } = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    const named = oauthAccount?.emailAddress ?? userID;
    return typeof named === "string" ? named : "";
  } catch {
    return "";
  }
}

// The stretch of transcript past `offset`, cut back to the last complete line: a record still being
// written is never half-counted, and the next pass takes it whole. A file shorter than the offset
// is a different transcript under the same name, and counting from its end is the only reading
// that cannot double count.
export function tail(file, offset) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return { missing: true };
  }
  try {
    const { size } = fstatSync(fd);
    if (size < offset) return { reset: size };
    if (size === offset) return { text: "", end: offset };
    const buffer = Buffer.allocUnsafe(size - offset);
    const slice = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, offset));
    const cut = slice.lastIndexOf(NEWLINE);
    if (cut < 0) return { text: "", end: offset };
    return { text: slice.subarray(0, cut + 1).toString("utf8"), end: offset + cut + 1 };
  } finally {
    closeSync(fd);
  }
}

const counter = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

function counted(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const counters = {
    inputTokens: counter(usage.input_tokens),
    outputTokens: counter(usage.output_tokens),
    cacheWriteTokens: counter(usage.cache_creation_input_tokens),
    cacheReadTokens: counter(usage.cache_read_input_tokens),
  };
  return COUNTERS.some((key) => counters[key] > 0) ? counters : undefined;
}

// One API response is written as several transcript entries, one per content block, each carrying
// the same usage, so a message counts once by its id. The entries of a message are contiguous, so
// carrying the last counted id into the next range is enough to keep a message that straddles the
// end of a range from being counted twice.
export function aggregate(text, lastMessageId = "") {
  const models = new Map();
  const seen = new Set(lastMessageId ? [lastMessageId] : []);
  let messageId = lastMessageId;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const id = typeof entry.message?.id === "string" ? entry.message.id : "";
    if (id && seen.has(id)) continue;
    if (id) {
      seen.add(id);
      messageId = id;
    }
    const counters = counted(entry.message);
    const model = typeof entry.message?.model === "string" ? entry.message.model : "";
    if (!counters || !model) continue;
    const found = models.get(model) ?? {
      model,
      at: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    for (const key of COUNTERS) found[key] += counters[key];
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) found.at = Math.max(found.at, at);
    models.set(model, found);
  }
  return { models: [...models.values()], messageId };
}

// One event per model, each needing a chunk number of its own. Every model here took at least one
// line of the stretch, so `seq + index` stays below the number the next stretch starts from.
export function events(models, { seq, now, prompts, account: on }) {
  return models.map((model, index) => ({
    seq: seq + index,
    provider: PROVIDER,
    account: on,
    model: model.model,
    prompts: index === 0 ? prompts : 0,
    at: model.at || now,
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
    cacheWriteTokens: model.cacheWriteTokens,
    cacheReadTokens: model.cacheReadTokens,
  }));
}

// The prompts this range answers: every prompt the session has counted that no delta has carried
// yet. A record whose prompt count restarted under a resumed session carries what it has now and
// sets the mark back to it, rather than owing a count that will never arrive.
function owed(stored) {
  const counted = stored.prompts ?? 0;
  const sent = stored.usagePrompts ?? 0;
  return counted >= sent ? counted - sent : counted;
}

// Fixes the stretch before anything is sent: its end, its models and the prompts it answers go
// into the record, and only a delta that landed moves the record past them. A retry sends the
// stretch that is already there, never a re-read to the end of the file.
export function prepareUsage(sessionId, transcriptPath, env = process.env, uid = process.getuid(), now = Date.now()) {
  const stored = readRecord(sessionId, env, uid);
  if (!stored) return "unregistered";
  if (stored.usagePending?.events?.length) return "retry";
  if (!transcriptPath) return "no-transcript";
  const offset = Number.isInteger(stored.usageOffset) ? stored.usageOffset : 0;
  const found = tail(transcriptPath, offset);
  if (found.missing) return "no-transcript";
  if (found.reset !== undefined) {
    writeRecord(sessionId, { ...stored, transcriptPath, usageOffset: found.reset, usageMessageId: "" }, env, uid);
    return "reset";
  }
  const on = account(env.HOME);
  if (!on) return "no-account";
  const { models, messageId } = aggregate(found.text, stored.usageMessageId ?? "");
  // A stretch with no answer in it yet is left where it is, so the prompts it holds are counted
  // with the tokens they paid for rather than ahead of them.
  if (models.length === 0) return "none";
  // A transcript rewritten shorter leaves the reader behind the chunk numbers already spent, and
  // those may never be reused.
  const seq = Math.max(offset, stored.usageHighWater ?? 0);
  const pending = {
    seq,
    end: found.end,
    highWater: seq + (found.end - offset),
    messageId,
    prompts: stored.prompts ?? 0,
    events: events(models, { seq, now, prompts: owed(stored), account: on }),
  };
  writeRecord(sessionId, { ...stored, transcriptPath, usagePending: pending }, env, uid);
  return "pending";
}

// Counting tokens must never cost a prompt, so an unreadable transcript or an unwritable record is
// reported to the hooks log and nothing more. The delta waits in the record for the sync the hook
// starts next, which is the one that sends it.
export function countUsage(sessionId, transcriptPath) {
  if (!sessionId) return "no-session";
  try {
    return prepareUsage(sessionId, transcriptPath);
  } catch (error) {
    return `failed:${firstLine(error.message)}`;
  }
}

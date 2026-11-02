import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { firstLine, recallDetached } from "./lib.mjs";
import { readRecord, writeRecord } from "./messaging.mjs";

export const PROVIDER = "claude";
// The service takes no empty account, so a host that cannot name the subscription it spends on
// counts under one name rather than losing the delta.
export const UNKNOWN_ACCOUNT = "unknown";

const NEWLINE = 0x0a;
const COUNTERS = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"];

export function account(home = homedir()) {
  try {
    const { oauthAccount } = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    const email = oauthAccount?.emailAddress;
    return typeof email === "string" && email.length > 0 ? email : UNKNOWN_ACCOUNT;
  } catch {
    return UNKNOWN_ACCOUNT;
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

// What the person typed, which is every user entry that is not a tool result the harness wrote
// back, a note it added itself, or a turn inside a subagent.
function isPrompt(entry) {
  if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => part?.type === "text");
}

// One API response is written as several transcript entries, one per content block, each carrying
// the same usage, so a message counts once by its id. The entries of a message are contiguous, so
// carrying the last counted id into the next range is enough to keep a message that straddles the
// end of a range from being counted twice.
export function aggregate(text, lastMessageId = "") {
  const models = new Map();
  const seen = new Set(lastMessageId ? [lastMessageId] : []);
  let messageId = lastMessageId;
  let prompts = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "user") {
      if (isPrompt(entry)) prompts += 1;
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
  return { models: [...models.values()], prompts, messageId };
}

// One delta per model, each needing a chunk number of its own: the service holds a delta by session
// and seq and ignores a second one on the same pair. Every model here took at least one line of the
// range, so `seq + index` always stays below the offset the next range starts from.
export function events({ models, prompts }, { seq, now, account: on }) {
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

// Fixes the range before anything is posted: its end, its models and its prompt count go into the
// record, and only a post that landed moves the offset past them. A retry sends the identical
// range, because the service keeps the first delta it saw for a chunk number and silently ignores
// a second one carrying other numbers.
export function prepareUsage(sessionId, transcriptPath, env = process.env, uid = process.getuid(), now = Date.now()) {
  const stored = readRecord(sessionId, env, uid);
  if (!stored) return "unregistered";
  if (stored.usagePending?.events?.length) return "retry";
  if (!transcriptPath) return "no-transcript";
  const seq = Number.isInteger(stored.usageOffset) ? stored.usageOffset : 0;
  const found = tail(transcriptPath, seq);
  if (found.missing) return "no-transcript";
  if (found.reset !== undefined) {
    writeRecord(sessionId, { ...stored, transcriptPath, usageOffset: found.reset, usageMessageId: "" }, env, uid);
    return "reset";
  }
  const aggregated = aggregate(found.text, stored.usageMessageId ?? "");
  // A range holding prompts but no usage yet is left where it is, so the prompts are counted with
  // the answer they paid for rather than dropped ahead of it.
  if (aggregated.models.length === 0) return "none";
  const pending = {
    seq,
    end: found.end,
    messageId: aggregated.messageId,
    events: events(aggregated, { seq, now, account: account() }),
  };
  writeRecord(sessionId, { ...stored, transcriptPath, usagePending: pending }, env, uid);
  return "pending";
}

// The hook never waits for the post: the range is fixed on disk and the arm that sends it is
// started detached, the way the session sync is. An unreadable transcript or an unwritable record
// is reported to the hooks log and nothing more, because counting tokens must never cost a prompt.
export function flushUsage(sessionId, transcriptPath, cwd) {
  if (!sessionId) return "no-session";
  let prepared;
  try {
    prepared = prepareUsage(sessionId, transcriptPath);
  } catch (error) {
    return `failed:${firstLine(error.message)}`;
  }
  if (prepared !== "pending" && prepared !== "retry") return prepared;
  return recallDetached(["sessions", "--usage", sessionId], cwd) ? prepared : "not-installed";
}

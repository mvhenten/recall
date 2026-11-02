import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { firstLine } from "./lib.mjs";
import { MAIN, readRecord, transcriptFiles, writeRecord } from "./messaging.mjs";

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

// What several files spent, by model. A model that answered both in a session's own transcript
// and in one of its delegated turns spent on one session, and the service takes one event per
// model.
function fold(models, counted) {
  for (const model of counted) {
    const found = models.get(model.model);
    if (!found) {
      models.set(model.model, { ...model });
      continue;
    }
    for (const key of COUNTERS) found[key] += model[key];
    found.at = Math.max(found.at, model.at);
  }
}

// A record written before the files were read apart carries one mark, for the session's own
// transcript. Carrying it across is what keeps the upgrade from counting that file over again,
// and it is the only reading of the old field: its chunk numbers counted bytes, and a byte count
// standing in for a chunk number would land among the ones a whole-file reading spends.
function carried(stored) {
  if (stored.usageFiles) return stored.usageFiles;
  if (!Number.isInteger(stored.usageOffset)) return {};
  return { [MAIN]: { offset: stored.usageOffset, messageId: stored.usageMessageId ?? "" } };
}

// Fixes the stretch before anything is sent: where each of the session's transcript files now
// reaches, the models that answered in them and the prompts the stretch answers go into the
// record, and only a delta that landed moves the record past them. A retry sends the stretch that
// is already there, never a re-read to the end of the files.
export function prepareUsage(sessionId, transcriptPath, env = process.env, uid = process.getuid(), now = Date.now()) {
  const stored = readRecord(sessionId, env, uid);
  if (!stored) return "unregistered";
  if (stored.usagePending?.events?.length) return "retry";
  if (!transcriptPath) return "no-transcript";
  const marks = { ...carried(stored) };
  const stretches = [];
  let readable = 0;
  let reset = false;
  for (const source of transcriptFiles(transcriptPath)) {
    const mark = marks[source.file] ?? { offset: 0, messageId: "" };
    const found = tail(source.path, mark.offset);
    if (found.missing) continue;
    readable += 1;
    if (found.reset !== undefined) {
      marks[source.file] = { offset: found.reset, messageId: "" };
      reset = true;
      continue;
    }
    stretches.push({ file: source.file, text: found.text, offset: found.end, messageId: mark.messageId });
  }
  if (readable === 0) return "no-transcript";
  const on = account(env.HOME);
  if (!on) return "no-account";
  const models = new Map();
  const taken = {};
  for (const stretch of stretches) {
    const counted = aggregate(stretch.text, stretch.messageId);
    taken[stretch.file] = { offset: stretch.offset, messageId: counted.messageId };
    fold(models, counted.models);
  }
  // A stretch with no answer in it yet is left where it is, so the prompts it holds are counted
  // with the tokens they paid for rather than ahead of them.
  if (models.size === 0) {
    if (reset) writeRecord(sessionId, { ...stored, transcriptPath, usageFiles: marks }, env, uid);
    return reset ? "reset" : "none";
  }
  // Chunk numbers climb and are never reused, whatever the files do under them.
  const seq = stored.usageHighWater ?? 0;
  const counted = events([...models.values()], { seq, now, prompts: owed(stored), account: on });
  const pending = {
    seq,
    highWater: seq + counted.length,
    prompts: stored.prompts ?? 0,
    files: { ...marks, ...taken },
    events: counted,
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

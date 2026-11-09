// What `/v2` answers with and what it takes, which is `/v1`'s vocabulary with its sentinels and
// its epoch integers taken out. Nothing here talks to the database or to storage: a view is a
// function of a row the store already read, and a parser is a function of a body, so both are read
// in one place and tested without a request.
//
// Every request body is validated by the zod the TypeSpec contract generates, and no shape is
// restated beside it: the contract is the source of truth, and a validator written here would be a
// second one to keep in step.
import type { z } from "zod";
import {
  AppendRecordsSchema,
  type DeviceSchema,
  ListMemoriesSchema,
  type MemoryHitSchema,
  MemoryPathSchema,
  type MemorySchema,
  type MemoryTypeSchema,
  type NearbyMemorySchema,
  type PastSessionSchema,
  type RecordsAcceptedSchema,
  type RecordsConflictSchema,
  SaveMemorySchema,
  SearchMemoriesSchema,
  type SearchModeSchema,
  SendMessageSchema,
  type SessionHitSchema,
  type SessionModeSchema,
  type SessionSchema,
  SessionSyncSchema,
  UsageDeltaSchema,
} from "../typespec/generated/schemas";
import type { Device } from "./device";
import type { SendInput } from "./mailbox";
import {
  DEFAULT_PAGE_ROWS,
  fail,
  type ListInput,
  type Memory,
  type MemoryHit,
  type MemoryType,
  type Mode,
  type Parsed,
  type PastSession,
  type SaveInput,
  type SearchInput,
  type Session,
  type SessionHit,
  type SessionInput,
  type SessionMode,
  type UsageInput,
} from "./model";

// Everything `/v2` answers with, taken from the contract rather than restated beside it. A client
// is generated off the same models, so a field the service adds and the contract does not know
// about is a type error here and never a shape only this service speaks.
export type V2Device = z.infer<typeof DeviceSchema>;
export type V2Session = z.infer<typeof SessionSchema>;
export type V2PastSession = z.infer<typeof PastSessionSchema>;
export type V2SessionHit = z.infer<typeof SessionHitSchema>;
export type V2RecordsAccepted = z.infer<typeof RecordsAcceptedSchema>;
export type V2RecordsConflict = z.infer<typeof RecordsConflictSchema>;
export type V2SendInput = z.infer<typeof SendMessageSchema>;
export type V2AppendRecords = z.infer<typeof AppendRecordsSchema>;
export type V2Memory = z.infer<typeof MemorySchema>;
export type V2MemoryHit = z.infer<typeof MemoryHitSchema>;
export type V2NearbyMemory = z.infer<typeof NearbyMemorySchema>;

// The three things a session's mode can be. `/v1` said "the host could not tell" with an empty
// string, which reads as a missing field rather than as an answer.
type V2SessionMode = z.infer<typeof SessionModeSchema>;

const MODE_OUT: Record<SessionMode, V2SessionMode> = {
  interactive: "Interactive",
  headless: "Headless",
  "": "Unknown",
};

const MODE_IN: Record<V2SessionMode, SessionMode> = {
  Interactive: "interactive",
  Headless: "headless",
  Unknown: "",
};

type V2MemoryType = z.infer<typeof MemoryTypeSchema>;
type V2SearchMode = z.infer<typeof SearchModeSchema>;

const MEMORY_TYPE_OUT: Record<MemoryType, V2MemoryType> = {
  user: "User",
  feedback: "Feedback",
  project: "Project",
  reference: "Reference",
};

const MEMORY_TYPE_IN: Record<V2MemoryType, MemoryType> = {
  User: "user",
  Feedback: "feedback",
  Project: "project",
  Reference: "reference",
};

const SEARCH_MODE_IN: Record<V2SearchMode, Mode> = {
  Hybrid: "hybrid",
  Vector: "vector",
  Text: "text",
};

// A business date as `/v2` writes one: an instant with its offset named, never a count of
// milliseconds a reader has to know the epoch of. The archive keeps epoch milliseconds, so the
// conversion is here and nowhere else.
export const isoOf = (at: number): string => new Date(at).toISOString();

export const epochOf = (iso: string): number => Date.parse(iso);

const EPOCH_ISO = isoOf(0);

// The name to print for a host: the label its owner gave it, and the host's own name where there
// is none. `/v1` answered an empty string there, which every reader then had to notice and
// substitute the host for — and the CLI that forgot printed a blank column.
export const hostLabelOf = (labels: Map<string, string>, host: string): string => {
  const label = labels.get(host);
  return label === undefined || label === "" ? host : label;
};

export const deviceView = (device: Device, labels: Map<string, string>, callerDeviceId: string): V2Device => ({
  deviceId: device.deviceId,
  name: device.name,
  host: device.host,
  hostLabel: hostLabelOf(labels, device.host),
  createdAt: device.createdAt,
  lastUsedAt: device.lastUsedAt,
  current: device.deviceId === callerDeviceId,
});

export const sessionView = (session: Session, labels: Map<string, string>, callerDeviceId: string): V2Session => ({
  sessionId: session.sessionId,
  name: session.name,
  agentName: session.agentName,
  deviceId: session.deviceId,
  host: session.host,
  hostLabel: hostLabelOf(labels, session.host),
  cwd: session.cwd,
  repo: session.repo,
  branch: session.branch,
  commit: session.commit,
  startedAt: isoOf(session.startedAt),
  lastActivityAt: isoOf(session.lastActivityAt),
  prompts: session.prompts,
  focus: session.focus,
  mode: MODE_OUT[session.mode],
  permissionMode: session.permissionMode,
  pid: session.pid,
  current: session.deviceId === callerDeviceId,
});

export const pastSessionView = (session: PastSession, labels: Map<string, string>): V2PastSession => ({
  sessionId: session.sessionId,
  name: session.name,
  agentName: session.agentName,
  host: session.host,
  hostLabel: hostLabelOf(labels, session.host),
  cwd: session.cwd,
  repo: session.repo,
  branch: session.branch,
  startedAt: isoOf(session.startedAt),
  lastActivityAt: isoOf(session.lastActivityAt),
  prompts: session.prompts,
  focus: session.focus,
  running: session.running,
});

export const sessionHitView = (hit: SessionHit, labels: Map<string, string>): V2SessionHit => ({
  session: pastSessionView(hit.session, labels),
  score: hit.score,
  excerpt: { speaker: hit.excerpt.speaker, text: hit.excerpt.text, at: isoOf(hit.excerpt.at) },
});

// A memory as `/v2` answers with one. `lastRecalledAt` is off the wire: `recallCount` already says
// whether a memory has ever been recalled, and the zero a never-recalled row carries read as an
// instant in 1970 to every client that printed it. The column stays where it is.
export const memoryView = (memory: Memory): V2Memory => ({
  memoryId: memory.memoryId,
  memoryName: memory.name,
  description: memory.description,
  type: MEMORY_TYPE_OUT[memory.type],
  body: memory.body,
  tags: memory.tags,
  createdAt: memory.createdAt,
  updatedAt: memory.updatedAt,
  recallCount: memory.recallCount,
});

export const memoryHitView = (hit: MemoryHit): V2MemoryHit => ({ memory: memoryView(hit.memory), score: hit.score });

export const nearbyMemoryView = (hit: MemoryHit): V2NearbyMemory => ({
  score: hit.score,
  memoryName: hit.memory.name,
  type: MEMORY_TYPE_OUT[hit.memory.type],
  tags: hit.memory.tags,
  description: hit.memory.description,
});

// What a zod refusal reads as. The issues are joined in the order the schema raised them, so the
// same body is always refused with the same sentence.
const complaint = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");

const validated = <T extends Record<string, unknown>>(schema: z.ZodType<T>, body: unknown): Parsed<T> => {
  const read = schema.safeParse(body);
  if (!read.success) return fail(complaint(read.error));
  return { ok: true, value: read.data };
};

export const parseAppendRecords = (body: unknown): Parsed<V2AppendRecords> => validated(AppendRecordsSchema, body);

// What one call of the session copy is told. It is a body rather than a query string because both
// of its fields are the run's own state carried between calls, and a contract is what says so.

export const parseSessionSync = (body: unknown): Parsed<SessionInput> => {
  const read = validated(SessionSyncSchema, body);
  if (!read.ok) return read;
  const input = read.value;
  const startedAt = epochOf(input.startedAt);
  const lastActivityAt = epochOf(input.lastActivityAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastActivityAt)) {
    return fail("startedAt and lastActivityAt must each be an ISO 8601 instant with its offset named");
  }
  return {
    ok: true,
    value: {
      host: input.host,
      cwd: input.cwd,
      repo: input.repo,
      branch: input.branch,
      commit: input.commit,
      startedAt,
      lastActivityAt,
      prompts: input.prompts,
      focus: input.focus,
      mode: MODE_IN[input.mode],
      permissionMode: input.permissionMode,
      pid: input.pid,
    },
  };
};

// `at` is bounded against the clock rather than against the schema, since how far ahead a host may
// date a delta is a function of now and no contract can say it.
export const parseUsageDelta = (body: unknown, now: number, epoch: number, ahead: number): Parsed<UsageInput> => {
  const read = validated(UsageDeltaSchema, body);
  if (!read.ok) return read;
  const input = read.value;
  const at = epochOf(input.at);
  if (!Number.isFinite(at) || at < epoch || at > now + ahead) {
    return fail("at must be an ISO 8601 instant with its offset named, no earlier than 2020 and at most a day ahead");
  }
  return {
    ok: true,
    value: {
      seq: input.seq,
      host: input.host,
      repo: input.repo,
      provider: input.provider,
      account: input.account,
      model: input.model,
      prompts: input.prompts,
      at,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      cacheReadTokens: input.cacheReadTokens,
      durable: input.durable,
      files: input.files,
    },
  };
};

// Where a bus message is addressed, in the vocabulary the board already resolves. `/v1` addressed
// one to a device and said "every session on it" with an empty session id, so the two scopes were
// one field that meant two things depending on whether it was filled in.
export const parseV2Send = (body: unknown): Parsed<V2SendInput> => validated(SendMessageSchema, body);

// The address resolved to the pair the mailbox publishes on. A message to a host reaches every
// session it has attached; one to a session reaches that session alone, and the device it runs on
// is read from the session rather than named twice by the caller.
// The slug in the path, read against the contract rather than against a second copy of the rule.
export const parseMemoryName = (name: string): Parsed<string> => {
  const read = MemoryPathSchema.safeParse({ memoryName: name });
  if (!read.success) return fail(complaint(read.error));
  return { ok: true, value: read.data.memoryName };
};

// Tags name a set, so the same tag twice is the same tag and the order a caller sent them in says
// nothing. The charset is the contract's; this is what is left once it has read them.
const tagSet = (tags: readonly string[]): string[] => [...new Set(tags)].sort();

export const parseSaveMemory = (body: unknown): Parsed<SaveInput> => {
  const read = validated(SaveMemorySchema, body);
  if (!read.ok) return read;
  const input = read.value;
  return {
    ok: true,
    value: {
      description: input.description,
      type: MEMORY_TYPE_IN[input.type],
      body: input.body,
      tags: tagSet(input.tags),
    },
  };
};

// No `any`. `/v1` took a boolean that had to disagree with the tag list, so the two fields were
// cross-validated by hand and either one alone was a refusal. An empty tag list means every memory.
export const parseSearchMemories = (body: unknown): Parsed<SearchInput> => {
  const read = validated(SearchMemoriesSchema, body);
  if (!read.ok) return read;
  const input = read.value;
  return {
    ok: true,
    value: {
      query: input.query,
      tags: tagSet(input.tags),
      limit: input.limit,
      minScore: input.minScore,
      mode: SEARCH_MODE_IN[input.mode],
    },
  };
};

// A listing is filtered by query parameters, which the contract declares as a model of its own so
// the filter speaks the same words the search body does: `tags` and not `tag`, a type that names
// itself, and a `since` carrying its offset. A parameter left blank is a parameter not given.
export const parseMemoryList = (params: URLSearchParams, sort: string): Parsed<ListInput> => {
  const given = (name: string): string[] => params.getAll(name).filter((value) => value !== "");
  const limit = given("limit")[0];
  const read = validated(ListMemoriesSchema, {
    tags: given("tags"),
    type: given("type"),
    since: given("since")[0] ?? EPOCH_ISO,
    limit: limit === undefined ? DEFAULT_PAGE_ROWS : Number(limit),
    cursor: given("cursor")[0] ?? "",
  });
  if (!read.ok) return read;
  const input = read.value;
  const since = epochOf(input.since);
  if (!Number.isFinite(since)) return fail("since must be an ISO 8601 instant with its offset named");
  return {
    ok: true,
    value: {
      tags: tagSet(input.tags),
      types: [...new Set(input.type.map((type) => MEMORY_TYPE_IN[type]))],
      since,
      cursor: input.cursor,
      limit: input.limit,
      sort,
    },
  };
};

export const sendInputOf = (input: V2SendInput, toDeviceId: string): SendInput => ({
  kind: input.kind,
  toDeviceId,
  toSessionId: input.address.scope === "session" ? input.address.target : "",
  fromSessionId: input.fromSessionId,
  body: input.body,
});

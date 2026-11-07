// What `/v2` answers with and what it takes, which is `/v1`'s vocabulary with its sentinels and
// its epoch integers taken out. Nothing here talks to the database or to storage: a view is a
// function of a row the store already read, and a parser is a function of a body, so both are read
// in one place and tested without a request.
//
// Every request body is validated by the zod the TypeSpec contract generates. The contract is the
// source of truth for the shapes, so a validator written beside it would be a second one to keep
// in step; what is added here is only what the emitter cannot say — that a number the schema
// bounds is also whole.
import type { z } from "zod";
import {
  AppendRecordsSchema,
  type DeviceSchema,
  type PastSessionSchema,
  type RecordsAcceptedSchema,
  type RecordsConflictSchema,
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
  fail,
  type Parsed,
  type PastSession,
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

// A business date as `/v2` writes one: an instant with its offset named, never a count of
// milliseconds a reader has to know the epoch of. The archive keeps epoch milliseconds, so the
// conversion is here and nowhere else.
export const isoOf = (at: number): string => new Date(at).toISOString();

export const epochOf = (iso: string): number => Date.parse(iso);

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

// What a zod refusal reads as. The issues are joined in the order the schema raised them, so the
// same body is always refused with the same sentence.
const complaint = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");

// Every number in a body, whole. The emitter writes a TypeSpec integer as a bounded zod number and
// has no way to say it is one, so an ordinal of 3.5 would pass the contract's own schema and land
// in a key no listing could read back.
const whole = (body: Record<string, unknown>): boolean =>
  Object.values(body).every((field) => typeof field !== "number" || Number.isSafeInteger(field));

const validated = <T extends Record<string, unknown>>(schema: z.ZodType<T>, body: unknown): Parsed<T> => {
  const read = schema.safeParse(body);
  if (!read.success) return fail(complaint(read.error));
  if (!whole(read.data)) return fail("every number in the body must be whole");
  return { ok: true, value: read.data };
};

export const parseAppendRecords = (body: unknown): Parsed<V2AppendRecords> => validated(AppendRecordsSchema, body);

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
export const sendInputOf = (input: V2SendInput, toDeviceId: string): SendInput => ({
  kind: input.kind,
  toDeviceId,
  toSessionId: input.address.scope === "session" ? input.address.target : "",
  fromSessionId: input.fromSessionId,
  body: input.body,
});

import { z } from "zod";

export const SessionModeSchema = z.enum(["Interactive", "Headless", "Unknown"]);

export const AppendRecordsSchema = z.object({
  file: z.string().min(1),
  from: z.number().min(0),
  records: z.array(z.string().min(1)).min(1).max(1000),
});

export const RecordsAcceptedSchema = z.object({
  file: z.string().min(1),
  next: z.number().min(0),
});

export const RecordsConflictSchema = z.object({
  error: z.string().min(1),
  next: z.number().min(0),
});

export const SessionFocusSchema = z.object({
  first: z.string().max(200),
  latest: z.string().max(200),
});

export const SessionSyncSchema = z.object({
  host: z.string().min(1).max(500),
  cwd: z.string().max(500),
  repo: z.string().max(500),
  branch: z.string().max(500),
  commit: z.string().max(500),
  startedAt: z.string().datetime({ offset: true }),
  lastActivityAt: z.string().datetime({ offset: true }),
  prompts: z.number().min(0).max(1000000),
  focus: SessionFocusSchema,
  mode: SessionModeSchema,
  permissionMode: z.string().max(500),
  pid: z.number().min(0),
});

export const UsageDeltaSchema = z.object({
  seq: z.number().min(0),
  host: z.string().min(1).max(500),
  repo: z.string().max(500),
  provider: z.string().min(1).max(500),
  account: z.string().min(1).max(500),
  model: z.string().min(1).max(500),
  prompts: z.number().min(0).max(1000000),
  inputTokens: z.number().min(0).max(1000000000),
  outputTokens: z.number().min(0).max(1000000000),
  cacheWriteTokens: z.number().min(0).max(1000000000),
  cacheReadTokens: z.number().min(0).max(1000000000),
  at: z.string().datetime({ offset: true }),
  durable: z.boolean(),
  files: z.array(z.string()).max(500),
});

export const DeviceSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().max(500),
  host: z.string().min(1).max(500),
  hostLabel: z.string().min(1).max(500),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  current: z.boolean(),
});

export const SessionSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().max(500),
  agentName: z.string().max(500),
  deviceId: z.string().min(1),
  host: z.string().max(500),
  hostLabel: z.string().max(500),
  cwd: z.string().max(500),
  repo: z.string().max(500),
  branch: z.string().max(500),
  commit: z.string().max(500),
  startedAt: z.string().datetime({ offset: true }),
  lastActivityAt: z.string().datetime({ offset: true }),
  prompts: z.number().min(0).max(1000000),
  focus: SessionFocusSchema,
  mode: SessionModeSchema,
  permissionMode: z.string().max(500),
  pid: z.number().min(0),
  current: z.boolean(),
});

export const PastSessionSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().max(500),
  agentName: z.string().max(500),
  host: z.string().max(500),
  hostLabel: z.string().max(500),
  cwd: z.string().max(500),
  repo: z.string().max(500),
  branch: z.string().max(500),
  startedAt: z.string().datetime({ offset: true }),
  lastActivityAt: z.string().datetime({ offset: true }),
  prompts: z.number().min(0).max(1000000),
  focus: SessionFocusSchema,
  running: z.boolean(),
});

export const SessionExcerptSchema = z.object({
  speaker: z.union([z.literal("user"), z.literal("model")]),
  text: z.string(),
  at: z.string().datetime({ offset: true }),
});

export const SessionHitSchema = z.object({
  session: PastSessionSchema,
  score: z.number(),
  excerpt: SessionExcerptSchema,
});

export const MessageAddressSchema = z.object({
  scope: z.union([z.literal("host"), z.literal("session")]),
  target: z.string().min(1),
});

export const SendMessageSchema = z.object({
  kind: z.union([z.literal("news"), z.literal("order")]),
  address: MessageAddressSchema,
  fromSessionId: z.string(),
  body: z.string().min(1).max(32768),
});

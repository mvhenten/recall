import { z } from "zod";

export const SessionModeSchema = z.enum(["Interactive", "Headless", "Unknown"]);

export const MemoryTypeSchema = z.enum(["User", "Feedback", "Project", "Reference"]);

export const SearchModeSchema = z.enum(["Hybrid", "Vector", "Text"]);

export const AppendRecordsSchema = z.object({
  file: z.string().min(1),
  from: z.int().min(0),
  records: z.array(z.string().min(1)).min(1).max(1000),
  closed: z.boolean(),
});

export const RecordsAcceptedSchema = z.object({
  file: z.string().min(1),
  next: z.int().min(0),
});

export const RecordsConflictSchema = z.object({
  error: z.string().min(1),
  next: z.int().min(0),
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
  prompts: z.int().min(0).max(1000000),
  focus: SessionFocusSchema,
  mode: SessionModeSchema,
  permissionMode: z.string().max(500),
  pid: z.int().min(0),
});

export const UsageDeltaSchema = z.object({
  seq: z.int().min(0),
  host: z.string().min(1).max(500),
  repo: z.string().max(500),
  provider: z.string().min(1).max(500),
  account: z.string().min(1).max(500),
  model: z.string().min(1).max(500),
  prompts: z.int().min(0).max(1000000),
  inputTokens: z.int().min(0).max(1000000000),
  outputTokens: z.int().min(0).max(1000000000),
  cacheWriteTokens: z.int().min(0).max(1000000000),
  cacheReadTokens: z.int().min(0).max(1000000000),
  at: z.string().datetime({ offset: true }),
  durable: z.boolean(),
  files: z.array(z.string()).max(500),
});

export const DeviceSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().max(500),
  host: z.string().min(1).max(500),
  hostLabel: z.string().min(1).max(500),
  createdAt: z.int(),
  lastUsedAt: z.int(),
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
  prompts: z.int().min(0).max(1000000),
  focus: SessionFocusSchema,
  mode: SessionModeSchema,
  permissionMode: z.string().max(500),
  pid: z.int().min(0),
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
  prompts: z.int().min(0).max(1000000),
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

export const MemoryPathSchema = z.object({
  memoryName: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .min(1)
    .max(100),
});

export const MemorySchema = z.object({
  memoryId: z.string().min(1),
  memoryName: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .min(1)
    .max(100),
  description: z.string().min(1).max(500),
  type: MemoryTypeSchema,
  body: z.string().max(100000),
  tags: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._:/-]*$/)
        .min(1)
        .max(200),
    )
    .max(50),
  createdAt: z.int(),
  updatedAt: z.int(),
  recallCount: z.int().min(0),
});

export const SaveMemorySchema = z.object({
  description: z.string().min(1).max(500),
  type: MemoryTypeSchema,
  body: z.string().max(100000),
  tags: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._:/-]*$/)
        .min(1)
        .max(200),
    )
    .max(50),
});

export const ListMemoriesSchema = z.object({
  tags: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._:/-]*$/)
        .min(1)
        .max(200),
    )
    .max(50),
  type: z.array(MemoryTypeSchema),
  since: z.string().datetime({ offset: true }),
  limit: z.int().min(1).max(100),
  cursor: z.string(),
});

export const SearchMemoriesSchema = z.object({
  query: z.string().min(1).max(2000),
  tags: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._:/-]*$/)
        .min(1)
        .max(200),
    )
    .max(50),
  limit: z.int().min(1).max(50),
  minScore: z.number().min(-1).max(1),
  mode: SearchModeSchema,
});

export const MemoryHitSchema = z.object({
  memory: MemorySchema,
  score: z.number(),
});

export const NearbyMemorySchema = z.object({
  score: z.number(),
  memoryName: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .min(1)
    .max(100),
  type: MemoryTypeSchema,
  tags: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._:/-]*$/)
        .min(1)
        .max(200),
    )
    .max(50),
  description: z.string().min(1).max(500),
});

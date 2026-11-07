import "@typespec/json-schema";
import "@kattebak/typespec-zod-emitter";

using TypeSpec.JsonSchema;

@service(#{ title: "recall" })
@jsonSchema
namespace Recall;

const maxRecordsPerAppend = 1000;
const maxSessionText = 500;
const maxFocusText = 200;
const maxPrompts = 1000000;
const maxUsageTokens = 1000000000;
const maxCountedFiles = 500;
const maxMessageBody = 32768;
const maxMemoryName = 100;
const maxMemoryDescription = 500;
const maxMemoryBody = 100000;
const maxMemoryTags = 50;
const maxMemoryTag = 200;
const maxMemoryQuery = 2000;
const maxMemoryHits = 50;

@minLength(1)
scalar TranscriptLine extends string;

@minLength(1)
@maxLength(maxMemoryTag)
@pattern("^[a-z0-9][a-z0-9._:/-]*$")
scalar MemoryTag extends string;

model AppendRecords {
  @minLength(1)
  file: string;

  @minValue(0)
  from: int32;

  @minItems(1)
  @maxItems(maxRecordsPerAppend)
  records: TranscriptLine[];
}

model RecordsAccepted {
  @minLength(1)
  file: string;

  @minValue(0)
  next: int32;
}

model RecordsConflict {
  @minLength(1)
  error: string;

  @minValue(0)
  next: int32;
}

enum SessionMode {
  Interactive,
  Headless,
  Unknown,
}

model SessionFocus {
  @maxLength(maxFocusText)
  first: string;

  @maxLength(maxFocusText)
  latest: string;
}

model SessionSync {
  @minLength(1)
  @maxLength(maxSessionText)
  host: string;

  @maxLength(maxSessionText)
  cwd: string;

  @maxLength(maxSessionText)
  repo: string;

  @maxLength(maxSessionText)
  branch: string;

  @maxLength(maxSessionText)
  commit: string;

  startedAt: offsetDateTime;
  lastActivityAt: offsetDateTime;

  @minValue(0)
  @maxValue(maxPrompts)
  prompts: int32;

  focus: SessionFocus;
  mode: SessionMode;

  @maxLength(maxSessionText)
  permissionMode: string;

  @minValue(0)
  pid: safeint;
}

model UsageDelta {
  @minValue(0)
  seq: safeint;

  @minLength(1)
  @maxLength(maxSessionText)
  host: string;

  @maxLength(maxSessionText)
  repo: string;

  @minLength(1)
  @maxLength(maxSessionText)
  provider: string;

  @minLength(1)
  @maxLength(maxSessionText)
  account: string;

  @minLength(1)
  @maxLength(maxSessionText)
  `model`: string;

  @minValue(0)
  @maxValue(maxPrompts)
  prompts: int32;

  @minValue(0)
  @maxValue(maxUsageTokens)
  inputTokens: int64;

  @minValue(0)
  @maxValue(maxUsageTokens)
  outputTokens: int64;

  @minValue(0)
  @maxValue(maxUsageTokens)
  cacheWriteTokens: int64;

  @minValue(0)
  @maxValue(maxUsageTokens)
  cacheReadTokens: int64;

  at: offsetDateTime;
  durable: boolean;

  @maxItems(maxCountedFiles)
  files: string[];
}

model Device {
  @minLength(1)
  deviceId: string;

  @maxLength(maxSessionText)
  name: string;

  @minLength(1)
  @maxLength(maxSessionText)
  host: string;

  @minLength(1)
  @maxLength(maxSessionText)
  hostLabel: string;

  createdAt: int64;
  lastUsedAt: int64;
  current: boolean;
}

model Session {
  @minLength(1)
  sessionId: string;

  @maxLength(maxSessionText)
  name: string;

  @maxLength(maxSessionText)
  agentName: string;

  @minLength(1)
  deviceId: string;

  @maxLength(maxSessionText)
  host: string;

  @maxLength(maxSessionText)
  hostLabel: string;

  @maxLength(maxSessionText)
  cwd: string;

  @maxLength(maxSessionText)
  repo: string;

  @maxLength(maxSessionText)
  branch: string;

  @maxLength(maxSessionText)
  commit: string;

  startedAt: offsetDateTime;
  lastActivityAt: offsetDateTime;

  @minValue(0)
  @maxValue(maxPrompts)
  prompts: int32;

  focus: SessionFocus;
  mode: SessionMode;

  @maxLength(maxSessionText)
  permissionMode: string;

  @minValue(0)
  pid: safeint;

  current: boolean;
}

model PastSession {
  @minLength(1)
  sessionId: string;

  @maxLength(maxSessionText)
  name: string;

  @maxLength(maxSessionText)
  agentName: string;

  @maxLength(maxSessionText)
  host: string;

  @maxLength(maxSessionText)
  hostLabel: string;

  @maxLength(maxSessionText)
  cwd: string;

  @maxLength(maxSessionText)
  repo: string;

  @maxLength(maxSessionText)
  branch: string;

  startedAt: offsetDateTime;
  lastActivityAt: offsetDateTime;

  @minValue(0)
  @maxValue(maxPrompts)
  prompts: int32;

  focus: SessionFocus;
  running: boolean;
}

model SessionExcerpt {
  speaker: "user" | "model";
  text: string;
  at: offsetDateTime;
}

model SessionHit {
  session: PastSession;
  score: float64;
  excerpt: SessionExcerpt;
}

model MessageAddress {
  scope: "host" | "session";

  @minLength(1)
  target: string;
}

model SendMessage {
  kind: "news" | "order";
  address: MessageAddress;
  fromSessionId: string;

  @minLength(1)
  @maxLength(maxMessageBody)
  body: string;
}

enum MemoryType {
  User,
  Feedback,
  Project,
  Reference,
}

enum SearchMode {
  Hybrid,
  Vector,
  Text,
}

model MemoryPath {
  @minLength(1)
  @maxLength(maxMemoryName)
  @pattern("^[a-z0-9]+(-[a-z0-9]+)*$")
  memoryName: string;
}

model Memory {
  @minLength(1)
  memoryId: string;

  @minLength(1)
  userId: string;

  @minLength(1)
  @maxLength(maxMemoryName)
  memoryName: string;

  @minLength(1)
  @maxLength(maxMemoryDescription)
  description: string;

  type: MemoryType;

  @maxLength(maxMemoryBody)
  body: string;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];

  createdAt: int64;
  updatedAt: int64;

  @minValue(0)
  recallCount: int32;
}

model SaveMemory {
  @minLength(1)
  @maxLength(maxMemoryDescription)
  description: string;

  type: MemoryType;

  @maxLength(maxMemoryBody)
  body: string;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];
}

model SearchMemories {
  @minLength(1)
  @maxLength(maxMemoryQuery)
  query: string;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];

  @minValue(1)
  @maxValue(maxMemoryHits)
  limit: int32;

  @minValue(-1)
  @maxValue(1)
  minScore: float64;

  mode: SearchMode;
}

model MemoryHit {
  memory: Memory;
  score: float64;
}

model NearbyMemory {
  score: float64;

  @minLength(1)
  @maxLength(maxMemoryName)
  memoryName: string;

  type: MemoryType;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];

  @minLength(1)
  @maxLength(maxMemoryDescription)
  description: string;
}

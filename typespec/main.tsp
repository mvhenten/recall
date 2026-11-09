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
const maxListRows = 100;

@doc("""
  One line of a transcript file, redacted, under the ordinal it holds in that file. A line that is
  not valid UTF-8 would cross as a JSON string lossily, so it is carried as the marker
  `\\u0000base64:` and the line's own bytes in base64; the archive decodes it back and holds the
  bytes the host read. A line that is valid UTF-8 and opens with that marker is carried the same
  way, which is what makes reading one unambiguous.
  """)
@minLength(1)
scalar TranscriptLine extends string;

@maxLength(maxSessionText)
scalar SessionText extends string;

@maxLength(maxFocusText)
scalar FocusText extends string;

@minValue(0)
@maxValue(maxPrompts)
scalar PromptCount extends int32;

@minValue(0)
@maxValue(maxUsageTokens)
scalar TokenCount extends int64;

@minLength(1)
@maxLength(maxMemoryTag)
@pattern("^[a-z0-9][a-z0-9._:/-]*$")
scalar MemoryTag extends string;

@minLength(1)
@maxLength(maxMemoryName)
@pattern("^[a-z0-9]+(-[a-z0-9]+)*$")
scalar MemoryName extends string;

@minLength(1)
@maxLength(maxMemoryDescription)
scalar MemoryDescription extends string;

@maxLength(maxMemoryBody)
scalar MemoryBody extends string;

model AppendRecords {
  @minLength(1)
  file: string;

  @minValue(0)
  from: int32;

  @minItems(1)
  @maxItems(maxRecordsPerAppend)
  records: TranscriptLine[];

  @doc("""
    Whether a line break closes the last record this append carries. Records join with one break
    between them and a file is the records of it laid out that way, so the break that ends the
    file is the one thing no ordinal says: a transcript always ends on one, and a tool output the
    session stopped writing part way through a line does not.
    """)
  closed: boolean;
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
  first: FocusText;
  latest: FocusText;
}

model SessionSync {
  @minLength(1)
  host: SessionText;

  cwd: SessionText;
  repo: SessionText;
  branch: SessionText;
  commit: SessionText;
  startedAt: offsetDateTime;
  lastActivityAt: offsetDateTime;
  prompts: PromptCount;
  focus: SessionFocus;
  mode: SessionMode;
  permissionMode: SessionText;

  @minValue(0)
  pid: safeint;
}

model UsageDelta {
  @minValue(0)
  seq: safeint;

  @minLength(1)
  host: SessionText;

  repo: SessionText;

  @minLength(1)
  provider: SessionText;

  @minLength(1)
  account: SessionText;

  @minLength(1)
  `model`: SessionText;

  prompts: PromptCount;
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  cacheWriteTokens: TokenCount;
  cacheReadTokens: TokenCount;
  at: offsetDateTime;
  durable: boolean;

  @maxItems(maxCountedFiles)
  files: string[];
}

model Device {
  @minLength(1)
  deviceId: string;

  name: SessionText;

  @minLength(1)
  host: SessionText;

  @minLength(1)
  hostLabel: SessionText;

  createdAt: int64;
  lastUsedAt: int64;
  current: boolean;
}

model Session {
  @minLength(1)
  sessionId: string;

  name: SessionText;
  agentName: SessionText;

  @minLength(1)
  deviceId: string;

  host: SessionText;
  hostLabel: SessionText;
  cwd: SessionText;
  repo: SessionText;
  branch: SessionText;
  commit: SessionText;
  startedAt: offsetDateTime;
  lastActivityAt: offsetDateTime;
  prompts: PromptCount;
  focus: SessionFocus;
  mode: SessionMode;
  permissionMode: SessionText;

  @minValue(0)
  pid: safeint;

  current: boolean;
}

model PastSession {
  @minLength(1)
  sessionId: string;

  name: SessionText;
  agentName: SessionText;
  host: SessionText;
  hostLabel: SessionText;
  cwd: SessionText;
  repo: SessionText;
  branch: SessionText;
  startedAt: offsetDateTime;
  lastActivityAt: offsetDateTime;
  prompts: PromptCount;
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
  memoryName: MemoryName;
}

model Memory {
  @minLength(1)
  memoryId: string;

  memoryName: MemoryName;
  description: MemoryDescription;
  type: MemoryType;
  body: MemoryBody;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];

  createdAt: int64;
  updatedAt: int64;

  @minValue(0)
  recallCount: int32;
}

model SaveMemory {
  description: MemoryDescription;
  type: MemoryType;
  body: MemoryBody;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];
}

model ListMemories {
  @maxItems(maxMemoryTags)
  tags: MemoryTag[];

  type: MemoryType[];
  since: offsetDateTime;

  @minValue(1)
  @maxValue(maxListRows)
  limit: int32;

  cursor: string;
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
  memoryName: MemoryName;
  type: MemoryType;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];

  description: MemoryDescription;
}

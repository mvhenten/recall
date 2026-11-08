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
const maxCopyIds = 50;

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

@doc("""
  The id one row of either store is known by: a version 5 uuid over the row written out by
  `src/row-digest.ts`. The copy derives it on the server from the row itself and never takes one
  from a caller, so an id is a reading of a row and not a claim about one.
  """)
@pattern("^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
scalar RowId extends string;

@doc("What became of one row the copy offered the object.")
enum CopyOutcome {
  @doc("The object held no row under this id and holds one now.")
  Stored,

  @doc("""
    The object already held this row, so the copy refused it rather than writing over it. An
    expected answer and not a fault: a second pass of the copy reads it for every row it brought
    over the first time.
    """)
  AlreadyStored,

  @doc("""
    Another row stands where this one belongs. The object neither held this row nor took it, so
    what D1 holds did not cross and the id says which row to read.
    """)
  Blocked,
}

model CopiedRow {
  rowId: RowId;
  outcome: CopyOutcome;
}

@doc("The tables the move into a tenant's own object left behind in D1, in the order the copy walks them.")
enum CopyTable {
  Sessions,
  History,
  Index,
  Records,
  OpenChunks,
  CountedFiles,
  UsageEvents,
  UsageDaily,
  Labels,
  BoardMessages,
  BoardPickups,
  Chunks,
}

@doc("""
  What one table did. `stored` and `alreadyStored` are counted off the answer the object gave for
  each row and nothing else; `blocked` is the rows that did not cross, and `blockedIds` names as
  many of them as the cap allows so an operator can read them out of D1. The two row counts are
  there to be looked at and carry nothing: the object writes its own rows into these tables after
  the cutover, so a table it has outgrown D1 on reads as arrived whether or not a row ever crossed.
  """)
model CopiedTable {
  table: CopyTable;
  stored: safeint;
  alreadyStored: safeint;
  blocked: safeint;

  @maxItems(maxCopyIds)
  blockedIds: RowId[];

  @doc("""
    Ids D1's own rows share, which two rows of one table cannot do: every column that identifies a
    row is written into its id. A repeat is the serialiser collapsing two rows into one id, which
    would hide a row that never crossed, and is a different fault to a row that did not cross.
    """)
  collided: safeint;

  @maxItems(maxCopyIds)
  collidedIds: RowId[];

  inAccount: safeint;
  inTenant: safeint;
}

model CopySessions {
  @doc("Where the walk of the prose opens: the chunk sequence a call of this run answered with.")
  @minValue(0)
  after: safeint;

  @doc("""
    Whether a call of this run has already written every table but the prose. Only a call that
    answered can say so — the tables are written before a response is built — and no count of the
    object could stand in for it.
    """)
  metadataComplete: boolean;
}

@doc("What SQLite made of a full-text index against the rows it indexes, and whether it read it at all.")
model CopyIndexCheck {
  corrupt: boolean;
  error: string;
}

model CopiedChunks {
  stored: safeint;
  alreadyStored: safeint;
  inAccount: safeint;

  @doc("Copied chunks that could not keep the ordinal D1 gave them, the object holding that one already.")
  shifted: safeint;

  @doc("The object's own chunks moved up the sequence to free a key a copied one came in under.")
  moved: safeint;

  frontier: safeint;
  done: boolean;
}

model CopyChecks {
  missing: string[];
  extra: string[];
  missingChunks: safeint;
  embeddings: safeint[];
  chunkIndex: CopyIndexCheck;
  historyIndex: CopyIndexCheck;

  @doc("What this call can account for, which is everything but how much of the prose the run walked.")
  ok: boolean;
}

model SessionCopy {
  @minLength(1)
  userId: string;

  tables: CopiedTable[];
  metadataComplete: boolean;
  chunks: CopiedChunks;
  straddling: string[];
  checks: CopyChecks;
}

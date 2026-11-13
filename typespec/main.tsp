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
const maxSearchResults = 25;
const maxInjectHits = 10;
const maxListRows = 100;
const maxPeekDigest = 2000;

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

@doc("""
  What one session was doing when it was peeked at, in a few sentences. A summariser on that
  session's host writes it from the tail of the transcript, so the session's own context never
  carries it.
  """)
@maxLength(maxPeekDigest)
scalar PeekDigest extends string;

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

enum PeekState {
  Pending,
  Ready,
}

@doc("""
  One peek a session was asked for. A request is `Pending` and carries no digest; the host's
  summariser answers it and the peek reads `Ready`. A session that never answers leaves the request
  pending until the history drops it. The state is the digest read as one of two words, so the two
  can never disagree.
  """)
model Peek {
  @minLength(1)
  peekId: string;

  state: PeekState;
  digest: PeekDigest;
  requestedAt: offsetDateTime;
}

@doc("What a summariser puts back on the peek it was handed.")
model WritePeek {
  digest: PeekDigest;
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

@doc("""
  What a deliberate search asks for. Breadth is the default: an empty `scope` searches every
  memory this account holds. `preferScope` is a sort key and never a filter, so a memory from
  another repo that answers the query well is ranked below the ones from here rather than dropped.
  """)
model SearchMemories {
  @minLength(1)
  @maxLength(maxMemoryQuery)
  query: string;

  @doc("Narrows the search to memories carrying one of these tags. An empty list searches every memory.")
  @maxItems(maxMemoryTags)
  scope: MemoryTag[];

  @doc("Ranks memories carrying one of these tags above the rest, score settling each group. An empty list ranks on score alone.")
  @maxItems(maxMemoryTags)
  preferScope: MemoryTag[];

  @minValue(1)
  @maxValue(maxSearchResults)
  limit: int32;

  @minValue(-1)
  @maxValue(1)
  minScore: float64;

  mode: SearchMode;
}

model MemoryHit {
  memory: Memory;
  score: float64;

  @doc("Whether this memory carries one of the tags `preferScope` named.")
  inScope: boolean;
}

@doc("One scope the match set holds, and how many of the matches carry it.")
model ScopeCount {
  scope: MemoryTag;

  @minValue(1)
  count: int32;
}

@doc("""
  What a search answers with. `count` and `scopes` cover the whole match set; `results` is the
  first page of it, ranked. A caller reading a `count` in the hundreds narrows with a `scope` the
  `scopes` list named rather than paging blind.
  """)
model SearchResults {
  @minValue(0)
  count: int32;

  @maxItems(maxSearchResults)
  results: MemoryHit[];

  scopes: ScopeCount[];
}

@doc("""
  What the prompt hook asks for on every prompt. It searches every memory and never filters:
  `preferScope` carries where the caller is, and ranks those memories above the rest.
  """)
model InjectMemories {
  @minLength(1)
  @maxLength(maxMemoryQuery)
  query: string;

  @maxItems(maxMemoryTags)
  preferScope: MemoryTag[];

  @minValue(1)
  @maxValue(maxInjectHits)
  limit: int32;

  @doc("""
    The cosine similarity a memory must reach to count as a match. It bounds the work and not just
    the answer: every match has its scope read whether or not it is shown, so a floor near zero
    reads the tags of the whole corpus to put at most ten memories in front of a prompt. `limit`
    bounds what comes back, never what is read.
    """)
  @minValue(-1)
  @maxValue(1)
  minScore: float64;
}

@doc("One memory worth putting in front of a prompt, without its body: enough to decide whether to read it.")
model InjectedMemory {
  score: float64;
  memoryName: MemoryName;
  type: MemoryType;

  @maxItems(maxMemoryTags)
  tags: MemoryTag[];

  description: MemoryDescription;
  inScope: boolean;
}

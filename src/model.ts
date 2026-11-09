import { isStretchName } from "./transcript-plan";
import { MAX_STRETCH_BYTES } from "./transcripts";
import type { Speaker } from "./turns";

export const memoryTypes = ["user", "feedback", "project", "reference"] as const;
export const modes = ["hybrid", "vector", "text"] as const;

// The tag a memory carries when it belongs to no repository.
export const GLOBAL_TAG = "global";

export type MemoryType = (typeof memoryTypes)[number];
export type Mode = (typeof modes)[number];

export interface Memory {
  memoryId: string;
  userId: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  recallCount: number;
  lastRecalledAt: number;
}

export interface SaveInput {
  description: string;
  type: MemoryType;
  body: string;
  tags: string[];
}

export interface SearchInput {
  query: string;
  tags: string[];
  limit: number;
  minScore: number;
  mode: Mode;
}

export interface ListInput {
  tags: string[];
  types: MemoryType[];
  since: number;
  cursor: string;
  limit: number;
  sort: string;
}

export interface MemoryHit {
  memory: Memory;
  score: number;
}

export interface MemoryCounts {
  total: number;
  recalled: number;
  fresh: number;
  byType: Array<{ type: MemoryType; count: number }>;
}

export const FRESH_WINDOW_DAYS = 30;
export const FRESH_WINDOW_MS = FRESH_WINDOW_DAYS * 86_400_000;
export const DEFAULT_MIN_SCORE = 0.55;
export const MAX_QUERY_CHARS = 2_000;

// Embedding is batched because indexing a session asks for a hundred vectors at once and one call
// per chunk would be a hundred round trips. A memory asks for one and takes the first back.
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const sessionModes = ["interactive", "headless", ""] as const;

export type SessionMode = (typeof sessionModes)[number];

export const SESSION_TTL_MS = 86_400_000;
// How long after its last prompt a session still reads as busy. Both sides derive busy and idle on
// read, never storing either.
export const IDLE_AFTER_MS = 300_000;
export const MAX_SESSION_TEXT_CHARS = 500;

export interface Focus {
  first: string;
  latest: string;
}

export interface SessionInput {
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  commit: string;
  startedAt: number;
  lastActivityAt: number;
  prompts: number;
  focus: Focus;
  mode: SessionMode;
  permissionMode: string;
  pid: number;
}

export interface Session extends SessionInput {
  sessionId: string;
  name: string;
  agentName: string;
  deviceId: string;
}

export interface Live {
  sessions: number;
  busy: number;
  sessionsToday: number;
  today: ModelTotals[];
}

export interface PastSession {
  sessionId: string;
  name: string;
  agentName: string;
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  startedAt: number;
  lastActivityAt: number;
  prompts: number;
  focus: Focus;
  running: boolean;
}

// One session a search found, and the stretch of it that answered. The excerpt is a chunk of the
// transcript verbatim rather than a summary: it says why the session was returned, and nothing in
// recall ever writes prose a session did not.
export interface SessionHit {
  session: PastSession;
  score: number;
  excerpt: { speaker: Speaker; text: string; at: number };
}

export interface SessionSearch {
  query: string;
  limit: number;
}

export interface HistoryFilters {
  hosts: string[];
  repos: string[];
}

export interface HistoryInput {
  host: string;
  repo: string;
  cursor: string;
  limit: number;
  sort: string;
  query: string;
}

export const labelKinds = ["host", "account"] as const;

export type LabelKind = (typeof labelKinds)[number];

export interface Label {
  kind: LabelKind;
  value: string;
  label: string;
}

// The friendly name a user gave a raw host or account, looked up by the raw value. A value with no
// label is absent rather than held as a blank, so every page falls back to the raw value.
export interface Labels {
  hosts: Map<string, string>;
  accounts: Map<string, string>;
}

export interface LabelTargets {
  hosts: string[];
  accounts: string[];
}

// Raw events are detail and the daily rollup is the long window, so events past two weeks are
// dropped and every window wider than that reads only usage_daily. A durable event is the
// exception: its chunk number is derived from the transcript it was read out of, so the same
// reading arrives again whenever that host backfills, and the row is the only thing that can tell
// the rollup it has already counted it. One row per model, day and file is small enough to keep.
export const USAGE_RETENTION_MS = 1_209_600_000;

// The client dates its own deltas and the rollup is unbounded, so one delta dated 1970 would
// stretch every month the insights page draws. recall did not exist before 2020, and a host's clock
// may run a little fast but never a day fast. A backfill of real months still lands inside this.
export const USAGE_EPOCH = Date.UTC(2020, 0, 1);

export interface UsageInput {
  seq: number;
  host: string;
  repo: string;
  provider: string;
  account: string;
  model: string;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  at: number;
  durable: boolean;
  files: string[];
}

export const DAY_MS = 86_400_000;

export const usageDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export const usageDayStart = (at: number): number => at - (at % DAY_MS);

export const usageMonth = (at: number): string => new Date(at).toISOString().slice(0, 7);

// Every month from the first to the last, so a quiet month in between reads as a gap in the trend
// rather than closing it up.
export const monthsBetween = (first: string, last: string): string[] => {
  if (first === "") return [];
  const year = Number(first.slice(0, 4));
  const index = Number(first.slice(5, 7)) - 1;
  const span: string[] = [];
  for (let step = 0; ; step += 1) {
    const month = usageMonth(Date.UTC(year, index + step, 1));
    if (month > last) return span;
    span.push(month);
  }
};

// The three windows the stats page answers over. Today is the UTC day the rollup keys on; the
// wider two are inclusive of today, so seven days means today and the six before it.
export const USAGE_WEEK_DAYS = 7;
export const USAGE_CHART_DAYS = 14;
export const USAGE_MONTH_DAYS = 30;
export const STALE_AFTER_DAYS = 60;
export const NEVER_RECALLED_AFTER_DAYS = 14;

// One window, derived once and read everywhere: the UTC days the rollup is keyed by and the epoch
// bounds the session tables are keyed by, so a page never slices usage by one day and sessions by
// another.
export interface DayWindow {
  days: string[];
  from: string;
  to: string;
  since: number;
  until: number;
}

export const dayWindow = (now: number, days: number): DayWindow => {
  const since = usageDayStart(now) - (days - 1) * DAY_MS;
  const span = Array.from({ length: days }, (_, index) => usageDay(since + index * DAY_MS));
  return {
    days: span,
    from: span[0] ?? usageDay(now),
    to: span.at(-1) ?? usageDay(now),
    since,
    until: now,
  };
};

export interface TokenCounts {
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface ModelTotals extends TokenCounts {
  provider: string;
  model: string;
}

// One bucket of the rollup: a UTC day for the windows, a month for the long horizon.
export interface ModelBucket extends ModelTotals {
  bucket: string;
}

export type UsageSplitField = "host" | "repo" | "account";

export interface UsageSplit extends ModelTotals {
  field: UsageSplitField;
  value: string;
}

// What one session spent on one model, under the account that paid for it.
export interface SessionSpend extends ModelTotals {
  account: string;
}

export interface DaySessions {
  day: string;
  sessions: number;
}

export interface RepoHours {
  repo: string;
  ms: number;
  sessions: number;
}

export interface RhythmCell {
  weekday: number;
  hour: number;
  sessions: number;
}

export interface RecalledMemory {
  name: string;
  recalls: number;
}

export interface WorkingSet {
  entries: RecalledMemory[];
  recalls: number;
}

export interface StaleMemory {
  name: string;
  recalled: boolean;
  lastRecalledAt: number;
  createdAt: number;
}

export interface GoingStale {
  entries: StaleMemory[];
  atRisk: number;
  total: number;
}

export interface StatsWindows {
  month: DayWindow;
  fortnight: DayWindow;
  week: DayWindow;
  prior: DayWindow;
}

export interface Stats {
  windows: StatsWindows;
  usage: ModelBucket[];
  splits: UsageSplit[];
  sessions: DaySessions[];
}

export interface Insights {
  fortnight: DayWindow;
  usage: ModelBucket[];
  monthly: ModelBucket[];
  working: WorkingSet;
  stale: GoingStale;
  repos: RepoHours[];
  allTime: RepoHours[];
  rhythm: RhythmCell[];
}

// The handle that addresses one session: its device name and the head of its session id. It is a
// function of the session alone, so it names the same session for as long as that session runs and
// never moves to another one.
export const sessionHandle = (deviceName: string, sessionId: string): string =>
  `${deviceName}-${sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 4)}`;

// Who an Access assertion names. A browser sign-in carries an email and a service token carries the
// common name Access derives from its client id, so the two never share one shape with a blank half.
export type Principal = { kind: "email"; email: string } | { kind: "serviceToken"; commonName: string };

export type Verification = { ok: true; principal: Principal } | { ok: false; reason: string };

export type Verify = (assertion: string) => Promise<Verification>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG = /^[a-z0-9][a-z0-9._:/-]*$/;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export const parseName = (name: string): Parsed<string> =>
  name.length <= 100 && NAME.test(name) ? { ok: true, value: name } : fail("name must be a kebab-case slug");

export const parseTags = (value: unknown): Parsed<string[]> => {
  if (!Array.isArray(value) || value.length > 50) return fail("tags must be an array of at most 50 strings");
  const tags = new Set<string>();
  for (const raw of value) {
    const tag = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (tag.length > 200 || !TAG.test(tag)) {
      return fail(`tag ${JSON.stringify(raw)} may hold lower-case letters, digits and . _ : / -`);
    }
    tags.add(tag);
  }
  return { ok: true, value: [...tags].sort() };
};

export const parseSearch = (body: unknown): Parsed<SearchInput> => {
  if (!isRecord(body)) return fail("body must be a JSON object");
  const { query, any, limit, minScore, mode } = body;
  if (typeof query !== "string" || query.length < 1 || query.length > MAX_QUERY_CHARS) {
    return fail(`query must hold 1 to ${MAX_QUERY_CHARS} characters`);
  }
  const tags = parseTags(body.tags);
  if (!tags.ok) return tags;
  if (typeof any !== "boolean" || any === tags.value.length > 0) {
    return fail("tags: pass at least one tag, or any: true with no tags to match every memory");
  }
  if (!isInteger(limit, 1, 50)) return fail("limit must be a whole number from 1 to 50");
  if (typeof minScore !== "number" || minScore < -1 || minScore > 1) return fail("minScore must be between -1 and 1");
  if (!isOneOf(modes, mode)) return fail(`mode must be one of ${modes.join(", ")}`);
  return { ok: true, value: { query, tags: tags.value, limit, minScore, mode } };
};

export const parseTypes = (values: string[]): Parsed<MemoryType[]> => {
  const types = new Set<MemoryType>();
  for (const value of values) {
    if (!isOneOf(memoryTypes, value)) return fail(`type must be one of ${memoryTypes.join(", ")}`);
    types.add(value);
  }
  return { ok: true, value: [...types] };
};

export const LIST_PARAMS = ["tag", "type", "since", "limit"] as const;

export const DEFAULT_PAGE_ROWS = 20;

// The sort a list reads in is settled by the listing component, which owns the parameter name and
// the keys, and arrives here already folded onto one the list holds. These parsers carry it so the
// page reader picks its index off the same value the control marks.
export const parseList = (params: URLSearchParams, sort: string): Parsed<ListInput> => {
  const given = (name: string): string[] => params.getAll(name).filter((value) => value !== "");
  const tags = parseTags(given("tag"));
  if (!tags.ok) return tags;
  const types = parseTypes(given("type"));
  if (!types.ok) return types;
  const since = Number(params.get("since") ?? 0);
  const limit = Number(params.get("limit") ?? DEFAULT_PAGE_ROWS);
  if (!isInteger(since, 0, Number.MAX_SAFE_INTEGER)) return fail("since must be a whole number of epoch milliseconds");
  if (!isInteger(limit, 1, 100)) return fail("limit must be a whole number from 1 to 100");
  return {
    ok: true,
    value: { tags: tags.value, types: types.value, since, cursor: params.get("cursor") ?? "", limit, sort },
  };
};

export const HISTORY_PARAMS = ["host", "repo", "limit"] as const;

export const parseHistory = (params: URLSearchParams, sort: string): Parsed<HistoryInput> => {
  const host = params.get("host") ?? "";
  const repo = params.get("repo") ?? "";
  if (host.length > MAX_SESSION_TEXT_CHARS || repo.length > MAX_SESSION_TEXT_CHARS) {
    return fail(`host and repo must each hold at most ${MAX_SESSION_TEXT_CHARS} characters`);
  }
  const limit = Number(params.get("limit") ?? DEFAULT_PAGE_ROWS);
  if (!isInteger(limit, 1, 100)) return fail("limit must be a whole number from 1 to 100");
  const query = params.get("q") ?? "";
  if (query.length > MAX_QUERY_CHARS) return fail(`q must hold at most ${MAX_QUERY_CHARS} characters`);
  return { ok: true, value: { host, repo, cursor: params.get("cursor") ?? "", limit, sort, query } };
};

// The labels form names each field for the raw value it labels, as <kind>:<value>, so a submission
// carries no ordering the parser has to trust and the form's own fields are skipped by name. An
// empty label clears the one on record rather than storing a blank.
export const parseLabels = (form: URLSearchParams): Parsed<Label[]> => {
  const labels: Label[] = [];
  for (const [field, text] of form) {
    const colon = field.indexOf(":");
    const kind = colon === -1 ? "" : field.slice(0, colon);
    if (!isOneOf(labelKinds, kind)) continue;
    const value = field.slice(colon + 1);
    if (value.length < 1 || value.length > MAX_SESSION_TEXT_CHARS) {
      return fail(`a ${kind} must hold 1 to ${MAX_SESSION_TEXT_CHARS} characters`);
    }
    const label = text.trim();
    if (label.length > MAX_SESSION_TEXT_CHARS) {
      return fail(`a label must hold at most ${MAX_SESSION_TEXT_CHARS} characters`);
    }
    labels.push({ kind, value, label });
  }
  return { ok: true, value: labels };
};

export const parseSessionSearch = (params: URLSearchParams): Parsed<SessionSearch> => {
  const query = params.get("q") ?? "";
  if (query.length < 1 || query.length > MAX_QUERY_CHARS) return fail(`q must hold 1 to ${MAX_QUERY_CHARS} characters`);
  const limit = Number(params.get("limit") ?? 10);
  if (!isInteger(limit, 1, 50)) return fail("limit must be a whole number from 1 to 50");
  return { ok: true, value: { query, limit } };
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const parseSessionId = (value: string): Parsed<string> =>
  SESSION_ID.test(value) ? { ok: true, value } : fail("the session id may hold 1 to 100 letters, digits, - and _");

export const TRANSCRIPT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

// Which of a session's transcript files a stretch belongs to: `main` for the session's own, and one
// name per delegated turn. It becomes part of an object key, so a name that could reach out of the
// session's own prefix is refused.
export const parseTranscriptFile = (value: string | null): Parsed<string> =>
  value !== null && TRANSCRIPT_FILE.test(value)
    ? { ok: true, value }
    : fail("file must open with a letter or digit and hold at most 101 of letters, digits, . _ and -");

export const parseStretchOffset = (value: string | null): Parsed<number> => {
  const offset = Number(value);
  return value !== null && value !== "" && isInteger(offset, 0, Number.MAX_SAFE_INTEGER)
    ? { ok: true, value: offset }
    : fail("offset must be a whole number of bytes into the file");
};

const RECORD_WINDOW = /^([0-9]{1,16})\.([0-9]{1,16})$/;

export interface RecordWindowAsked {
  from: number;
  through: number;
}

// Which records of a file a reader is asking for: the ordinal the window opens at, and the one
// past its last record. A record is addressed by its place in the file and never by a byte of it,
// so a window of one carries no offset and no length in bytes at all.
export const parseRecordWindow = (value: string | null): Parsed<RecordWindowAsked> => {
  const found = value === null ? null : RECORD_WINDOW.exec(value);
  const from = Number(found?.[1]);
  const through = Number(found?.[2]);
  if (!isInteger(from, 0, Number.MAX_SAFE_INTEGER) || !isInteger(through, from + 1, Number.MAX_SAFE_INTEGER)) {
    return fail("records must name a window as <from>.<through>, two whole ordinals with through past from");
  }
  return { ok: true, value: { from, through } };
};

// How many records of a file a box following it has read. It is a count and a place at once: the
// records of a file are its lines in the order they were written, so the record at that ordinal is
// the next one the box has not seen.
export const parseRecordCursor = (value: string | null): Parsed<number> => {
  const ordinal = Number(value);
  return value !== null && value !== "" && isInteger(ordinal, 0, Number.MAX_SAFE_INTEGER)
    ? { ok: true, value: ordinal }
    : fail("since must be a whole number of records into the file");
};

// Which stretch of a file a reader is asking for, named the way the archive stores it. It is the
// name and never a place in the archive: where a redacted stretch sits there is the sizes of the
// stretches in front of it, which the manifest the reader is reading against already said.
export const parseStretchName = (value: string | null): Parsed<string> =>
  value !== null && isStretchName(value)
    ? { ok: true, value }
    : fail("at must name a stretch, as <start>, <start>.<end> or <start>.<end>.<inflates> in sixteen digits each");

// Which stretch a box following a file has read to the end of, and nothing when it has read nothing
// of it. It is what bounds the listing a beat pays for: a stretch keyed by both its ends sits where
// the sizes of the stretches in front of it put it, and this says which those are without the beat
// listing them.
export const parseStretchCursor = (value: string | null): Parsed<string> =>
  value === null || value === "" || isStretchName(value)
    ? { ok: true, value: value ?? "" }
    : fail("after must name a stretch, as <start>, <start>.<end> or <start>.<end>.<inflates> in sixteen digits each");

const BYTE_RANGE = /^bytes=([0-9]{1,16})-([0-9]{1,16})$/;

export interface ByteRange {
  offset: number;
  length: number;
}

// The one range shape a reader of the archive asks for: both ends named, and neither open. A
// suffix range or an open end would have the answer's length depend on how long the stretch turned
// out to be, and the reader already knows that from the manifest it is reading against.
export const parseByteRange = (header: string | null): Parsed<ByteRange> => {
  const found = BYTE_RANGE.exec(header ?? "");
  const first = Number(found?.[1]);
  const last = Number(found?.[2]);
  return found !== null &&
    isInteger(first, 0, Number.MAX_SAFE_INTEGER) &&
    isInteger(last, first, first + MAX_STRETCH_BYTES - 1)
    ? { ok: true, value: { offset: first, length: last - first + 1 } }
    : fail(`range must be bytes=<first>-<last>, spanning at most ${MAX_STRETCH_BYTES} bytes`);
};

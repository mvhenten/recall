export const memoryTypes = ["user", "feedback", "project", "reference"] as const;
const modes = ["hybrid", "vector", "text"] as const;

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
const MAX_QUERY_CHARS = 2_000;

// Embedding is batched because indexing a session asks for a hundred vectors at once and one call
// per chunk would be a hundred round trips. A memory asks for one and takes the first back.
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const sessionModes = ["interactive", "headless", ""] as const;

export type SessionMode = (typeof sessionModes)[number];

export const SESSION_TTL_MS = 86_400_000;
// The five minutes of IDLE_AFTER in cli/src/sessions.rs, which is the original: both sides derive
// busy and idle on read and must agree on where the line falls.
export const IDLE_AFTER_MS = 300_000;
export const MAX_FOCUS_CHARS = 200;
export const MAX_SESSION_TEXT_CHARS = 500;
export const MAX_PROMPTS = 1_000_000;

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
  excerpt: { speaker: string; text: string; at: number };
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
export const MAX_USAGE_TOKENS = 1_000_000_000;

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

export type Verification = { ok: true; email: string } | { ok: false; reason: string };

export type Verify = (assertion: string) => Promise<Verification>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG = /^[a-z0-9][a-z0-9._:/-]*$/;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

const isInteger = (value: unknown, min: number, max: number): value is number =>
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

export const parseSave = (body: unknown): Parsed<SaveInput> => {
  if (!isRecord(body)) return fail("body must be a JSON object");
  const { description, type, tags } = body;
  if (typeof description !== "string" || description.length < 1 || description.length > 500) {
    return fail("description must hold 1 to 500 characters");
  }
  if (!isOneOf(memoryTypes, type)) return fail(`type must be one of ${memoryTypes.join(", ")}`);
  if (typeof body.body !== "string" || body.body.length > 100_000) {
    return fail("body must be a string of at most 100000 characters");
  }
  const parsedTags = parseTags(tags);
  if (!parsedTags.ok) return parsedTags;
  return { ok: true, value: { description, type, body: body.body, tags: parsedTags.value } };
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

export const parseList = (params: URLSearchParams): Parsed<ListInput> => {
  const given = (name: string): string[] => params.getAll(name).filter((value) => value !== "");
  const tags = parseTags(given("tag"));
  if (!tags.ok) return tags;
  const types = parseTypes(given("type"));
  if (!types.ok) return types;
  const since = Number(params.get("since") ?? 0);
  const limit = Number(params.get("limit") ?? 20);
  if (!isInteger(since, 0, Number.MAX_SAFE_INTEGER)) return fail("since must be a whole number of epoch milliseconds");
  if (!isInteger(limit, 1, 100)) return fail("limit must be a whole number from 1 to 100");
  return {
    ok: true,
    value: { tags: tags.value, types: types.value, since, cursor: params.get("cursor") ?? "", limit },
  };
};

export const HISTORY_PARAMS = ["host", "repo", "limit"] as const;

export const parseHistory = (params: URLSearchParams): Parsed<HistoryInput> => {
  const host = params.get("host") ?? "";
  const repo = params.get("repo") ?? "";
  if (host.length > MAX_SESSION_TEXT_CHARS || repo.length > MAX_SESSION_TEXT_CHARS) {
    return fail(`host and repo must each hold at most ${MAX_SESSION_TEXT_CHARS} characters`);
  }
  const limit = Number(params.get("limit") ?? 20);
  if (!isInteger(limit, 1, 100)) return fail("limit must be a whole number from 1 to 100");
  return { ok: true, value: { host, repo, cursor: params.get("cursor") ?? "", limit } };
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

export const sessionScopes = ["live", "history", "search"] as const;
export type SessionScope = (typeof sessionScopes)[number];

// Which sessions a listing covers: the ones running now, every one the account has on record, or
// the ones a query finds by meaning. A scope this service does not know is refused rather than
// read as the default, so a client asking for a listing it cannot give never takes the live
// sessions for the whole span.
export const parseSessionScope = (value: string | null): Parsed<SessionScope> => {
  if (value === null || value === "") return { ok: true, value: "live" };
  if (!isOneOf(sessionScopes, value)) return fail(`scope must be one of ${sessionScopes.join(", ")}`);
  return { ok: true, value };
};

export const parseSessionSearch = (params: URLSearchParams): Parsed<SessionSearch> => {
  const query = params.get("q") ?? "";
  if (query.length < 1 || query.length > MAX_QUERY_CHARS) return fail(`q must hold 1 to ${MAX_QUERY_CHARS} characters`);
  const limit = Number(params.get("limit") ?? 10);
  if (!isInteger(limit, 1, 50)) return fail("limit must be a whole number from 1 to 50");
  return { ok: true, value: { query, limit } };
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

export const parseSessionId = (value: string): Parsed<string> =>
  SESSION_ID.test(value) ? { ok: true, value } : fail("the session id may hold 1 to 100 letters, digits, - and _");

const TRANSCRIPT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

// A session delegates plenty of turns, and each writes a file; far past this the delta is not one
// this service wrote the rules for.
export const MAX_COUNTED_FILES = 500;

// Which of a session's transcript files a stretch belongs to: `main` for the session's own, and one
// name per delegated turn. It becomes part of an object key, so a name that could reach out of the
// session's own prefix is refused.
export const parseTranscriptFile = (value: string | null): Parsed<string> =>
  value !== null && TRANSCRIPT_FILE.test(value)
    ? { ok: true, value }
    : fail("file must open with a letter or digit and hold at most 101 of letters, digits, . _ and -");

// The transcript files one delta read, which is what says their tokens are counted. A delta that
// names none is one from a client that does not read them apart, and counts for no file.
export const parseCountedFiles = (value: unknown): Parsed<string[]> => {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_COUNTED_FILES) {
    return fail(`files must be an array of at most ${MAX_COUNTED_FILES} transcript file names`);
  }
  const files = new Set<string>();
  for (const raw of value) {
    const file = parseTranscriptFile(typeof raw === "string" ? raw : null);
    if (!file.ok) return file;
    files.add(file.value);
  }
  return { ok: true, value: [...files] };
};

export const parseChunkOffset = (value: string | null): Parsed<number> => {
  const offset = Number(value);
  return value !== null && value !== "" && isInteger(offset, 0, Number.MAX_SAFE_INTEGER)
    ? { ok: true, value: offset }
    : fail("offset must be a whole number of bytes into the file");
};

const parseFocus = (value: unknown): Parsed<Focus> => {
  if (!isRecord(value) || !isText(value.first, MAX_FOCUS_CHARS) || !isText(value.latest, MAX_FOCUS_CHARS)) {
    return fail(`focus must be {first, latest}, each a string of at most ${MAX_FOCUS_CHARS} characters`);
  }
  return { ok: true, value: { first: value.first, latest: value.latest } };
};

export const parseSession = (body: unknown): Parsed<SessionInput> => {
  if (!isRecord(body)) return fail("body must be a JSON object");
  const { host, cwd, repo, branch, commit, startedAt, lastActivityAt, prompts, mode, permissionMode, pid } = body;
  if (!isText(host, MAX_SESSION_TEXT_CHARS) || host.length < 1) {
    return fail(`host must hold 1 to ${MAX_SESSION_TEXT_CHARS} characters`);
  }
  const text = (field: string): { ok: false; error: string } =>
    fail(`${field} must be a string of at most ${MAX_SESSION_TEXT_CHARS} characters, empty when it does not apply`);
  if (!isText(cwd, MAX_SESSION_TEXT_CHARS)) return text("cwd");
  if (!isText(repo, MAX_SESSION_TEXT_CHARS)) return text("repo");
  if (!isText(branch, MAX_SESSION_TEXT_CHARS)) return text("branch");
  if (!isText(commit, MAX_SESSION_TEXT_CHARS)) return text("commit");
  if (!isText(permissionMode, MAX_SESSION_TEXT_CHARS)) return text("permissionMode");
  const epoch = (value: unknown): value is number => isInteger(value, 0, Number.MAX_SAFE_INTEGER);
  if (!epoch(startedAt) || !epoch(lastActivityAt)) {
    return fail("startedAt and lastActivityAt must be whole numbers of epoch milliseconds");
  }
  if (!isInteger(prompts, 0, MAX_PROMPTS)) return fail(`prompts must be a whole number from 0 to ${MAX_PROMPTS}`);
  if (!isOneOf(sessionModes, mode))
    return fail("mode must be interactive, headless, or empty when the host cannot tell");
  if (!isInteger(pid, 0, Number.MAX_SAFE_INTEGER)) return fail("pid must be a whole number");
  const focus = parseFocus(body.focus);
  if (!focus.ok) return focus;
  return {
    ok: true,
    value: {
      host,
      cwd,
      repo,
      branch,
      commit,
      startedAt,
      lastActivityAt,
      prompts,
      focus: focus.value,
      mode,
      permissionMode,
      pid,
    },
  };
};

export const parseUsage = (body: unknown, now: number): Parsed<UsageInput> => {
  if (!isRecord(body)) return fail("body must be a JSON object");
  const { seq, host, repo, provider, account, model, prompts, at, durable } = body;
  const { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens } = body;
  if (durable !== undefined && typeof durable !== "boolean") return fail("durable must be true or false");
  const files = parseCountedFiles(body.files);
  if (!files.ok) return files;
  if (!isInteger(seq, 0, Number.MAX_SAFE_INTEGER)) return fail("seq must be the whole number of a delta in a session");
  if (!isText(host, MAX_SESSION_TEXT_CHARS) || host.length < 1) {
    return fail(`host must hold 1 to ${MAX_SESSION_TEXT_CHARS} characters`);
  }
  if (!isText(repo, MAX_SESSION_TEXT_CHARS)) {
    return fail(`repo must be a string of at most ${MAX_SESSION_TEXT_CHARS} characters, empty when it does not apply`);
  }
  if (!isText(provider, MAX_SESSION_TEXT_CHARS) || provider.length < 1) {
    return fail(`provider must hold 1 to ${MAX_SESSION_TEXT_CHARS} characters`);
  }
  if (!isText(model, MAX_SESSION_TEXT_CHARS) || model.length < 1) {
    return fail(`model must hold 1 to ${MAX_SESSION_TEXT_CHARS} characters`);
  }
  if (!isText(account, MAX_SESSION_TEXT_CHARS) || account.length < 1) {
    return fail(`account must hold 1 to ${MAX_SESSION_TEXT_CHARS} characters`);
  }
  if (!isInteger(prompts, 0, MAX_PROMPTS)) return fail(`prompts must be a whole number from 0 to ${MAX_PROMPTS}`);
  if (!isInteger(at, USAGE_EPOCH, now + DAY_MS)) {
    return fail("at must be a whole number of epoch milliseconds, no earlier than 2020 and no more than a day ahead");
  }
  const counter = (value: unknown): value is number => isInteger(value, 0, MAX_USAGE_TOKENS);
  if (!counter(inputTokens) || !counter(outputTokens) || !counter(cacheWriteTokens) || !counter(cacheReadTokens)) {
    return fail(
      `inputTokens, outputTokens, cacheWriteTokens and cacheReadTokens must each be a whole number from 0 to ${MAX_USAGE_TOKENS}`,
    );
  }
  return {
    ok: true,
    value: {
      seq,
      host,
      repo,
      provider,
      account,
      model,
      prompts,
      at,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      durable: durable === true,
      files: files.value,
    },
  };
};

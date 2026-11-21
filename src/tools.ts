import type { Device } from "./device";
import {
  type DayWindow,
  daysBetween,
  dayWindow,
  GLOBAL_TAG,
  isRepoTag,
  type Labels,
  MAX_SESSION_TEXT_CHARS,
  type Memory,
  type MemoryType,
  type Mode,
  type ModelTotals,
  memoryTypes,
  modes,
  type Parsed,
  type Peek,
  parseTags,
  pending,
  REPO_TAG,
  repoLabel,
  type Session,
  type SessionUsage,
  type SessionUsageQuery,
  USAGE_MONTH_DAYS,
  type UsagePeriod,
  type UsageQuery,
  type UsageRow,
  usageDay,
  usagePeriods,
} from "./model";
import { groupBy, type ModelReport, modelReports, type TokenReport, tokenReport, turnsIn } from "./usage";
import { sessionNameOf, type V2Device, type V2Peek, type V2Session } from "./v2";

// The tool names cli/src/mcp.rs serves, with their schemas written out here. The Rust side derives
// its own from #[tool] macros, so the two sets are maintained separately and the wording differs
// where this end has no repo tag to read: both search every memory, but there a search ranks the
// current repo's first and here it ranks by score alone, and a project or reference save is
// refused here rather than tagged. A tool added to one side is therefore a known gap on the other
// until it is added there too. Publishing takes HTML content here instead of a disk path, since
// this end holds no working copy. The two listings are this end's own: a harness with a shell runs recall
// sessions and recall devices for them, and one without a shell had no way at all to learn what it
// can send to.

export interface SearchArgs {
  query: string;
  mode: Mode;
  scope: string[];
}

export interface NameArgs {
  name: string;
}

export interface ListArgs {
  tags: string[];
  since: number;
  limit: number;
}

export interface SaveArgs {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  tags: string[];
}

export interface EditArgs {
  name: string;
  description: string | undefined;
  type: MemoryType | undefined;
  body: string | undefined;
  addTags: string[];
  removeTags: string[];
}

export interface SendArgs {
  to: string;
  message: string;
}

export interface PeekArgs {
  session: string;
}

// What a per-session call asks for: the read's own query, plus the session it was asked about by
// whatever name the caller had for it, which is resolved to an id before the read.
export interface SessionUsageArgs extends Omit<SessionUsageQuery, "sessionId"> {
  session: string;
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

// What a connector's search answers with, the same five the stdio server asks for. A result
// carries the whole memory, so this is spent straight out of the agent's context window.
export const SEARCH_LIMIT = 5;
const LIST_LIMIT = 20;

const text = (description: string): Record<string, unknown> => ({ type: "string", description });
const strings = (description: string): Record<string, unknown> => ({
  type: "array",
  items: { type: "string" },
  description,
});
const flag = (description: string): Record<string, unknown> => ({ type: "boolean", description });

const schema = (properties: Record<string, unknown>, required: string[] = []): ToolSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const NAME_SCHEMA = schema({ name: text("The memory's kebab-case name.") }, ["name"]);

export const TOOLS: ToolDefinition[] = [
  {
    name: "recall_publish",
    description:
      "Publish self-contained HTML as a private site with index.html. A new site uses its name as title. Republishing your own site replaces its HTML at the same URL, preserving title, description, permissions, shares and creation time. Refuses non-sites and other users' artifacts. Returns ArtifactView metadata, never the HTML.",
    inputSchema: schema(
      {
        name: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 16_777_216,
          description:
            "Self-contained HTML, nonblank, at most 16,777,216 UTF-8 encoded bytes (inclusive). Preserved verbatim.",
        },
      },
      ["name", "content"],
    ),
  },
  {
    name: "recall_artifacts",
    description:
      "List your published artifacts. Returns {artifacts: ArtifactView[], nextCursor, total, cut}. Pass nextCursor for the next page; an empty cursor ends pagination.",
    inputSchema: schema({
      query: { type: "string", maxLength: 2_000, default: "" },
      type: { type: "string", enum: ["site", "document", "audio"] },
      sort: { type: "string", enum: ["newest", "name", "largest"], default: "newest" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      cursor: { type: "string", maxLength: 2_048, default: "" },
    }),
  },
  {
    name: "recall_search",
    description:
      "Search every memory the user holds. Returns {count, results, scopes}: count is every match, results the five best by score, and scopes the tags those matches carry with a count each. A count in the hundreds means narrowing with one of the scopes rather than paging.",
    inputSchema: schema(
      {
        query: text("What to look for, in plain words or an exact identifier."),
        mode: {
          type: "string",
          enum: [...modes],
          description:
            "hybrid (default) ranks by meaning and words; text matches exact identifiers; vector by meaning only.",
        },
        scope: strings("Narrow the search to these tags. Omit to search every memory."),
      },
      ["query"],
    ),
  },
  {
    name: "recall_get",
    description: "Read one memory in full by its name.",
    inputSchema: NAME_SCHEMA,
  },
  {
    name: "recall_list",
    description:
      "List memories, newest created first. Covers every memory unless tags is given. Use recall_search to find memories by topic.",
    inputSchema: schema({
      tags: strings("List only memories carrying one of these tags."),
      since: text("Only memories created at or after this ISO 8601 time, date or epoch ms."),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "At most this many, newest first (default 20).",
      },
    }),
  },
  {
    name: "recall_save",
    description:
      "Save a new memory. Search first: if a memory on the topic exists, use recall_edit instead of saving a duplicate. user and feedback memories are global by default; a project or reference memory needs a scope, and this connector reads none off a working copy, so name the repo tag in tags, as repo:github.com/owner/project, or pass global: true.",
    inputSchema: schema(
      {
        name: text("Unique kebab-case name; saving an existing name replaces that memory."),
        description: text("One line that says when this memory is relevant."),
        type: {
          type: "string",
          enum: [...memoryTypes],
          description:
            "user: who the user is; feedback: how the user wants you to work; project: ongoing work and decisions; reference: where to find things.",
        },
        body: text("The memory in markdown."),
        tags: strings("Extra free-form tags."),
        global: flag("Tag it global. Defaults to true for user and feedback, false otherwise."),
      },
      ["name", "description", "type", "body"],
    ),
  },
  {
    name: "recall_edit",
    description:
      "Change an existing memory. Only the fields you pass change; body replaces the whole body. Renaming is not supported: save under the new name and delete the old one.",
    inputSchema: schema(
      {
        name: text("The memory to change."),
        description: text("New one-line description."),
        type: { type: "string", enum: [...memoryTypes], description: "New type." },
        body: text("New markdown body, replacing the old one."),
        add_tags: strings("Tags to add."),
        remove_tags: strings("Tags to remove."),
      },
      ["name"],
    ),
  },
  {
    name: "recall_delete",
    description: "Delete a memory that turned out wrong or no longer holds.",
    inputSchema: NAME_SCHEMA,
  },
  {
    name: "recall_sessions",
    description:
      "List the live Claude Code sessions on every host signed in as this user, newest activity first. Each one carries the name it was given, the handle recall_send and recall_peek take, the host it runs on, the directory it works in and the prompt it is working on.",
    inputSchema: schema({}),
  },
  {
    name: "recall_devices",
    description:
      "List the hosts signed in as this user. Each one names a host recall_send reaches every live session on, by its label, its device name or its device id.",
    inputSchema: schema({}),
  },
  {
    name: "recall_send",
    description:
      "Message one Claude Code session running on a host signed in as this user, named by the handle recall_sessions shows, or every session on a host named by its label or as recall_devices shows it. The message arrives as a user turn there. recall_peek says what one session is doing without interrupting it.",
    inputSchema: schema(
      {
        to: text(
          "The session to reach, named by the handle or the name recall_sessions shows, or a host to reach every session on it.",
        ),
        message: text("The message to deliver there."),
      },
      ["to", "message"],
    ),
  },
  {
    name: "recall_peek",
    description:
      "Ask one Claude Code session on a host signed in as this user what it is working on right now. A side process on that session's host summarises the end of its transcript and writes the digest back: the session is not interrupted, is not messaged, and carries none of this in its context, so a peek costs that session nothing. Returns the peek with state Ready and the digest once its host has answered, which takes a few seconds, and state Pending where it had not answered in that time. Use it to see what a session is doing before sending it anything with recall_send.",
    inputSchema: schema(
      {
        session: text(
          "The session to ask, named by the handle or the name recall_sessions shows, or by its session id. A host is not a peek target: one summariser answers for one session.",
        ),
      },
      ["session"],
    ),
  },
  {
    name: "recall_usage",
    description:
      "What the user's Claude Code sessions have spent, off the same rollup the dashboard's stats page draws. Input, output, cache-read and cache-write tokens are each kept apart — a cache read costs a tenth of fresh input, so the mix is the whole of a price comparison — alongside a total, the cache-hit rate, the turn count and the cost at Anthropic's list prices. One window at day, week or month grain, optionally narrowed to one repository, returned broken down three ways over the same rows: by bucket, by repository and by model. A model with no entry in the price table reports cost null and is named in unpricedModels, never counted as free; a breakdown mixing priced and unpriced models marks costIsFloor. Figures cover what the hosts have flushed: a session's subagent transcripts are counted alongside its main one from recall v0.9.0 (issue #58), so a host still on an older release reports only its main thread and reads low. Read-only.",
    inputSchema: schema({
      from: text("First UTC day to count, as an ISO 8601 date or time, or epoch ms. Defaults to 30 days back."),
      to: text("Last UTC day to count, inclusive. Defaults to today."),
      period: {
        type: "string",
        enum: [...usagePeriods],
        description: "Bucket grain: day (default), week starting Monday, or month.",
      },
      repo: text(
        "Count only this repository, named as recorded (repo:github.com/owner/project) or by any unambiguous tail of it, such as owner/project or project. Omit to count every repository.",
      ),
    }),
  },
  {
    name: "recall_session_usage",
    description:
      "What each session spent, newest activity first: the same four token classes and cost as recall_usage, plus the turn count, the models that answered, the accounts billed, the start and end time, the repository, the working directory and the host. Name one session by the name or the handle a listing shows it under, or by its session id, or take every session whose life overlaps the window, narrowed by repository. What a session spent is bounded by the window too, so the two tools reconcile over the same days. Per-session detail comes from the raw events, which are swept after two weeks unless the reading was taken from a transcript, so an older session can report less than it spent and one whose events are gone reports zero rather than dropping out of the list. Same price table and the same subagent caveat as recall_usage. Read-only.",
    inputSchema: schema({
      session: text(
        "One session, by the name or the handle a listing shows it under, or by its session id. Omit to take every session.",
      ),
      from: text(
        "Count sessions active at or after this ISO 8601 date or time, or epoch ms. Defaults to 30 days back.",
      ),
      to: text("Count sessions that opened on or before this UTC day, inclusive. Defaults to today."),
      repo: text("Only sessions in this repository, named the way recall_usage takes it."),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "At most this many sessions, newest activity first (default 20).",
      },
    }),
  },
];

const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const toolArguments = (definition: ToolDefinition, params: unknown): Parsed<Record<string, unknown>> => {
  if (params === undefined) return { ok: true, value: {} };
  if (!isRecord(params)) return fail(`${definition.name} takes its arguments as a JSON object`);
  const unknown = Object.keys(params).filter((field) => !Object.hasOwn(definition.inputSchema.properties, field));
  if (unknown.length > 0) return fail(`${definition.name} takes no argument ${unknown.join(", ")}`);
  for (const field of definition.inputSchema.required ?? []) {
    if (params[field] === undefined) return fail(`${definition.name} needs ${field}`);
  }
  return { ok: true, value: params };
};

const optionalText = (value: unknown, field: string, max: number): Parsed<string | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    return fail(`${field} must hold 1 to ${max} characters`);
  }
  return { ok: true, value };
};

const requiredText = (value: unknown, field: string, max: number): Parsed<string> => {
  const parsed = optionalText(value, field, max);
  if (!parsed.ok) return parsed;
  return parsed.value === undefined
    ? fail(`${field} must hold 1 to ${max} characters`)
    : { ok: true, value: parsed.value };
};

const optionalType = (value: unknown, field: string): Parsed<MemoryType | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  const found = memoryTypes.find((type) => type === value);
  return found === undefined ? fail(`${field} must be one of ${memoryTypes.join(", ")}`) : { ok: true, value: found };
};

const optionalFlag = (value: unknown, field: string): Parsed<boolean | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "boolean" ? { ok: true, value } : fail(`${field} must be true or false`);
};

const tagList = (value: unknown, field: string): Parsed<string[]> => {
  if (value === undefined) return { ok: true, value: [] };
  const parsed = parseTags(value);
  return parsed.ok ? parsed : fail(`${field}: ${parsed.error}`);
};

// A memory is saved under a scope: the global tag, or a repo tag naming the working copy it
// belongs to. The stdio server reads that tag off the directory it runs in; this end has no
// working copy, so the caller names it in `tags` and a save that names one is scoped by it alone.
export const saveTags = (type: MemoryType, global: boolean | undefined, extra: string[]): Parsed<string[]> => {
  const isGlobal = global ?? (type === "user" || type === "feedback");
  if (isGlobal) return { ok: true, value: extra.includes(GLOBAL_TAG) ? extra : [...extra, GLOBAL_TAG].sort() };
  if (extra.some(isRepoTag)) return { ok: true, value: extra };
  return fail(
    `a ${type} memory needs a scope, and this connector runs in no repository: name the repo tag in tags, as ${REPO_TAG}github.com/owner/project, or pass global: true`,
  );
};

// Every tool that takes an instant takes it in the three forms a model writes one in. The field
// is named by its caller, so a bad `to` is refused as `to` and not as the first field that ever
// took an instant.
export const parseSinceArgument = (value: unknown, field = "since"): Parsed<number> => {
  if (value === undefined) return { ok: true, value: 0 };
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? { ok: true, value } : fail(`${field} must be epoch milliseconds`);
  }
  if (typeof value !== "string") return fail(`${field} must be an ISO 8601 time, date or epoch ms`);
  if (/^\d+$/.test(value)) return { ok: true, value: Number(value) };
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed)
    ? fail(`${field} ${value} is neither epoch ms nor ISO 8601`)
    : { ok: true, value: parsed };
};

// No scope means every memory. A search that quietly covered global alone answered a question
// nobody asked, and the count and the scopes it answers with are what narrow the next call.
export const parseSearchArgs = (args: Record<string, unknown>): Parsed<SearchArgs> => {
  const query = requiredText(args.query, "query", 2_000);
  if (!query.ok) return query;
  const scope = tagList(args.scope, "scope");
  if (!scope.ok) return scope;
  const mode = args.mode === undefined ? "hybrid" : modes.find((known) => known === args.mode);
  if (mode === undefined) return fail(`mode must be one of ${modes.join(", ")}`);
  return { ok: true, value: { query: query.value, mode, scope: scope.value } };
};

export const parseNameArgs = (args: Record<string, unknown>): Parsed<NameArgs> => {
  const name = requiredText(args.name, "name", 100);
  return name.ok ? { ok: true, value: { name: name.value } } : name;
};

export const parseListArgs = (args: Record<string, unknown>): Parsed<ListArgs> => {
  const tags = tagList(args.tags, "tags");
  if (!tags.ok) return tags;
  const since = parseSinceArgument(args.since);
  if (!since.ok) return since;
  const limit = args.limit ?? LIST_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return fail("limit must be a whole number from 1 to 100");
  }
  return { ok: true, value: { tags: tags.value, since: since.value, limit } };
};

export const parseSaveArgs = (args: Record<string, unknown>): Parsed<SaveArgs> => {
  const name = requiredText(args.name, "name", 100);
  if (!name.ok) return name;
  const description = requiredText(args.description, "description", 500);
  if (!description.ok) return description;
  const type = optionalType(args.type, "type");
  if (!type.ok) return type;
  if (type.value === undefined) return fail(`type must be one of ${memoryTypes.join(", ")}`);
  const body = requiredText(args.body, "body", 100_000);
  if (!body.ok) return body;
  const extra = tagList(args.tags, "tags");
  if (!extra.ok) return extra;
  const global = optionalFlag(args.global, "global");
  if (!global.ok) return global;
  const tags = saveTags(type.value, global.value, extra.value);
  if (!tags.ok) return tags;
  return {
    ok: true,
    value: { name: name.value, description: description.value, type: type.value, body: body.value, tags: tags.value },
  };
};

export const parseEditArgs = (args: Record<string, unknown>): Parsed<EditArgs> => {
  const name = requiredText(args.name, "name", 100);
  if (!name.ok) return name;
  const description = optionalText(args.description, "description", 500);
  if (!description.ok) return description;
  const type = optionalType(args.type, "type");
  if (!type.ok) return type;
  const body = optionalText(args.body, "body", 100_000);
  if (!body.ok) return body;
  const addTags = tagList(args.add_tags, "add_tags");
  if (!addTags.ok) return addTags;
  const removeTags = tagList(args.remove_tags, "remove_tags");
  if (!removeTags.ok) return removeTags;
  if (
    description.value === undefined &&
    type.value === undefined &&
    body.value === undefined &&
    args.add_tags === undefined &&
    args.remove_tags === undefined
  ) {
    return fail("nothing to change; pass description, type, body, add_tags or remove_tags");
  }
  return {
    ok: true,
    value: {
      name: name.value,
      description: description.value,
      type: type.value,
      body: body.value,
      addTags: addTags.value,
      removeTags: removeTags.value,
    },
  };
};

export const parseSendArgs = (args: Record<string, unknown>): Parsed<SendArgs> => {
  const to = requiredText(args.to, "to", 500);
  if (!to.ok) return to;
  const message = requiredText(args.message, "message", 32_768);
  if (!message.ok) return message;
  return { ok: true, value: { to: to.value, message: message.value } };
};

export const parsePeekArgs = (args: Record<string, unknown>): Parsed<PeekArgs> => {
  const session = requiredText(args.session, "session", 500);
  return session.ok ? { ok: true, value: { session: session.value } } : session;
};

const USAGE_SESSION_LIMIT = 20;

// A date argument names a UTC day, whichever of the three forms it arrives in: the rollup is keyed
// by day, so a time of day inside one is the day it falls in, and a window names its two ends.
const usageWindow = (args: Record<string, unknown>, now: number): Parsed<DayWindow> => {
  const span = dayWindow(now, USAGE_MONTH_DAYS);
  const from = parseSinceArgument(args.from, "from");
  if (!from.ok) return from;
  const to = parseSinceArgument(args.to, "to");
  if (!to.ok) return to;
  const first = args.from === undefined ? span.from : usageDay(from.value);
  const last = args.to === undefined ? span.to : usageDay(to.value);
  if (first > last) return fail(`from ${first} falls after to ${last}`);
  return { ok: true, value: daysBetween(first, last) };
};

// A repository the caller never named is null, which counts every one of them. The empty tag is a
// repository of its own — a reading taken outside a working copy — so the two can never be the
// same value.
const askedRepo = (args: Record<string, unknown>): Parsed<string | null> => {
  const repo = optionalText(args.repo, "repo", MAX_SESSION_TEXT_CHARS);
  return repo.ok ? { ok: true, value: repo.value ?? null } : repo;
};

export const parseUsageArgs = (args: Record<string, unknown>, now: number): Parsed<UsageQuery> => {
  const window = usageWindow(args, now);
  if (!window.ok) return window;
  const repo = askedRepo(args);
  if (!repo.ok) return repo;
  const period = args.period === undefined ? "day" : usagePeriods.find((known) => known === args.period);
  if (period === undefined) return fail(`period must be one of ${usagePeriods.join(", ")}`);
  return { ok: true, value: { window: window.value, repo: repo.value, period } };
};

export const parseSessionUsageArgs = (args: Record<string, unknown>, now: number): Parsed<SessionUsageArgs> => {
  const window = usageWindow(args, now);
  if (!window.ok) return window;
  const repo = askedRepo(args);
  if (!repo.ok) return repo;
  const session = optionalText(args.session, "session", MAX_SESSION_TEXT_CHARS);
  if (!session.ok) return session;
  const limit = args.limit ?? USAGE_SESSION_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return fail("limit must be a whole number from 1 to 100");
  }
  return { ok: true, value: { window: window.value, repo: repo.value, session: session.value ?? "", limit } };
};

// What a caller may call the repository recorded outside any working copy.
const GLOBAL_REPO = ["global", "none"];

// A repository is recorded as the tag the host read off its working copy, and a person names it by
// whatever tail of that they think of it as. One unambiguous tail resolves; a name that answers for
// two repositories is refused naming both, rather than reporting one of them as the whole truth.
export const matchRepo = (repos: string[], wanted: string): Parsed<string> => {
  const name = wanted.trim().toLowerCase();
  if (GLOBAL_REPO.includes(name)) {
    return repos.includes("") ? { ok: true, value: "" } : fail("no usage is recorded outside a repository");
  }
  const found = repos.filter((repo) => {
    const tag = (repo.startsWith(REPO_TAG) ? repo.slice(REPO_TAG.length) : repo).toLowerCase();
    return repo.toLowerCase() === name || tag === name || tag.endsWith(`/${name}`);
  });
  const [only] = found;
  if (only === undefined) {
    return fail(
      repos.length === 0
        ? "no usage is recorded for this account yet"
        : `no repository named ${wanted}; usage is recorded for ${repos.map(repoLabel).join(", ")}`,
    );
  }
  return found.length === 1
    ? { ok: true, value: only }
    : fail(`${wanted} names ${found.length} repositories: ${found.join(", ")}`);
};

// A reading at one grain: the four token classes, the cost, and the turns that bought them. Turns
// are counted at this grain alone and never per model — a delta carries the whole stretch's prompt
// count on the first model that answered in it, so splitting it by model would invent a number.
export interface UsageTotals extends TokenReport {
  turns: number;
}

const usageTotals = (rows: ModelTotals[]): UsageTotals => ({ ...tokenReport(rows), turns: turnsIn(rows) });

export interface UsageBucketReport extends UsageTotals {
  bucket: string;
}

export interface UsageRepoReport extends UsageTotals {
  repo: string;
}

export interface UsageReport {
  from: string;
  to: string;
  period: UsagePeriod;
  repo: string | null;
  totals: UsageTotals;
  buckets: UsageBucketReport[];
  repos: UsageRepoReport[];
  models: ModelReport[];
}

export const usageReport = (query: UsageQuery, rows: UsageRow[]): UsageReport => ({
  from: query.window.from,
  to: query.window.to,
  period: query.period,
  repo: query.repo,
  totals: usageTotals(rows),
  buckets: groupBy(rows, (row) => row.bucket)
    .map(([bucket, found]) => ({ bucket, ...usageTotals(found) }))
    .sort((left, right) => (left.bucket < right.bucket ? -1 : 1)),
  repos: groupBy(rows, (row) => row.repo)
    .map(([repo, found]) => ({ repo, ...usageTotals(found) }))
    .sort((left, right) => right.totalTokens - left.totalTokens),
  models: modelReports(rows),
});

export interface SessionUsageReport extends TokenReport {
  sessionId: string;
  name: string;
  agentName: string;
  host: string;
  cwd: string;
  repo: string;
  startedAt: string;
  lastActivityAt: string;
  running: boolean;
  turns: number;
  accounts: string[];
  models: ModelReport[];
}

// `turns` is the session's own prompt count and not a sum over its spend: a session whose events
// have been swept still knows how many turns it took.
export const sessionUsageReport = (usage: SessionUsage): SessionUsageReport => {
  const { session, spend } = usage;
  return {
    sessionId: session.sessionId,
    name: session.name,
    agentName: session.agentName,
    host: session.host,
    cwd: session.cwd,
    repo: session.repo,
    startedAt: new Date(session.startedAt).toISOString(),
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    running: session.running,
    turns: session.prompts,
    accounts: [...new Set(spend.map((row) => row.account))].filter((account) => account !== "").sort(),
    models: modelReports(spend),
    ...tokenReport(spend),
  };
};

// How many times a peek is read back before the caller is told it is still pending, and how long
// the read back waits each time. The summariser runs one Haiku call over the tail of a transcript
// and answers in seven to thirteen seconds, the busiest sessions slowest, so the window covers the
// whole of that spread rather than the middle of it: a read back that gives up at ten seconds
// answers Pending on the slow half and pays for a digest nobody reads. A host slower than the
// whole window is read again by the next call rather than waited on here. api::PEEK_READS and
// api::PEEK_WAIT are the same two on the stdio side.
export const PEEK_READS = 12;
export const PEEK_WAIT_MS = 2_000;

// How young a digest has to be for the next ask to be answered off it rather than pay a summariser
// for another. A minute on, the session has moved and what it is doing is worth asking again.
export const PEEK_FRESH_MS = 60_000;

// How young a request has to be for an ask to wait on it rather than start a second summarise over
// the same transcript. The bound is the run's own: a host gives its summariser two minutes
// (`TIMEOUT` in cli/src/peek.rs) and writes the digest whenever it lands inside that, so a request
// younger than that is a run still going and an older one is a run that is never answering.
export const PEEK_ATTACH_MS = 120_000;

// The peek an ask takes rather than paying a summariser for another: a digest the session answered
// with a moment ago, or a request a summariser is still working on. Taking the pending one is what
// makes the digest a timed out call paid for collectable — the summariser writes onto that row and
// the next ask reads it off the session. The listing is newest first, and an older peek describes
// a session further back, so the newest is the only one worth reading.
export const reusablePeek = (peeks: Peek[], now: number): Peek | null => {
  const newest = peeks[0];
  if (newest === undefined) return null;
  return now - newest.requestedAt < (pending(newest) ? PEEK_ATTACH_MS : PEEK_FRESH_MS) ? newest : null;
};

// Reads one peek back until it holds a digest, at most PEEK_READS times. The wait comes first each
// time, since the host starts the summariser as it reads the frame and the digest is never there
// the instant the ask answers — except where the ask answered with a digest already on record,
// which is read back without waiting at all. The peek the ask wrote is what this gives back where
// the digest never lands, so a request still pending reads as the request it is.
export const readBackPeek = async (
  asked: V2Peek,
  read: () => Promise<V2Peek | null>,
  wait: (ms: number) => Promise<void>,
): Promise<V2Peek> => {
  if (asked.state === "Ready") return asked;
  let held = asked;
  for (let taken = 0; taken < PEEK_READS; taken += 1) {
    await wait(PEEK_WAIT_MS);
    const found = await read();
    if (found === null) return held;
    if (found.state === "Ready") return found;
    held = found;
  }
  return held;
};

// What a listing hands the model: the fields its tool description names, and not the whole view
// the dashboard reads off the same route. `host` is the label the account gave the machine, which
// recall_send takes as an address, as it takes both of a session's names.
export interface SessionDigest {
  name: string;
  handle: string;
  host: string;
  cwd: string;
  focus: string;
}

export interface DeviceDigest {
  deviceId: string;
  name: string;
  host: string;
}

// `name` is the name the service resolved for the session, which is what cli/src/markdown.rs
// prints in its name column and what the dashboard puts on every row.
export const sessionDigest = (session: V2Session): SessionDigest => ({
  name: session.label,
  handle: session.name,
  host: session.hostLabel,
  cwd: session.cwd,
  focus: session.focus.latest,
});

export const deviceDigest = (device: V2Device): DeviceDigest => ({
  deviceId: device.deviceId,
  name: device.name,
  host: device.hostLabel,
});

// `handles` is what the send reaches: the live sessions listed on that host at send time, or the
// one session the target named. The message is written once either way, to the host's mailbox.
export interface SendTarget {
  toDeviceId: string;
  toSessionId: string;
  handles: string[];
}

// A device id, a login name, a host or a host's label reaches every session on that machine; a
// session handle, a session id or the name the service resolved for the session reaches the one
// session. api::resolve_target in the CLI reads the same two listings in the same order and
// resolves a machine's newest login.
//
// Hosts and sessions are named by their owner out of one vocabulary, so a name that answers in
// both is refused and names what it found rather than letting the host win and leaving the session
// unreachable. A device id is exact and answers before any of it.
//
// Case never settles a match: this end is dictated to as often as it is typed at, and a voice
// transcript capitalises what it hears, so Sandbox has to reach the host called sandbox.
export const resolveTarget = (
  devices: Device[],
  labels: Labels,
  sessions: Session[],
  to: string,
): Parsed<SendTarget> => {
  const wanted = to.toLowerCase();
  const names = (value: string | undefined): boolean => value !== undefined && value.toLowerCase() === wanted;
  const onHost = (toDeviceId: string): SendTarget => ({
    toDeviceId,
    toSessionId: "",
    handles: sessions.filter((session) => session.deviceId === toDeviceId).map((session) => session.name),
  });
  const identified = devices.find((device) => names(device.deviceId));
  if (identified !== undefined) return { ok: true, value: onHost(identified.deviceId) };
  const named = devices.filter(
    (device) => names(device.name) || names(device.host) || names(labels.hosts.get(device.host)),
  );
  const addressed = sessions.filter(
    (session) => names(session.name) || names(session.sessionId) || names(sessionNameOf(labels, session)),
  );
  const machines = new Set(named.map((device) => device.host));
  if (named.length > 0 && addressed.length > 0) {
    const found = [
      ...named.map((device) => `${device.name} (${device.deviceId})`),
      ...addressed.map((session) => `${session.name} (${session.sessionId})`),
    ];
    return fail(
      `ambiguous target ${to}: it names ${machines.size} hosts and ${addressed.length} sessions; pass one of these ids instead: ${found.join(", ")}`,
    );
  }
  if (machines.size > 1) {
    return fail(
      `ambiguous target ${to}: it names ${machines.size} hosts; pass one of these device ids instead: ${named
        .map((device) => `${device.name} (${device.deviceId})`)
        .join(", ")}`,
    );
  }
  const [first] = named;
  if (first !== undefined) {
    const newest = named.reduce((best, device) => (device.lastUsedAt > best.lastUsedAt ? device : best), first);
    return { ok: true, value: onHost(newest.deviceId) };
  }
  const [only] = addressed;
  if (addressed.length === 1 && only !== undefined) {
    return { ok: true, value: { toDeviceId: only.deviceId, toSessionId: only.sessionId, handles: [only.name] } };
  }
  if (addressed.length === 0) {
    return fail(
      `no host or session named ${to}; recall_devices lists the hosts signed in as you and recall_sessions the handle of each live session`,
    );
  }
  return fail(
    `ambiguous target ${to}: ${addressed.length} sessions answer to it; pass one of these session ids instead: ${addressed
      .map((session) => session.sessionId)
      .join(", ")}`,
  );
};

export const editedMemory = (memory: Memory, args: EditArgs): SaveArgs => {
  const tags = memory.tags.filter((tag) => !args.removeTags.includes(tag));
  for (const tag of args.addTags) if (!tags.includes(tag)) tags.push(tag);
  return {
    name: memory.name,
    description: args.description ?? memory.description,
    type: args.type ?? memory.type,
    body: args.body ?? memory.body,
    tags,
  };
};

const iso = (ms: number): string => (ms === 0 ? "never" : `${new Date(ms).toISOString().slice(0, 19)}Z`);

// The front matter cli/src/markdown.rs renders, so one memory reads the same whichever lane asked.
export const renderMemory = (memory: Memory): string =>
  [
    "---",
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    `type: ${memory.type}`,
    `tags: [${memory.tags.join(", ")}]`,
    `created: ${iso(memory.createdAt)}`,
    `updated: ${iso(memory.updatedAt)}`,
    `recalled: ${memory.recallCount} times, last ${iso(memory.lastRecalledAt)}`,
    "---",
    "",
    `${memory.body.trimEnd()}\n`,
  ].join("\n");

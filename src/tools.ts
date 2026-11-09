import type { Device } from "./device";
import {
  GLOBAL_TAG,
  type Labels,
  type Memory,
  type MemoryType,
  type Mode,
  memoryTypes,
  modes,
  type Parsed,
  parseTags,
  type Session,
} from "./model";

// The tool names cli/src/mcp.rs serves, with their schemas written out here. The Rust side derives
// its own from #[tool] macros, so the two sets are maintained separately and the wording differs
// where this end has no repo tag to read: a search or a listing that names no tags covers global
// here and the current repo as well there, and a project or reference save is refused here rather
// than tagged. A tool added to one side is therefore a known gap on the other until it is added
// there too. The tools that take a path on disk are not here at all: this end holds no working copy.

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
    name: "recall_search",
    description:
      "Search every memory the user holds. Returns {count, results, scopes}: count is every match, results the first 25 ranked, and scopes the tags those matches carry with a count each. A count in the hundreds means narrowing with one of the scopes rather than paging.",
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
      "Save a new memory. Search first: if a memory on the topic exists, use recall_edit instead of saving a duplicate. user and feedback memories are global by default; project and reference memories need a repo tag, which this connector has none of, so pass global or tags.",
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
    name: "recall_send",
    description:
      "Message one Claude Code session running on a host signed in as this user, named by the handle recall sessions prints, or every session on a host named by its label or as recall devices shows it. The message arrives as a user turn there.",
    inputSchema: schema(
      {
        to: text(
          "The session to reach, named by the handle recall sessions shows, or a host to reach every session on it.",
        ),
        message: text("The message to deliver there."),
      },
      ["to", "message"],
    ),
  },
];

const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const toolArguments = (definition: ToolDefinition, params: unknown): Parsed<Record<string, unknown>> => {
  if (params === undefined) return { ok: true, value: {} };
  if (!isRecord(params)) return fail(`${definition.name} takes its arguments as a JSON object`);
  const unknown = Object.keys(params).filter((field) => !(field in definition.inputSchema.properties));
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

export const saveTags = (type: MemoryType, global: boolean | undefined, extra: string[]): Parsed<string[]> => {
  const scoped = global ?? (type === "user" || type === "feedback");
  if (!scoped) {
    return fail(
      "this connector runs in no repository, so there is no repo tag; pass global: true, or name the repo tag in tags alongside global: true",
    );
  }
  return { ok: true, value: extra.includes(GLOBAL_TAG) ? extra : [...extra, GLOBAL_TAG].sort() };
};

export const parseSinceArgument = (value: unknown): Parsed<number> => {
  if (value === undefined) return { ok: true, value: 0 };
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? { ok: true, value } : fail("since must be epoch milliseconds");
  }
  if (typeof value !== "string") return fail("since must be an ISO 8601 time, date or epoch ms");
  if (/^\d+$/.test(value)) return { ok: true, value: Number(value) };
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed) ? fail(`since ${value} is neither epoch ms nor ISO 8601`) : { ok: true, value: parsed };
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

export interface SendTarget {
  toDeviceId: string;
  toSessionId: string;
}

// A device id, a login name, a host or a host's label reaches every session on that machine; a
// session handle, an agent name or a session id reaches the one session. api::resolve_target in the
// CLI reads the same two listings in the same order and resolves a machine's newest login.
export const resolveTarget = (
  devices: Device[],
  labels: Labels,
  sessions: Session[],
  to: string,
): Parsed<SendTarget> => {
  const identified = devices.find((device) => device.deviceId === to);
  if (identified !== undefined) return { ok: true, value: { toDeviceId: identified.deviceId, toSessionId: "" } };
  const named = devices.filter(
    (device) => device.name === to || device.host === to || labels.hosts.get(device.host) === to,
  );
  const machines = new Set(named.map((device) => device.host));
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
    return { ok: true, value: { toDeviceId: newest.deviceId, toSessionId: "" } };
  }
  const addressed = sessions.filter(
    (session) => session.name === to || session.agentName === to || session.sessionId === to,
  );
  const [only] = addressed;
  if (addressed.length === 1 && only !== undefined) {
    return { ok: true, value: { toDeviceId: only.deviceId, toSessionId: only.sessionId } };
  }
  if (addressed.length === 0) {
    return fail(
      `no host or session named ${to}; recall devices lists the hosts signed in as you and recall sessions the handle of each live session`,
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

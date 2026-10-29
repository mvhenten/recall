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
  since: number;
  cursor: string;
  limit: number;
}

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

export type Verification = { ok: true; clientId: string } | { ok: false; reason: string };

export type Verify = (assertion: string) => Promise<Verification>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG = /^[a-z0-9][a-z0-9._:/-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
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
  if (typeof query !== "string" || query.length < 1 || query.length > 2_000) {
    return fail("query must hold 1 to 2000 characters");
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

export const parseList = (params: URLSearchParams): Parsed<ListInput> => {
  const tags = parseTags(params.getAll("tag"));
  if (!tags.ok) return tags;
  const since = Number(params.get("since") ?? 0);
  const limit = Number(params.get("limit") ?? 20);
  if (!isInteger(since, 0, Number.MAX_SAFE_INTEGER)) return fail("since must be a whole number of epoch milliseconds");
  if (!isInteger(limit, 1, 100)) return fail("limit must be a whole number from 1 to 100");
  return { ok: true, value: { tags: tags.value, since, cursor: params.get("cursor") ?? "", limit } };
};

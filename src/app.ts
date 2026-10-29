import {
  type Embedder,
  type Memory,
  parseList,
  parseName,
  parseSave,
  parseSearch,
  type SearchInput,
  type Verify,
} from "./model";
import { dot, ftsQuery, quantize, reciprocalRankFusion } from "./rank";
import {
  decodeCursor,
  deleteMemory,
  getMemory,
  listMemories,
  recall,
  resolvePrincipal,
  saveMemory,
  textCandidates,
  vectorCandidates,
} from "./store";

export interface Deps {
  verify: Verify;
  embedder: Embedder;
  now: () => number;
}

export interface AppEnv {
  DB: D1Database;
}

export interface App {
  fetch(request: Request, env: AppEnv): Promise<Response>;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const error = (status: number, message: string): Response => json({ error: message }, status);

const readJson = (request: Request): Promise<unknown> => request.json().catch(() => null);

const embeddingText = (name: string, description: string, body: string): string => `${name}\n${description}\n\n${body}`;

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export const createApp = (deps: Deps): App => {
  const authenticate = async (request: Request, db: D1Database): Promise<string | Response> => {
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) {
      return error(401, "missing Cf-Access-Jwt-Assertion; call through Cloudflare Access with a service token");
    }
    const verified = await deps.verify(assertion);
    if (!verified.ok) return error(401, `access token rejected: ${verified.reason}`);
    const userId = await resolvePrincipal(db, verified.clientId);
    if (userId === null) return error(403, "this service token maps to no user; add the user and host to RECALL_USERS");
    return userId;
  };

  const save = async (request: Request, db: D1Database, userId: string, name: string): Promise<Response> => {
    const input = parseSave(await readJson(request));
    if (!input.ok) return error(400, input.error);
    const vector = await deps.embedder.embed(embeddingText(name, input.value.description, input.value.body));
    const saved = await saveMemory(db, userId, name, input.value, quantize(vector), deps.now());
    return json(saved, saved.created ? 201 : 200);
  };

  const list = async (url: URL, db: D1Database, userId: string): Promise<Response> => {
    const input = parseList(url.searchParams);
    if (!input.ok) return error(400, input.error);
    const cursor = decodeCursor(input.value.cursor);
    if (!cursor) return error(400, "cursor is malformed; pass the nextCursor of a previous page");
    return json(await listMemories(db, userId, input.value, cursor));
  };

  const vectorRanking = async (
    db: D1Database,
    userId: string,
    input: SearchInput,
  ): Promise<Array<[string, number]>> => {
    const vector = await deps.embedder.embed(input.query);
    const scored: Array<[string, number]> = [];
    for (const [memoryId, stored] of await vectorCandidates(db, userId, input.tags)) {
      const score = dot(vector, stored);
      if (score >= input.minScore) scored.push([memoryId, score]);
    }
    return scored.sort((a, b) => b[1] - a[1]);
  };

  const textRanking = async (db: D1Database, userId: string, input: SearchInput): Promise<string[]> => {
    const match = ftsQuery(input.query);
    return match ? textCandidates(db, userId, input.tags, match) : [];
  };

  const search = async (request: Request, db: D1Database, userId: string): Promise<Response> => {
    const parsed = parseSearch(await readJson(request));
    if (!parsed.ok) return error(400, parsed.error);
    const input = parsed.value;
    const ranked: Array<[string, number]> =
      input.mode === "vector"
        ? await vectorRanking(db, userId, input)
        : input.mode === "text"
          ? reciprocalRankFusion([await textRanking(db, userId, input)])
          : await Promise.all([vectorRanking(db, userId, input), textRanking(db, userId, input)]).then(
              ([vector, text]) => reciprocalRankFusion([vector.map(([id]) => id), text]),
            );
    const top = ranked.slice(0, input.limit);
    if (top.length === 0) return json({ hits: [] });
    const ids = top.map(([id]) => id);
    const recalled = new Map<string, Memory>(
      (await recall(db, userId, ids, deps.now())).map((memory) => [memory.memoryId, memory]),
    );
    const hits = top.flatMap(([id, score]) => {
      const memory = recalled.get(id);
      return memory ? [{ score, memory }] : [];
    });
    return json({ hits });
  };

  const route = async (request: Request, env: AppEnv): Promise<Response> => {
    const url = new URL(request.url);
    const [version, collection, rawName, ...rest] = url.pathname.split("/").filter((part) => part !== "");
    if (version !== "v1" || rest.length > 0) return error(404, "not found");
    const userId = await authenticate(request, env.DB);
    if (userId instanceof Response) return userId;
    if (collection === "search" && rawName === undefined) {
      return request.method === "POST" ? search(request, env.DB, userId) : error(405, "method not allowed");
    }
    if (collection !== "memories") return error(404, "not found");
    if (rawName === undefined) {
      return request.method === "GET" ? list(url, env.DB, userId) : error(405, "method not allowed");
    }
    const name = parseName(decodeSegment(rawName) ?? "");
    if (!name.ok) return error(400, name.error);
    if (request.method === "PUT") return save(request, env.DB, userId, name.value);
    if (request.method !== "GET" && request.method !== "DELETE") return error(405, "method not allowed");
    const memory = await getMemory(env.DB, userId, name.value);
    if (!memory) return error(404, `no memory named ${name.value}`);
    if (request.method === "GET") return json({ memory });
    await deleteMemory(env.DB, userId, memory.memoryId);
    return new Response(null, { status: 204 });
  };

  return {
    async fetch(request: Request, env: AppEnv): Promise<Response> {
      return route(request, env).catch((failure: unknown) => {
        const requestId = crypto.randomUUID();
        const message = failure instanceof Error ? failure.message : String(failure);
        console.error(
          JSON.stringify({ requestId, error: message, stack: failure instanceof Error ? failure.stack : "" }),
        );
        return json({ error: "internal error", requestId }, 500);
      });
    },
  };
};

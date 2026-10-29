import { Hono } from "hono";
import type { ZodError } from "zod";
import {
  type Embedder,
  listSchema,
  nameSchema,
  type SearchHit,
  saveSchema,
  searchSchema,
  type VectorIndex,
  type Verify,
} from "./model";
import {
  decodeCursor,
  deleteMemory,
  getMemory,
  listMemories,
  memoriesByIds,
  recordRecall,
  resolvePrincipal,
  saveMemory,
} from "./store";

export interface Deps {
  verify: Verify;
  embedder: Embedder;
  index: VectorIndex;
  now: () => number;
}

interface Bindings {
  DB: D1Database;
}

type AppEnv = { Bindings: Bindings; Variables: { userId: string } };

const VECTOR_CANDIDATES = 100;

const invalid = (error: ZodError) => ({
  error: "invalid request",
  issues: error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
});

const embeddingText = (name: string, description: string, body: string): string => `${name}\n${description}\n\n${body}`;

export const createApp = (deps: Deps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ requestId, error: error.message, stack: error.stack }));
    return c.json({ error: "internal error", requestId }, 500);
  });

  app.use("/v1/*", async (c, next) => {
    const assertion = c.req.header("cf-access-jwt-assertion");
    if (!assertion) {
      return c.json(
        { error: "missing Cf-Access-Jwt-Assertion; call through Cloudflare Access with a service token" },
        401,
      );
    }
    const verified = await deps.verify(assertion);
    if (!verified.ok) return c.json({ error: `access token rejected: ${verified.reason}` }, 401);
    const userId = await resolvePrincipal(c.env.DB, verified.clientId);
    if (userId === null) {
      return c.json({ error: "this service token maps to no user; declare it in infra/users.auto.tfvars" }, 403);
    }
    c.set("userId", userId);
    await next();
  });

  app.put("/v1/memories/:name", async (c) => {
    const name = nameSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json(invalid(name.error), 400);
    const input = saveSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json(invalid(input.error), 400);
    const userId = c.get("userId");
    const vector = await deps.embedder.embed(embeddingText(name.data, input.data.description, input.data.body));
    const saved = await saveMemory(c.env.DB, userId, name.data, input.data, deps.now());
    await deps.index.upsert(userId, saved.memory.memoryId, vector);
    return c.json(saved, saved.created ? 201 : 200);
  });

  app.get("/v1/memories/:name", async (c) => {
    const name = nameSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json(invalid(name.error), 400);
    const memory = await getMemory(c.env.DB, c.get("userId"), name.data);
    if (!memory) return c.json({ error: `no memory named ${name.data}` }, 404);
    return c.json({ memory });
  });

  app.delete("/v1/memories/:name", async (c) => {
    const name = nameSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json(invalid(name.error), 400);
    const userId = c.get("userId");
    const memory = await getMemory(c.env.DB, userId, name.data);
    if (!memory) return c.json({ error: `no memory named ${name.data}` }, 404);
    await deleteMemory(c.env.DB, userId, memory.memoryId);
    await deps.index.remove([memory.memoryId]);
    return c.body(null, 204);
  });

  app.get("/v1/memories", async (c) => {
    const input = listSchema.safeParse({
      tag: c.req.queries("tag") ?? [],
      since: c.req.query("since") ?? 0,
      cursor: c.req.query("cursor") ?? "",
      limit: c.req.query("limit") ?? 20,
    });
    if (!input.success) return c.json(invalid(input.error), 400);
    const cursor = decodeCursor(input.data.cursor);
    if (!cursor) return c.json({ error: "cursor is malformed; pass the nextCursor of a previous page" }, 400);
    return c.json(await listMemories(c.env.DB, c.get("userId"), input.data, cursor));
  });

  app.post("/v1/search", async (c) => {
    const input = searchSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json(invalid(input.error), 400);
    const userId = c.get("userId");
    const vector = await deps.embedder.embed(input.data.query);
    const matches = (await deps.index.query(userId, vector, VECTOR_CANDIDATES)).filter(
      (match) => match.score >= input.data.minScore,
    );
    const scores = new Map(matches.map((match) => [match.id, match.score]));
    const memories = await memoriesByIds(c.env.DB, userId, [...scores.keys()], input.data.tags);
    const hits: SearchHit[] = memories
      .map((memory) => ({ memory, score: scores.get(memory.memoryId) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.data.limit);
    const now = deps.now();
    await recordRecall(
      c.env.DB,
      userId,
      hits.map((hit) => hit.memory.memoryId),
      now,
    );
    return c.json({
      hits: hits.map((hit) => ({
        score: hit.score,
        memory: { ...hit.memory, recallCount: hit.memory.recallCount + 1, lastRecalledAt: now },
      })),
    });
  });

  return app;
};

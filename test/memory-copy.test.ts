import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemoryCopyReport } from "../src/memory-copy";
import type { Memory } from "../src/model";
import { quantize } from "../src/rank";
import { type Client, harness, tenantRows, wordEmbedder } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

// What the account remembered before memories moved, as rows of D1. The three text columns overlap
// deliberately: a ranking over one word has to put several rows in an order for comparing the two
// indexes to mean anything, and every row carries a tag so a scoped query ranks differently from
// an unscoped one.
const CORPUS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["rank-the-chunks", "bound the vector scan", "a search ranks the chunks it reads", "search"],
  ["bound-the-scan", "rank the history rows", "the vector scan is bounded before it runs", "search"],
  ["move-the-board", "rank the board", "the board moves into the object it belongs to", "board"],
  ["write-the-migration", "write it once", "the migration is written once and applied once", "store"],
  ["scan-the-archive", "scan it twice", "the archive is scanned twice and ranked once", "search"],
];

// One word each. bm25 weighs a term by how rare it is across the whole index, and D1's index holds
// every account's memories where one object's holds one account's — for a single term that
// difference is one factor applied to every row alike, so the order survives it and a ranked
// comparison across the two stores says something.
const QUERIES = ["rank", "scan", "board", "migration", "archive"];

const RANKING = `SELECT m.memory_id AS id FROM memories_fts f
   JOIN memories m ON m.memory_seq = f.rowid
   WHERE memories_fts MATCH ?2 AND m.user_id = ?1
   ORDER BY bm25(memories_fts, 5.0, 2.0, 1.0) LIMIT 50`;

const INSERT_MEMORY = `INSERT INTO memories (memory_id, user_id, name, description, type, body, embedding,
   created_at, updated_at, recall_count, last_recalled_at)
 VALUES (?1, ?2, ?3, ?4, 'project', ?5, ?6, ?7, ?7, 0, 0)`;

const INSERT_TAG = "INSERT INTO memory_tags (memory_id, tag) VALUES (?1, ?2)";

const AT = 1_700_000_000_000;

// What the Worker embeds a memory with, which the seed has to match so a vector ranking over the
// copy is the one a search would compute.
const embeddingFor = async (name: string, description: string, body: string): Promise<Uint8Array> => {
  const [vector] = await wordEmbedder.embed([`${name}\n${description}\n\n${body}`]);
  if (vector === undefined) throw new Error("the embedder answered no vector");
  return quantize(vector);
};

interface Seeded {
  memoryId: string;
  name: string;
  embedding: Uint8Array;
}

// One memory exactly as the Worker left it in D1: the row, its tag and the vector a search scores
// it by. Nothing writes this layout any more, so a test of the copy has to lay it down itself.
const seedMemory = async (userId: string, suffix: string, entry: (typeof CORPUS)[number]): Promise<Seeded> => {
  const [name, description, body, tag] = entry;
  const taken = `${name}-${suffix}`;
  const memoryId = crypto.randomUUID();
  const embedding = await embeddingFor(taken, description, body);
  await env.DB.prepare(INSERT_MEMORY)
    .bind(memoryId, userId, taken, description, body, embedding.slice().buffer, AT)
    .run();
  await env.DB.prepare(INSERT_TAG).bind(memoryId, tag).run();
  return { memoryId, name: taken, embedding };
};

const seedCorpus = async (userId: string, suffix: string): Promise<Seeded[]> => {
  const seeded: Seeded[] = [];
  for (const entry of CORPUS) seeded.push(await seedMemory(userId, suffix, entry));
  return seeded;
};

const accountRanking = async (userId: string, query: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(RANKING).bind(userId, query).all<{ id: string }>();
  return results.map((row) => row.id);
};

const tenantRanking = async (userId: string, query: string): Promise<string[]> =>
  (await tenantRows<{ id: string }>(userId, RANKING, userId, query)).map((row) => row.id);

const copy = async (client: Client): Promise<MemoryCopyReport> => {
  const response = await client.request("POST", "/v1/memories/copy");
  expect(response.status).toBe(200);
  return response.json();
};

const listed = async (client: Client): Promise<string[]> => {
  const response = await client.request("GET", "/v1/memories?limit=50");
  expect(response.status).toBe(200);
  const page: { memories: Memory[] } = await response.json();
  return page.memories.map((memory) => memory.name).sort();
};

const owner = async (h: Harness): Promise<{ client: Client; email: string }> => {
  const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
  return { client: h.clientWithToken(await h.login(email), await h.userIdFor(email)), email };
};

describe("copying the memories an account held before they moved", () => {
  it("brings every row over under the id its search index ranks by", async () => {
    const h = await harness();
    const { client } = await owner(h);
    const seeded = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    const names = seeded.map((one) => one.name).sort();
    expect(await listed(client)).toEqual([]);

    const report = await copy(client);
    expect(report.userId).toBe(client.userId);
    expect(report.memories).toEqual({ copied: seeded.length, held: 0, superseded: [] });
    expect(report.tags).toEqual({ copied: seeded.length, held: 0 });
    expect(report.moved).toEqual([]);
    expect(report.checks.rows).toEqual({ account: seeded.length, tenant: seeded.length });
    expect(report.checks.tags).toEqual({ account: seeded.length, tenant: seeded.length });
    expect(report.checks.missing).toEqual([]);
    expect(report.checks.extra).toEqual([]);
    expect(report.checks.missingTags).toEqual([]);
    expect(report.checks.embeddings).toEqual([]);
    expect(report.checks.index).toBe("");
    expect(report.checks.queries).toBeGreaterThan(0);
    expect(report.checks.ranking).toEqual([]);
    expect(report.checks.ok).toBe(true);

    expect(await listed(client)).toEqual(names);
    const held = await tenantRows<{ memory_id: string; memory_seq: number }>(
      client.userId,
      "SELECT memory_id, memory_seq FROM memories WHERE user_id = ?1 ORDER BY memory_seq",
      client.userId,
    );
    const { results } = await env.DB.prepare(
      "SELECT memory_id, memory_seq FROM memories WHERE user_id = ?1 ORDER BY memory_seq",
    )
      .bind(client.userId)
      .all<{ memory_id: string; memory_seq: number }>();
    expect(held).toEqual(results);
  });

  it("ranks the same query over the copy the way D1 ranked it", async () => {
    const h = await harness();
    const { client } = await owner(h);
    await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    await copy(client);

    let ordered = 0;
    for (const query of QUERIES) {
      const was = await accountRanking(client.userId, query);
      expect(was, query).not.toEqual([]);
      expect(await tenantRanking(client.userId, query), query).toEqual(was);
      if (was.length > 1) ordered += 1;
    }
    expect(ordered).toBeGreaterThan(0);
  });

  // D1 under miniflare hands a blob back as a number array and in production as an ArrayBuffer;
  // the object's own SQLite hands one back as an ArrayBuffer either way. So the bytes are held
  // against the seed on both sides of the copy: whichever shape the driver gave, the vector that
  // landed is the vector that was saved, and a quantized int8 vector that lost a byte would move
  // every score computed from it.
  it("writes every embedding into the object as the bytes D1 holds", async () => {
    const h = await harness();
    const { client } = await owner(h);
    const seeded = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    await copy(client);

    const rows = await tenantRows<{ memory_id: string; embedding: ArrayBuffer }>(
      client.userId,
      "SELECT memory_id, embedding FROM memories WHERE user_id = ?1",
      client.userId,
    );
    expect(rows).toHaveLength(seeded.length);
    const stored = new Map(rows.map((row) => [row.memory_id, row.embedding]));
    for (const one of seeded) {
      const held = stored.get(one.memoryId);
      expect(held, one.name).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(held ?? new ArrayBuffer(0))], one.name).toEqual([...one.embedding]);
    }
  });

  it("copies nothing the second time and writes no second row or tag", async () => {
    const h = await harness();
    const { client } = await owner(h);
    const seeded = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    await copy(client);

    const again = await copy(client);
    expect(again.memories).toEqual({ copied: 0, held: seeded.length, superseded: [] });
    expect(again.tags).toEqual({ copied: 0, held: seeded.length });
    expect(again.moved).toEqual([]);
    expect(again.checks.ok).toBe(true);

    const counted = await tenantRows<{ rows: number; tags: number }>(
      client.userId,
      `SELECT (SELECT count(*) FROM memories WHERE user_id = ?1) AS rows,
         (SELECT count(*) FROM memory_tags) AS tags`,
      client.userId,
    );
    expect(counted).toEqual([{ rows: seeded.length, tags: seeded.length }]);
  });

  // The object comes into being empty, so a memory saved between the deployment and this run took
  // memory_seq 1 — a number D1 handed out years ago to another memory. The copied row cannot be
  // renumbered, because memory_seq is what memories_fts ranks by, so the newer row moves instead
  // and its index entry moves with it.
  it("moves a memory saved after the cutover off the sequence a copied one needs", async () => {
    const h = await harness();
    const { client } = await owner(h);
    const suffix = crypto.randomUUID().slice(0, 8);
    const fresh = await client.save(`saved-after-the-cutover-${suffix}`, { body: "written once the release was live" });
    const before = await tenantRows<{ memory_seq: number }>(
      client.userId,
      "SELECT memory_seq FROM memories WHERE memory_id = ?1",
      fresh.memoryId,
    );
    // The object came into being empty, so the save took the first key SQLite had to give, and
    // D1 handed that one out long ago.
    expect(before[0]?.memory_seq).toBe(1);
    const seeded = await seedCorpus(client.userId, suffix);

    const report = await copy(client);
    expect(report.moved).toEqual([fresh.memoryId]);
    expect(report.memories.copied).toBe(seeded.length);
    expect(report.checks.missing).toEqual([]);
    expect(report.checks.extra).toEqual([fresh.memoryId]);
    // SQLite's own read of the index `makeRoom` hand-wrote: no entry left at the rowid the mover
    // vacated, and the one it moved to is there.
    expect(report.checks.index).toBe("");
    expect(report.checks.ok).toBe(true);

    // Every copied row kept the key D1 ranks it by, and the moved one sits above all of them.
    const held = new Map(
      (
        await tenantRows<{ memory_id: string; memory_seq: number }>(
          client.userId,
          "SELECT memory_id, memory_seq FROM memories WHERE user_id = ?1",
          client.userId,
        )
      ).map((row) => [row.memory_id, row.memory_seq]),
    );
    const { results } = await env.DB.prepare("SELECT memory_id, memory_seq FROM memories WHERE user_id = ?1")
      .bind(client.userId)
      .all<{ memory_id: string; memory_seq: number }>();
    for (const row of results) expect(held.get(row.memory_id)).toBe(row.memory_seq);
    const moved = held.get(fresh.memoryId) ?? 0;
    expect(moved).toBeGreaterThan(Math.max(...results.map((row) => row.memory_seq)));

    // The moved row is still the one its own words find, which is what says the index entry moved
    // with it rather than being left under a rowid a copied memory now answers to.
    expect(await tenantRanking(client.userId, "cutover")).toEqual([fresh.memoryId]);
  });

  // A memory re-saved after the cutover is the later truth. The D1 row holds the same name under
  // another id, and writing it over the save would hand the account back prose it replaced. It is
  // also the one row the copy leaves behind, so the run does not certify itself: D1 holds the only
  // copy of that prose, and an operator reads it before anything drops the row.
  it("leaves a memory saved after the cutover standing where D1 holds its name, and does not verify", async () => {
    const h = await harness();
    const { client } = await owner(h);
    const suffix = crypto.randomUUID().slice(0, 8);
    const [entry] = CORPUS;
    if (entry === undefined) throw new Error("the corpus is empty");
    const seeded = await seedMemory(client.userId, suffix, entry);
    const resaved = await client.save(seeded.name, { body: "what the account says now" });

    const report = await copy(client);
    expect(report.memories.superseded).toEqual([seeded.memoryId]);
    expect(report.memories.copied).toBe(0);
    expect(report.checks.missing).toEqual([]);
    expect(report.checks.index).toBe("");
    expect(report.checks.ok).toBe(false);
    expect((await client.get(seeded.name)).body).toBe("what the account says now");
    expect(resaved.memoryId).not.toBe(seeded.memoryId);
  });

  // The failure no replayed ranking can see. `makeRoom` writes index entries by hand, and one left
  // behind at a mover's old rowid would answer a later query with the copied memory that now holds
  // that rowid — a memory the ranking comparison leaves out, because D1 never ranked the mover.
  // So the gate asks SQLite instead, and this stands an index in exactly that state: a term under
  // a rowid `memories` does not carry.
  it("fails the run when the full-text index and the rows it indexes disagree", async () => {
    const h = await harness();
    const { client } = await owner(h);
    await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    expect((await copy(client)).checks.index).toBe("");

    await tenantRows(
      client.userId,
      "INSERT INTO memories_fts (rowid, name, description, body) VALUES (99999, ?1, ?1, ?1)",
      "a term no row carries",
    );

    const report = await copy(client);
    expect(report.checks.index).not.toBe("");
    expect(report.checks.ok).toBe(false);
    // Everything the gate could already see still passes, which is what says the index check is
    // the only thing standing between a corrupt index and a run reported as verified.
    expect(report.checks.missing).toEqual([]);
    expect(report.checks.embeddings).toEqual([]);
    expect(report.checks.ranking).toEqual([]);
  });

  it("leaves every D1 row exactly where it was", async () => {
    const h = await harness();
    const { client } = await owner(h);
    const seeded = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    const before = await env.DB.prepare(
      "SELECT memory_id, memory_seq, name, body FROM memories WHERE user_id = ?1 ORDER BY memory_seq",
    )
      .bind(client.userId)
      .all();
    await copy(client);
    await copy(client);

    const after = await env.DB.prepare(
      "SELECT memory_id, memory_seq, name, body FROM memories WHERE user_id = ?1 ORDER BY memory_seq",
    )
      .bind(client.userId)
      .all();
    expect(after.results).toEqual(before.results);
    const tags = await env.DB.prepare(
      "SELECT count(*) AS n FROM memory_tags WHERE memory_id IN (SELECT memory_id FROM memories WHERE user_id = ?1)",
    )
      .bind(client.userId)
      .first<{ n: number }>();
    expect(tags?.n).toBe(seeded.length);
  });

  // The MCP tools call the store in-process rather than over HTTP, so they move with it. A copied
  // memory is one the desktop and browser clients reach through `/mcp` unchanged.
  it("hands a copied memory to the connector's tools", async () => {
    const h = await harness();
    const { client, email } = await owner(h);
    const seeded = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    const first = seeded[0];
    if (first === undefined) throw new Error("the corpus seeded no memory");
    await copy(client);

    // A listing names its tag, because the connector runs in no repository and so scopes itself
    // to `global` where it is given none.
    const tagged = CORPUS.filter(([, , , tag]) => tag === "search").length;
    const mcp = await h.connector(email);
    expect(await mcp.tool("recall_get", { name: first.name })).toContain(first.name);
    const listedByTool: Memory[] = await mcp.json("recall_list", { tags: ["search"] });
    expect(listedByTool).toHaveLength(tagged);
    const found: { hits: Array<{ memory: Memory }> } = await mcp.json("recall_search", {
      query: "archive",
      tags: ["search"],
    });
    expect(found.hits.length).toBeGreaterThan(0);
  });
});

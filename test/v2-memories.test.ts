import { describe, expect, it } from "vitest";
import { parseSearch } from "../src/model";
import { parseSearchMemories } from "../src/v2";
import type { Client } from "./harness";
import { harness } from "./harness";

interface V2Memory {
  memoryId: string;
  memoryName: string;
  description: string;
  type: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  recallCount: number;
}

interface V2Hit {
  memory: V2Memory;
  score: number;
}

const CORPUS = [
  {
    name: "cursor-paging",
    description: "keyset paging over the memories table",
    type: "project" as const,
    body: "the cursor carries the sort key and the row id that breaks a tie on it",
    tags: ["repo:recall", "storage"],
  },
  {
    name: "ranking-fusion",
    description: "reciprocal rank fusion of a vector ranking and a text ranking",
    type: "reference" as const,
    body: "two rankings folded into one by rank and never by score",
    tags: ["search"],
  },
  {
    name: "embedding-quantisation",
    description: "vectors stored as signed bytes",
    type: "reference" as const,
    body: "quantise the vector and keep the dot product honest",
    tags: ["search", "storage"],
  },
  {
    name: "device-grant",
    description: "the device authorisation grant a host signs in with",
    type: "project" as const,
    body: "the host polls while a browser approves the user code",
    tags: ["auth"],
  },
  {
    name: "writing-voice",
    description: "write to be agreed with, not admired",
    type: "user" as const,
    body: "state, do not sell, and say it once",
    tags: ["global"],
  },
  {
    name: "review-threads",
    description: "resolve every thread before merging",
    type: "feedback" as const,
    body: "replying to a review thread is not resolving it",
    tags: ["global", "process"],
  },
];

const corpus = async (client: Client): Promise<void> => {
  for (const memory of CORPUS) {
    await client.save(memory.name, {
      description: memory.description,
      type: memory.type,
      body: memory.body,
      tags: memory.tags,
    });
  }
};

const memoryOf = async (response: Response): Promise<V2Memory> => {
  expect(response.status).toBe(200);
  const read: { memory: V2Memory } = await response.json();
  return read.memory;
};

describe("the /v2 memories", () => {
  it("reads a memory without counting the read", async () => {
    const { user } = await harness();
    const client = await user("pure-read");
    await client.save("still-cold", {});

    expect((await memoryOf(await client.v2.memory("still-cold"))).recallCount).toBe(0);
    expect((await memoryOf(await client.v2.memory("still-cold"))).recallCount).toBe(0);
    expect((await memoryOf(await client.v2.memory("still-cold"))).recallCount).toBe(0);
  });

  it("counts one recall per call and answers with the memory", async () => {
    const { user } = await harness();
    const client = await user("recalling");
    const saved = await client.save("warm-memory", {});

    const first = await memoryOf(await client.v2.recallMemory("warm-memory"));
    expect(first.memoryId).toBe(saved.memoryId);
    expect(first.recallCount).toBe(1);
    expect((await memoryOf(await client.v2.recallMemory("warm-memory"))).recallCount).toBe(2);
    expect((await memoryOf(await client.v2.memory("warm-memory"))).recallCount).toBe(2);

    expect((await client.v2.request("GET", "/v2/memories/warm-memory/recall")).status).toBe(405);
    expect((await client.v2.recallMemory("no-such-memory")).status).toBe(404);
  });

  it("writes, reads back and deletes a memory under its own name", async () => {
    const { user } = await harness();
    const client = await user("round-trip");

    const created = await client.v2.saveMemory("fresh-note", { tags: ["repo:recall", "repo:recall"] });
    expect(created.status).toBe(201);
    const { memory }: { memory: V2Memory } = await created.json();
    expect(memory.memoryName).toBe("fresh-note");
    expect(memory.type).toBe("Project");
    expect(memory.tags).toEqual(["repo:recall"]);

    const replaced = await client.v2.saveMemory("fresh-note", { type: "Reference" });
    expect(replaced.status).toBe(200);
    expect((await memoryOf(await client.v2.memory("fresh-note"))).type).toBe("Reference");

    expect((await client.v2.deleteMemory("fresh-note")).status).toBe(204);
    expect((await client.v2.memory("fresh-note")).status).toBe(404);
    expect((await client.v2.deleteMemory("fresh-note")).status).toBe(404);
  });

  it("matches every memory on an empty tag list and only the tagged ones on a full one", async () => {
    const { user } = await harness();
    const client = await user("scoping");
    await corpus(client);

    const everything = await client.v2.searchMemories({ query: "the", tags: [], minScore: -1, limit: 50 });
    expect(everything.status).toBe(200);
    const all: { hits: V2Hit[]; elsewhere: unknown[] } = await everything.json();
    expect(all.hits.map((hit) => hit.memory.memoryName).sort()).toEqual(CORPUS.map((one) => one.name).sort());
    expect(all.elsewhere).toEqual([]);

    const scoped = await client.v2.searchMemories({ query: "the", tags: ["search"], minScore: -1, limit: 50 });
    const some: { hits: V2Hit[] } = await scoped.json();
    expect(some.hits.map((hit) => hit.memory.memoryName).sort()).toEqual(["embedding-quantisation", "ranking-fusion"]);

    // `any` is gone rather than renamed: a body still carrying it is read for its tags alone,
    // where `/v1` refused the pair outright.
    const legacy = await client.v2.searchMemories({ query: "the", tags: ["search"], any: true, minScore: -1 });
    expect(legacy.status).toBe(200);
    const read: { hits: V2Hit[] } = await legacy.json();
    expect(read.hits.map((hit) => hit.memory.memoryName).sort()).toEqual(["embedding-quantisation", "ranking-fusion"]);
  });

  it("holds the slug, the tag charset and the body ceiling to the generated schema", async () => {
    const { user } = await harness();
    const client = await user("limits");

    expect((await client.v2.memory("Not A Slug")).status).toBe(400);
    expect((await client.v2.saveMemory("tagged", { tags: ["Upper Case"] })).status).toBe(400);
    expect((await client.v2.saveMemory("heavy", { body: "x".repeat(100_001) })).status).toBe(400);
    expect((await client.v2.saveMemory("heavy", { body: "x".repeat(100_000) })).status).toBe(201);
    expect((await client.v2.saveMemory("typed", { type: "project" })).status).toBe(400);
  });

  // The contract tells an integer from a fraction, so a limit of 3.5 is refused by the same schema
  // that takes a score of 0.1 — where the emitter alone wrote the two as one bounded number.
  it("refuses a fraction where the contract counts and takes one where it measures", async () => {
    const { user } = await harness();
    const client = await user("fractions");

    expect((await client.v2.searchMemories({ limit: 3.5 })).status).toBe(400);
    expect((await client.v2.searchMemories({ minScore: 0.1 })).status).toBe(200);
    expect((await client.v2.searchMemories({ minScore: 0.5 })).status).toBe(200);
    expect((await client.v2.memories("?limit=3.5")).status).toBe(400);
  });

  it("serves the search under the memories beside a memory of the same name", async () => {
    const { user } = await harness();
    const client = await user("shadowing");
    await client.v2.saveMemory("search", { body: "a memory whose name is a route word" });

    expect((await memoryOf(await client.v2.memory("search"))).memoryName).toBe("search");
    const found = await client.v2.searchMemories({ query: "route word" });
    expect(found.status).toBe(200);
    const { hits }: { hits: V2Hit[] } = await found.json();
    expect(hits.map((hit) => hit.memory.memoryName)).toContain("search");
  });

  it("keeps one account's memories out of another's reach", async () => {
    const { user } = await harness();
    const mine = await user("owner");
    const theirs = await user("stranger");
    const saved = await mine.save("private-note", { body: "only the owner reads this" });

    expect((await theirs.v2.memory("private-note")).status).toBe(404);
    expect((await theirs.v2.recallMemory("private-note")).status).toBe(404);
    expect((await theirs.v2.deleteMemory("private-note")).status).toBe(404);

    const listed = await theirs.v2.memories();
    const { memories }: { memories: V2Memory[] } = await listed.json();
    expect(memories).toEqual([]);
    const found = await theirs.v2.searchMemories({ query: "owner reads this", minScore: -1 });
    const { hits }: { hits: V2Hit[] } = await found.json();
    expect(hits).toEqual([]);

    // A write under the same name makes the stranger their own memory and leaves the owner's row
    // where it stood.
    expect((await theirs.v2.saveMemory("private-note", { body: "mine now" })).status).toBe(201);
    const held = await memoryOf(await mine.v2.memory("private-note"));
    expect(held.memoryId).toBe(saved.memoryId);
    expect(held.body).toBe("only the owner reads this");
  });

  it("filters a listing in the words the search body uses", async () => {
    const { user } = await harness();
    const client = await user("filtering");
    await corpus(client);
    const names = async (query: string): Promise<string[]> => {
      const listed = await client.v2.memories(query);
      expect(listed.status).toBe(200);
      const { memories }: { memories: V2Memory[] } = await listed.json();
      return memories.map((memory) => memory.memoryName).sort();
    };

    expect(await names("?type=Reference")).toEqual(["embedding-quantisation", "ranking-fusion"]);
    expect(await names("?tags=storage")).toEqual(["cursor-paging", "embedding-quantisation"]);
    expect(await names("?tags=storage&tags=auth")).toEqual(["cursor-paging", "device-grant", "embedding-quantisation"]);
    expect(await names(`?since=${encodeURIComponent(new Date(0).toISOString())}`)).toHaveLength(CORPUS.length);

    // A parameter left blank is a parameter not given, the way `/v1` reads one, and `tag` is a
    // word `/v1` filters by and this surface does not.
    expect(await names("?type=&tags=")).toHaveLength(CORPUS.length);
    expect(await names("?tag=storage")).toHaveLength(CORPUS.length);

    expect((await client.v2.memories("?type=reference")).status).toBe(400);
    expect((await client.v2.memories("?tags=Storage")).status).toBe(400);
    expect((await client.v2.memories("?since=1700000000000")).status).toBe(400);
    expect((await client.v2.memories("?since=2023-11-14T22:13:20")).status).toBe(400);
  });

  // The two surfaces rank through one helper, so what they can still differ by is what their
  // parsers build. These bodies reach that: `/v1` folds a tag's case and the space around it,
  // where `/v2` holds the caller to the charset the contract writes down.
  it("reads a search body the same as /v1 except where /v1 normalises a tag", () => {
    const search = (tags: string[]): Record<string, unknown> => ({
      query: "ranking",
      tags,
      limit: 10,
      minScore: 0.1,
    });
    const v1 = (tags: string[]) => parseSearch({ ...search(tags), any: tags.length === 0, mode: "hybrid" });
    const v2 = (tags: string[]) => parseSearchMemories({ ...search(tags), mode: "Hybrid" });

    for (const tags of [[], ["search"], ["storage", "search"], ["search", "storage"], ["search", "search"]]) {
      expect(v2(tags)).toEqual(v1(tags));
    }

    expect(v1(["Search", " search "])).toEqual({
      ok: true,
      value: { query: "ranking", tags: ["search"], limit: 10, minScore: 0.1, mode: "hybrid" },
    });
    expect(v2(["Search", " search "]).ok).toBe(false);
  });
});

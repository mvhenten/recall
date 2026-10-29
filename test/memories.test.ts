import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Memory } from "../src/model";
import { dot, ftsQuery, normalize, quantize, reciprocalRankFusion } from "../src/rank";
import { type Client, harness } from "./harness";

const listNames = async (response: Response): Promise<string[]> => {
  expect(response.status).toBe(200);
  const page: { memories: Memory[] } = await response.json();
  return page.memories.map((memory) => memory.name);
};

describe("user isolation", () => {
  it("never lets one user read, list, search or delete another user's memories", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    const bob = await h.user("bob");
    const secret = await alice.save("deploy-secret", { body: "the vault combination is under the doormat" });

    expect((await bob.request("GET", "/v1/memories/deploy-secret")).status).toBe(404);
    expect(await listNames(await bob.request("GET", "/v1/memories"))).toEqual([]);
    for (const mode of ["hybrid", "vector", "text"] as const) {
      expect(await bob.search("vault combination doormat", "any", mode)).toEqual([]);
    }
    expect((await bob.request("DELETE", "/v1/memories/deploy-secret")).status).toBe(404);

    const bobs = await bob.save("deploy-secret", { body: "bob keeps a different note" });
    expect(bobs.memoryId).not.toBe(secret.memoryId);

    expect(await alice.get("deploy-secret")).toEqual(secret);
    const hits = await alice.search("vault combination doormat", "any");
    expect(hits.map((hit) => hit.memory.memoryId)).toEqual([secret.memoryId]);
  });

  it("keeps full-text matches inside the user who wrote them", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    const bob = await h.user("bob");
    await alice.save("ticket", { body: "incident zx81-quasar resolved by restarting the queue" });
    await bob.save("unrelated", { body: "nothing about incidents here" });

    expect(await bob.search("zx81 quasar", "any", "text")).toEqual([]);
    expect((await alice.search("zx81 quasar", "any", "text")).map((hit) => hit.memory.name)).toEqual(["ticket"]);
  });
});

describe("upsert", () => {
  it("updates the existing row and re-embeds it when a name is saved again", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    const first = await alice.request("PUT", "/v1/memories/build-cache", {
      description: "how the build cache works",
      type: "project",
      body: "cache lives in redis",
      tags: ["repo:github.com/acme/app"],
    });
    expect(first.status).toBe(201);
    const created: { memory: Memory } = await first.json();

    h.tick(60_000);
    const second = await alice.request("PUT", "/v1/memories/build-cache", {
      description: "how the build cache works now",
      type: "reference",
      body: "cache moved to an object storage bucket",
      tags: ["global"],
    });
    expect(second.status).toBe(200);
    const updated: { memory: Memory } = await second.json();

    expect(updated.memory).toMatchObject({
      memoryId: created.memory.memoryId,
      createdAt: created.memory.createdAt,
      updatedAt: h.now(),
      type: "reference",
      body: "cache moved to an object storage bucket",
      tags: ["global"],
    });
    expect(await listNames(await alice.request("GET", "/v1/memories"))).toEqual(["build-cache"]);
    expect((await alice.search("object storage bucket", "any", "vector")).map((hit) => hit.memory.name)).toEqual([
      "build-cache",
    ]);
    expect(await alice.search("redis", "any", "text")).toEqual([]);
  });
});

describe("recall tracking", () => {
  it("counts every search hit and stamps when it was last recalled", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("tabs-or-spaces", { body: "two spaces, never tabs" });
    await alice.save("coffee-order", { body: "flat white" });

    const recalledAt = h.tick(1_000);
    const [hit] = await alice.search("spaces tabs", "any");
    expect(hit?.memory.name).toBe("tabs-or-spaces");
    expect(hit?.memory.recallCount).toBe(1);

    h.tick(1_000);
    await alice.search("spaces tabs", "any");
    const tabs = await alice.get("tabs-or-spaces");
    expect(tabs.recallCount).toBe(2);
    expect(tabs.lastRecalledAt).toBe(recalledAt + 1_000);
    expect((await alice.get("coffee-order")).recallCount).toBe(0);
  });

  it("leaves memories outside the requested tags untouched", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("kept-quiet", { tags: ["repo:github.com/acme/other"] });
    expect(await alice.search("kept quiet", ["global"])).toEqual([]);
    const quiet = await alice.get("kept-quiet");
    expect(quiet.recallCount).toBe(0);
    expect(quiet.lastRecalledAt).toBe(0);
  });
});

describe("hybrid search", () => {
  it("finds an exact identifier through text search that vector search misses", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("cold-cache", { body: "error qx4521 means the cache is cold, warm it first" });
    for (const name of ["deploy-steps", "release-notes", "oncall-guide"]) {
      await alice.save(name, { body: `error handling for ${name}, check the logs` });
    }

    const vector = await alice.search("qx4521", "any", "vector");
    expect(vector.map((hit) => hit.memory.name)).not.toContain("cold-cache");
    expect((await alice.search("qx4521", "any", "text")).map((hit) => hit.memory.name)).toEqual(["cold-cache"]);
    const [top] = await alice.search("qx4521", "any");
    expect(top?.memory.name).toBe("cold-cache");
  });

  it("removes a deleted memory from the full-text index", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    const memory = await alice.save("short-lived", { body: "ephemeral marker vq77zeta" });
    expect((await alice.request("DELETE", "/v1/memories/short-lived")).status).toBe(204);

    expect(await alice.search("vq77zeta", "any", "text")).toEqual([]);
    const fts = await env.DB.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?")
      .bind('"vq77zeta"')
      .first<{ n: number }>();
    expect(fts?.n).toBe(0);
    const tags = await env.DB.prepare("SELECT count(*) AS n FROM memory_tags WHERE memory_id = ?")
      .bind(memory.memoryId)
      .first<{ n: number }>();
    expect(tags?.n).toBe(0);
  });

  it("scores int8 embeddings within a hundredth of the float cosine", () => {
    const vector = normalize(Array.from({ length: 384 }, (_, i) => ((i * 37) % 101) - 50));
    expect(dot(vector, quantize(vector))).toBeCloseTo(1, 2);
  });

  it("quotes every full-text term and fuses rankings by reciprocal rank", () => {
    expect(ftsQuery('ERR-4521 "cache" OR')).toBe('"4521" OR "cache" OR "err" OR "or"');
    expect(ftsQuery("--")).toBeNull();
    expect(
      reciprocalRankFusion([
        ["a", "b", "c"],
        ["c", "b"],
      ]).map(([id]) => id),
    ).toEqual(["c", "b", "a"]);
  });
});

describe("tags", () => {
  it("normalizes tags to a sorted, lower-case, de-duplicated set", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    const memory = await alice.save("normalized", { tags: [" Global ", "global", "Repo:GitHub.com/Acme/App"] });
    expect(memory.tags).toEqual(["global", "repo:github.com/acme/app"]);

    const rejected = await alice.request("PUT", "/v1/memories/normalized", {
      description: "d",
      type: "user",
      body: "",
      tags: ["has space"],
    });
    expect(rejected.status).toBe(400);
  });

  it("limits search to memories carrying one of the requested tags", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("here", { body: "release checklist", tags: ["repo:github.com/acme/app"] });
    await alice.save("everywhere", { body: "release checklist", tags: ["global"] });
    await alice.save("elsewhere", { body: "release checklist", tags: ["repo:github.com/acme/other"] });
    await alice.save("untagged", { body: "release checklist", tags: [] });

    for (const mode of ["hybrid", "vector", "text"] as const) {
      const scoped = await alice.search("release checklist", ["repo:github.com/acme/app", "global"], mode);
      expect(scoped.map((hit) => hit.memory.name).sort()).toEqual(["everywhere", "here"]);
    }
    expect(await alice.search("release checklist", "any")).toHaveLength(4);

    const unscoped = await alice.request("POST", "/v1/search", {
      query: "release checklist",
      tags: [],
      any: false,
      limit: 10,
      minScore: 0,
      mode: "hybrid",
    });
    expect(unscoped.status).toBe(400);
  });

  it("lists by tag, newest created first, across pages and since a moment", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("oldest", { tags: ["global"] });
    const middleCreatedAt = h.tick(1_000);
    await alice.save("middle", { tags: ["global"] });
    h.tick(1_000);
    await alice.save("newest", { tags: ["global"] });
    await alice.save("other", { tags: ["repo:github.com/acme/app"] });

    const first = await alice.request("GET", "/v1/memories?tag=global&limit=2");
    const page: { memories: Memory[]; nextCursor: string } = await first.json();
    expect(page.memories.map((memory) => memory.name)).toEqual(["newest", "middle"]);
    const next = `/v1/memories?tag=global&cursor=${encodeURIComponent(page.nextCursor)}`;
    expect(await listNames(await alice.request("GET", next))).toEqual(["oldest"]);
    expect(await listNames(await alice.request("GET", `/v1/memories?tag=global&since=${middleCreatedAt}`))).toEqual([
      "newest",
      "middle",
    ]);
  });
});

interface Elsewhere {
  name: string;
  type: string;
  tags: string[];
  description: string;
  score: number;
}

const scopedSearch = async (
  client: Client,
  query: string,
  tags: string[],
  mode: "hybrid" | "vector" | "text" = "hybrid",
): Promise<{ hits: Array<{ memory: Memory }>; elsewhere: Elsewhere[] }> => {
  const response = await client.request("POST", "/v1/search", {
    query,
    tags,
    any: tags.length === 0,
    limit: 10,
    minScore: 0.1,
    mode,
  });
  expect(response.status).toBe(200);
  return response.json();
};

describe("elsewhere", () => {
  it("lists a match from another scope apart from the hits, without recalling it", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("here-deploy", { body: "deploy pipeline uses blue green", tags: ["repo:github.com/acme/app"] });
    await alice.save("other-deploy", {
      description: "deploy notes for the other repo",
      type: "reference",
      body: "deploy pipeline uses canary releases",
      tags: ["repo:github.com/acme/other"],
    });

    for (const mode of ["hybrid", "vector", "text"] as const) {
      const result = await scopedSearch(alice, "deploy pipeline", ["repo:github.com/acme/app", "global"], mode);
      expect(result.hits.map((hit) => hit.memory.name)).toEqual(["here-deploy"]);
      expect(result.elsewhere).toHaveLength(1);
      expect(result.elsewhere[0]).toMatchObject({
        name: "other-deploy",
        type: "reference",
        tags: ["repo:github.com/acme/other"],
        description: "deploy notes for the other repo",
      });
      expect(result.elsewhere[0]?.score).toBeGreaterThan(0);
    }

    const other = await alice.get("other-deploy");
    expect(other.recallCount).toBe(0);
    expect(other.lastRecalledAt).toBe(0);
    expect((await alice.get("here-deploy")).recallCount).toBe(3);

    const everywhere = await scopedSearch(alice, "deploy pipeline", []);
    expect(everywhere.hits).toHaveLength(2);
    expect(everywhere.elsewhere).toEqual([]);
  });

  it("caps elsewhere at three and keeps it inside the user", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    const bob = await h.user("bob");
    for (const repo of ["one", "two", "three", "four"]) {
      await alice.save(`cache-${repo}`, { body: "build cache warming steps", tags: [`repo:github.com/acme/${repo}`] });
    }
    await bob.save("bob-cache", { body: "build cache warming steps", tags: ["repo:github.com/bob/tool"] });

    const alices = await scopedSearch(alice, "build cache warming", ["global"]);
    expect(alices.hits).toEqual([]);
    expect(alices.elsewhere).toHaveLength(3);
    expect(alices.elsewhere.map((entry) => entry.name)).not.toContain("bob-cache");

    const bobs = await scopedSearch(bob, "build cache warming", ["global"]);
    expect(bobs.elsewhere.map((entry) => entry.name)).toEqual(["bob-cache"]);
  });
});

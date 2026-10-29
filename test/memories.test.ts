import { describe, expect, it } from "vitest";
import type { Memory } from "../src/model";
import { harness } from "./harness";

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
    expect(await bob.search("vault combination doormat", [])).toEqual([]);
    expect((await bob.request("DELETE", "/v1/memories/deploy-secret")).status).toBe(404);

    const bobs = await bob.save("deploy-secret", { body: "bob's own note" });
    expect(bobs.memoryId).not.toBe(secret.memoryId);

    const response = await alice.request("GET", "/v1/memories/deploy-secret");
    const { memory }: { memory: Memory } = await response.json();
    expect(memory).toEqual(secret);
    expect((await alice.search("vault combination doormat", [])).map((hit) => hit.memory.memoryId)).toEqual([
      secret.memoryId,
    ]);
  });

  it("rejects callers that are not a registered service token", async () => {
    const h = await harness();
    const stranger = h.clientWithAssertion(await h.assertionFor("unknown.access"));
    expect((await stranger.request("GET", "/v1/memories")).status).toBe(403);

    const forged = h.clientWithAssertion("not-a-jwt");
    expect((await forged.request("GET", "/v1/memories")).status).toBe(401);
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
      body: "cache moved to an r2 bucket",
      tags: ["global"],
    });
    expect(second.status).toBe(200);
    const updated: { memory: Memory } = await second.json();

    expect(updated.memory).toMatchObject({
      memoryId: created.memory.memoryId,
      createdAt: created.memory.createdAt,
      updatedAt: h.now(),
      type: "reference",
      body: "cache moved to an r2 bucket",
      tags: ["global"],
    });
    expect(h.index.size()).toBe(1);
    expect(await listNames(await alice.request("GET", "/v1/memories"))).toEqual(["build-cache"]);
    const [hit] = await alice.search("r2 bucket", []);
    expect(hit?.score).toBeGreaterThan(0);
  });
});

describe("recall tracking", () => {
  it("counts every search hit and stamps when it was last recalled", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("tabs-or-spaces", { body: "two spaces, never tabs" });
    await alice.save("coffee-order", { body: "flat white" });

    const recalledAt = h.tick(1_000);
    const hits = await alice.search("spaces tabs", []);
    const hit = hits.find((candidate) => candidate.memory.name === "tabs-or-spaces");
    expect(hit?.memory.recallCount).toBe(1);

    h.tick(1_000);
    await alice.search("spaces tabs", []);
    const tabs: { memory: Memory } = await (await alice.request("GET", "/v1/memories/tabs-or-spaces")).json();
    expect(tabs.memory.recallCount).toBe(2);
    expect(tabs.memory.lastRecalledAt).toBe(recalledAt + 1_000);
  });

  it("leaves memories outside the result untouched", async () => {
    const h = await harness();
    const alice = await h.user("alice");
    await alice.save("kept-quiet", { tags: ["repo:github.com/acme/other"] });
    await alice.search("kept quiet", ["global"]);
    const quiet: { memory: Memory } = await (await alice.request("GET", "/v1/memories/kept-quiet")).json();
    expect(quiet.memory.recallCount).toBe(0);
    expect(quiet.memory.lastRecalledAt).toBe(0);
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

    const scoped = await alice.search("release checklist", ["repo:github.com/acme/app", "global"]);
    expect(scoped.map((hit) => hit.memory.name).sort()).toEqual(["everywhere", "here"]);

    const everything = await alice.search("release checklist", []);
    expect(everything).toHaveLength(4);
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
    expect(
      await listNames(
        await alice.request("GET", `/v1/memories?tag=global&cursor=${encodeURIComponent(page.nextCursor)}`),
      ),
    ).toEqual(["oldest"]);
    expect(await listNames(await alice.request("GET", `/v1/memories?tag=global&since=${middleCreatedAt}`))).toEqual([
      "newest",
      "middle",
    ]);
  });
});

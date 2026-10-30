import { describe, expect, it } from "vitest";
import { MAX_QUERY_CHARS, searchQuery, unseen } from "../hooks/query.mjs";
import { harness } from "./harness";

describe("hook search query", () => {
  it("cuts a long prompt to a query the Worker accepts", async () => {
    const query = searchQuery("deploy cache ".repeat(250));
    expect(query).toHaveLength(MAX_QUERY_CHARS);
    expect(searchQuery("short prompt here")).toBe("short prompt here");

    const h = await harness();
    const alice = await h.user("alice");
    const response = await alice.request("POST", "/v1/search", {
      query,
      tags: [],
      any: true,
      limit: 5,
      minScore: 0.65,
      mode: "vector",
    });
    expect(response.status).toBe(200);
  });

  it("drops memories the session was already shown, in scope and elsewhere", () => {
    const found = {
      hits: [{ memory: { name: "shown-hit" } }, { memory: { name: "new-hit" } }],
      elsewhere: [{ name: "shown-elsewhere" }, { name: "new-elsewhere" }],
    };
    expect(unseen(found, new Set(["shown-hit", "shown-elsewhere"]))).toEqual({
      hits: [{ memory: { name: "new-hit" } }],
      elsewhere: [{ name: "new-elsewhere" }],
    });
  });
});

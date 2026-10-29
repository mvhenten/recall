import { describe, expect, it } from "vitest";
import { MAX_QUERY_CHARS, searchQuery } from "../hooks/query.mjs";
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
      minScore: 0.55,
      mode: "hybrid",
    });
    expect(response.status).toBe(200);
  });
});

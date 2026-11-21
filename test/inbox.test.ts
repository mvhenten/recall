import { describe, expect, it } from "vitest";
import type { InboxMessage, InboxPage } from "../src/inbox";
import { INBOX_RETENTION_MS } from "../src/inbox";
import { harness, tenantRows } from "./harness";

const post = {
  sender: "build agent",
  subject: "Review ready",
  body: "All checks passed",
  link: "https://example.com/pr/1",
};

describe("/v2/inbox", () => {
  it("posts, pages, and explicitly acknowledges the authenticated user's messages", async () => {
    const h = await harness();
    const email = await h.invite(`${crypto.randomUUID()}@example.com`);
    const laptop = h.clientWithToken(await h.login(email, "laptop"));
    const desktop = h.clientWithToken(await h.login(email, "desktop"));
    const response = await laptop.request("POST", "/v2/inbox", post);
    expect(response.status).toBe(201);
    const { message }: { message: InboxMessage } = await response.json();
    expect(message).toEqual({
      ...post,
      id: 1,
      createdAt: h.now(),
      expiresAt: h.now() + INBOX_RETENTION_MS,
      readAt: null,
    });
    await laptop.request("POST", "/v2/inbox", { ...post, link: undefined });
    const page: InboxPage = await (await desktop.request("GET", "/v2/inbox?limit=1")).json();
    expect(page).toEqual({ messages: [message], nextCursor: 1 });
    const next: InboxPage = await (await desktop.request("GET", "/v2/inbox?after=1")).json();
    expect(next.messages.map((m) => [m.id, m.link])).toEqual([[2, null]]);
    expect(await (await desktop.request("POST", "/v2/inbox/read", { id: 1 })).json()).toEqual({ updated: 1 });
    expect(await (await laptop.request("POST", "/v2/inbox/read", { id: 1 })).json()).toEqual({ updated: 0 });
    expect(((await (await laptop.request("GET", "/v2/inbox")).json()) as InboxPage).messages.map((m) => m.id)).toEqual([
      2,
    ]);
    expect(await (await laptop.request("POST", "/v2/inbox/read", { up_to: 2 })).json()).toEqual({ updated: 1 });
    expect(await (await desktop.request("GET", "/v2/inbox?after=2")).json()).toEqual({ messages: [], nextCursor: 2 });
    expect((await desktop.request("POST", "/v2/inbox/read", { id: 3 })).status).toBe(404);
    const bob = await h.user("bob");
    expect(await (await bob.request("GET", "/v2/inbox")).json()).toEqual({ messages: [], nextCursor: 0 });
    expect((await bob.request("POST", "/v2/inbox/read", { id: 1 })).status).toBe(404);
  });

  it("authenticates every operation and rejects malformed contracts with 400", async () => {
    const h = await harness();
    for (const [method, path] of [
      ["POST", "/v2/inbox"],
      ["GET", "/v2/inbox"],
      ["POST", "/v2/inbox/read"],
    ] as const) {
      expect((await h.send(path, { method, headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    }
    const client = await h.user("owner");
    for (const invalid of [
      { ...post, sender: " " },
      { ...post, body: "é".repeat(2049) },
      { ...post, extra: true },
      { ...post, link: "http://example.com" },
      null,
      [],
    ]) {
      expect((await client.request("POST", "/v2/inbox", invalid)).status).toBe(400);
    }
    for (const query of [
      "after=1",
      "after=-1",
      "after=1.1",
      "after=9007199254740992",
      "limit=21",
      "limit=0",
      "limit=2&limit=3",
      "limit=",
      "unknown=1",
    ]) {
      expect((await client.request("GET", `/v2/inbox?${query}`)).status).toBe(400);
    }
    for (const invalid of [{}, { id: 1, up_to: 1 }, { id: 0 }, { up_to: 1 }, { id: 1, extra: true }]) {
      expect((await client.request("POST", "/v2/inbox/read", invalid)).status).toBe(400);
    }
    expect((await client.request("PUT", "/v2/inbox", post)).status).toBe(405);
    expect((await client.request("GET", "/v2/inbox/read")).status).toBe(405);
    expect((await client.request("GET", "/v2/inbox/unknown")).status).toBe(404);
    expect((await client.request("GET", "/v2/inbox/read/extra")).status).toBe(404);
  });

  it("returns 429 at unread capacity, and excludes and purges expired messages", async () => {
    const h = await harness();
    const client = await h.user("owner");
    const userId = client.userId;
    expect((await client.request("POST", "/v2/inbox", post)).status).toBe(201);
    await tenantRows(
      userId,
      `INSERT INTO inbox_messages
      (user_id,id,sender,subject,body,created_at,expires_at)
      SELECT ?1, value+1, 'sender', 'subject', 'body', ?2, ?3 FROM json_each(?4)`,
      userId,
      h.now(),
      h.now() + INBOX_RETENTION_MS,
      JSON.stringify(Array.from({ length: 999 }, (_, i) => i + 1)),
    );
    await tenantRows(userId, "UPDATE inbox_counters SET high_water = 1000 WHERE user_id = ?1", userId);
    expect((await client.request("POST", "/v2/inbox", post)).status).toBe(429);
    h.tick(INBOX_RETENTION_MS);
    expect((await client.request("POST", "/v2/inbox/read", { id: 1 })).status).toBe(404);
    expect(await (await client.request("GET", "/v2/inbox")).json()).toEqual({ messages: [], nextCursor: 0 });
    expect(await tenantRows(userId, "SELECT * FROM inbox_messages")).toEqual([]);
    expect(
      ((await (await client.request("POST", "/v2/inbox", post)).json()) as { message: InboxMessage }).message.id,
    ).toBe(1001);
  });
});

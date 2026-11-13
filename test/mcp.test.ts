import { describe, expect, it } from "vitest";
import { NO_PEEK_LISTENING, ORDERS, ORDERS_HEADER, type PeekFrame, type PeekOrder } from "../src/mailbox";
import { MCP_PATH } from "../src/mcp";
import { PEEK_READS, PEEK_WAIT_MS, readBackPeek, TOOLS } from "../src/tools";
import type { V2Peek } from "../src/v2";
import { type Client, harness, MCP_PROTOCOL_VERSION } from "./harness";

const MODERN = "2026-07-28";
const MODERN_META = { "io.modelcontextprotocol/protocolVersion": MODERN };

const signedIn = async () => {
  const h = await harness();
  const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
  return { h, email, mcp: await h.connector(email) };
};

type Harness = Awaited<ReturnType<typeof harness>>;

// One live session on one host of the same account, which is what a peek is asked of.
const peekable = async () => {
  const signed = await signedIn();
  const token = await signed.h.login(signed.email, "laptop");
  const laptop = signed.h.clientWithToken(token);
  const sessionId = `laptop-${crypto.randomUUID()}`;
  expect((await laptop.sync(sessionId, { host: "laptop", lastActivityAt: signed.h.now() })).status).toBe(204);
  return { ...signed, laptop, token, sessionId };
};

// A host that takes every peek it is handed and writes the digest its summariser would have
// written, one per peek in the order they arrive. A peek past the digests given is taken and left
// pending, which is a host whose summariser has not answered yet. `written` carries each write, so
// a test reads what the service made of it rather than watching the read back time out.
interface Summariser {
  handed: PeekOrder[];
  written: Array<Promise<Response>>;
}

const summarising = async (h: Harness, token: string, host: Client, digests: string[]): Promise<Summariser> => {
  const response = await h.send("/v2/messages/listen", {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket", [ORDERS_HEADER]: ORDERS },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the listen upgrade carried no socket");
  socket.accept();
  const summariser: Summariser = { handed: [], written: [] };
  socket.addEventListener("message", (event) => {
    const frame: PeekFrame = JSON.parse(String(event.data));
    if (frame.type !== "peek") return;
    summariser.handed.push(frame.peek);
    socket.send(JSON.stringify({ type: "peek-took", peekId: frame.peek.peekId, token: frame.token }));
    const digest = digests[summariser.handed.length - 1];
    if (digest === undefined) return;
    summariser.written.push(
      host.request("PUT", `/v2/sessions/${frame.peek.sessionId}/peek/${frame.peek.peekId}`, { digest }),
    );
  });
  return summariser;
};

const history = async (host: Client, sessionId: string): Promise<V2Peek[]> => {
  const response = await host.request("GET", `/v2/sessions/${sessionId}/peek`);
  expect(response.status).toBe(200);
  const read: { peeks: V2Peek[] } = await response.json();
  return read.peeks;
};

describe("the connector handshake", () => {
  it("negotiates the version the client opened with and names its tools", async () => {
    const { mcp } = await signedIn();
    const opened = await mcp.call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "desktop", version: "1" },
    });
    const result = opened.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.capabilities).toEqual({ tools: {} });
    expect((result.serverInfo as { name: string }).name).toBe("recall");
    expect(result.instructions).toContain("durable memory");

    const listed = await mcp.call("tools/list");
    const tools = (listed.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "recall_delete",
      "recall_devices",
      "recall_edit",
      "recall_get",
      "recall_list",
      "recall_peek",
      "recall_save",
      "recall_search",
      "recall_send",
      "recall_sessions",
    ]);
    expect(tools.every((tool) => tool.inputSchema !== undefined)).toBe(true);
  });

  it("answers an unknown handshake version with the latest it serves", async () => {
    const { mcp } = await signedIn();
    const opened = await mcp.call("initialize", { protocolVersion: "1999-01-01" });
    expect((opened.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
  });

  it("takes a notification without answering and refuses anything but a POST", async () => {
    const { h, mcp } = await signedIn();
    const accepted = await h.rpc({ method: "notifications/initialized" }, mcp.headers);
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe("");

    const nulled = await h.rpc({ id: null, method: "notifications/initialized" }, mcp.headers);
    expect(nulled.status).toBe(202);
    expect(await nulled.text()).toBe("");

    const opened = await h.send(MCP_PATH, { method: "GET", headers: mcp.headers });
    expect(opened.status).toBe(405);
    expect(((await opened.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  // The era before a JSON body: the client accepts a stream and nothing else, so the one answer it
  // asked for arrives as the one event of that stream.
  it("answers a client that takes only a stream with the same message as an SSE event", async () => {
    const { h, mcp } = await signedIn();
    const streamed = await h.send(MCP_PATH, {
      method: "POST",
      headers: { ...mcp.headers, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");
    const body = await streamed.text();
    expect(body.startsWith("event: message\ndata: ")).toBe(true);
    const framed = JSON.parse(body.slice("event: message\ndata: ".length)) as {
      id: number;
      result: { tools: unknown[] };
    };
    expect(framed.id).toBe(7);
    expect(framed.result.tools).toHaveLength(TOOLS.length);

    // A client that takes no JSON cannot read a refusal out of a JSON body either.
    const refused = await h.send(MCP_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("content-type")).toBe("text/event-stream");
    expect(await refused.text()).toContain("no bearer token reached /mcp");
  });

  it("refuses a malformed message and an unknown method with JSON-RPC errors", async () => {
    const { h, mcp } = await signedIn();
    const unparsed = await h.send(MCP_PATH, { method: "POST", headers: mcp.headers, body: "{oops" });
    expect(unparsed.status).toBe(400);
    expect(((await unparsed.json()) as { error: { code: number } }).error.code).toBe(-32700);

    const batched = await h.send(MCP_PATH, {
      method: "POST",
      headers: { ...mcp.headers, "content-type": "application/json" },
      body: "[]",
    });
    expect(((await batched.json()) as { error: { code: number } }).error.code).toBe(-32600);

    const unknown = await h.rpc({ id: 9, method: "resources/list" }, mcp.headers);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("reports an unknown tool as invalid params and a failing tool in the result", async () => {
    const { h, mcp } = await signedIn();
    const unknown = await h.rpc({ id: 1, method: "tools/call", params: { name: "recall_drop" } }, mcp.headers);
    expect(((await unknown.json()) as { error: { code: number; message: string } }).error).toMatchObject({
      code: -32602,
      message: "Unknown tool: recall_drop",
    });

    const missing = await mcp.call("tools/call", { name: "recall_get", arguments: { name: "nothing-here" } });
    const result = missing.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("recall: no memory named nothing-here");
  });
});

describe("the per-request protocol revision", () => {
  const modern = (method: string, params: Record<string, unknown> = {}) => ({
    id: 1,
    method,
    params: { ...params, _meta: MODERN_META },
  });
  const headers = (token: string, method: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
    ...extra,
  });

  it("discovers the server and lists tools when the headers mirror the body", async () => {
    const { h, mcp } = await signedIn();
    const token = mcp.accessToken;
    const discovered = await h.rpc(modern("server/discover"), headers(token, "server/discover"));
    const result = ((await discovered.json()) as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toEqual([MODERN, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

    const listed = await h.rpc(modern("tools/list"), headers(token, "tools/list"));
    expect(((await listed.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOLS.length);
  });

  it("refuses a header that does not match the body, and a version it does not serve", async () => {
    const { h, mcp } = await signedIn();
    const token = mcp.accessToken;
    const mismatched = await h.rpc(
      modern("tools/call", { name: "recall_list", arguments: {} }),
      headers(token, "tools/call", { "mcp-name": "recall_search" }),
    );
    expect(mismatched.status).toBe(400);
    expect(((await mismatched.json()) as { error: { code: number } }).error.code).toBe(-32020);

    const old = await h.rpc(
      { id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" } } },
      headers(token, "tools/list", { "mcp-protocol-version": "2025-06-18" }),
    );
    expect(old.status).toBe(400);
    const refusal = (await old.json()) as { error: { code: number; data: { supported: string[] } } };
    expect(refusal.error.code).toBe(-32022);
    expect(refusal.error.data.supported).toContain(MODERN);
  });

  it("takes a tools/call whose Mcp-Name is base64 encoded", async () => {
    const { h, mcp } = await signedIn();
    const token = mcp.accessToken;
    const encoded = `=?base64?${btoa("recall_list")}?=`;
    const answered = await h.rpc(
      modern("tools/call", { name: "recall_list", arguments: {} }),
      headers(token, "tools/call", { "mcp-name": encoded }),
    );
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });
});

describe("what the connector endpoint refuses", () => {
  it("names the credential it wanted when none reached the Worker", async () => {
    const h = await harness();
    const bare = await h.rpc({ id: 1, method: "tools/list" });
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as { error: { message: string } }).error.message).toContain(
      "no bearer token reached /mcp",
    );
  });

  it("refuses a request carried from another origin", async () => {
    const { h, mcp } = await signedIn();
    const refused = await h.rpc({ id: 1, method: "tools/list" }, { ...mcp.headers, origin: "https://evil.test" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("https://evil.test");
  });

  it("answers 404 where the deployment switched no connector on", async () => {
    const off = await harness({ mcpConnector: "off" });
    const refused = await off.rpc({ id: 1, method: "tools/list" });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      "serves no MCP connector",
    );
  });
});

describe("the connector's tools", () => {
  it("saves, reads, edits, lists, searches and deletes a memory", async () => {
    const { mcp } = await signedIn();
    const saved = await mcp.json("recall_save", {
      name: "indent-style",
      description: "how the user wants code indented",
      type: "feedback",
      body: "Two spaces, never tabs.",
    });
    expect(saved).toMatchObject({ name: "indent-style", created: true, tags: ["global"] });

    expect(await mcp.tool("recall_get", { name: "indent-style" })).toContain("tags: [global]");

    const edited = await mcp.json("recall_edit", {
      name: "indent-style",
      body: "Tabs after all.",
      add_tags: ["style"],
    });
    expect(edited).toMatchObject({ name: "indent-style", created: false });
    expect(await mcp.tool("recall_get", { name: "indent-style" })).toContain("Tabs after all.");

    const listed = (await mcp.json("recall_list")) as Array<{ name: string }>;
    expect(listed.map((memory) => memory.name)).toEqual(["indent-style"]);

    const found = (await mcp.json("recall_search", { query: "indented" })) as {
      count: number;
      results: Array<{ memory: { memoryName: string } }>;
      scopes: Array<{ scope: string; count: number }>;
    };
    expect(found.results.map((hit) => hit.memory.memoryName)).toEqual(["indent-style"]);
    expect(found.count).toBe(1);
    expect(found.scopes).toContainEqual({ scope: "style", count: 1 });

    expect(await mcp.json("recall_delete", { name: "indent-style" })).toEqual({ deleted: "indent-style" });
  });

  it("scopes a save by the repo tag it names, by global, and refuses one that names neither", async () => {
    const { mcp } = await signedIn();
    const refused = await mcp
      .tool("recall_save", { name: "deploy-steps", description: "d", type: "project", body: "b" })
      .catch((error: Error) => error.message);
    expect(refused).toContain("a project memory needs a scope");

    const prefix = await mcp
      .tool("recall_save", { name: "deploy-steps", description: "d", type: "project", body: "b", tags: ["repo:"] })
      .catch((error: Error) => error.message);
    expect(prefix).toContain("a project memory needs a scope");

    const inRepo = (await mcp.json("recall_save", {
      name: "deploy-steps",
      description: "d",
      type: "project",
      body: "b",
      tags: ["repo:github.com/acme/widget", "mcp"],
    })) as { tags: string[] };
    expect(inRepo.tags).toEqual(["mcp", "repo:github.com/acme/widget"]);

    const scoped = (await mcp.json("recall_save", {
      name: "release-steps",
      description: "d",
      type: "project",
      body: "b",
      global: true,
      tags: ["repo:github.com/acme/widget"],
    })) as { tags: string[] };
    expect([...scoped.tags].sort()).toEqual(["global", "repo:github.com/acme/widget"]);
  });

  it("refuses an argument the tool does not take", async () => {
    const { mcp } = await signedIn();
    const extra = await mcp.tool("recall_get", { name: "x", depth: 2 }).catch((error: Error) => error.message);
    expect(extra).toBe("recall: recall_get takes no argument depth");

    const gone = await mcp
      .tool("recall_search", { query: "q", tags: ["style"] })
      .catch((error: Error) => error.message);
    expect(gone).toBe("recall: recall_search takes no argument tags");
  });

  it("lists the live sessions and the hosts a send can be addressed to", async () => {
    const { h, email, mcp } = await signedIn();
    const client = h.clientWithToken(await h.login(email, "laptop"));
    expect((await client.sync("s-ship", { host: "laptop", lastActivityAt: h.now() })).status).toBe(204);
    const named = JSON.stringify({ type: "agent-name", agentName: "kisuvpalas" });
    expect((await client.v2.records("s-ship", "main", 0, [named])).status).toBe(200);

    const sessions = (await mcp.json("recall_sessions")) as Array<{
      name: string;
      handle: string;
      host: string;
      cwd: string;
      focus: string;
    }>;
    expect(sessions.map((session) => [session.name, session.host, session.cwd, session.focus])).toEqual([
      ["kisuvpalas", "laptop", "/home/you/src/recall", "why is the worker test red"],
    ]);
    expect(await mcp.json("recall_send", { to: sessions[0]?.handle ?? "", message: "ship it" })).toMatchObject({
      toSessionId: "s-ship",
    });

    const devices = (await mcp.json("recall_devices")) as Array<{ name: string; host: string }>;
    expect(devices.map((device) => [device.name, device.host])).toEqual([["laptop", "laptop"]]);
  });

  it("sends a message to a host and never reads as one itself", async () => {
    const { h, email, mcp } = await signedIn();
    const token = await h.login(email, "laptop");
    const client = h.clientWithToken(token);
    const sent = (await mcp.json("recall_send", { to: "laptop", message: "ship it" })) as { toDeviceId: string };

    const devices = await client.request("GET", "/v2/devices");
    const listed = (await devices.json()) as { devices: Array<{ deviceId: string; name: string }> };
    expect(listed.devices.map((device) => device.name)).toEqual(["laptop"]);
    expect(sent.toDeviceId).toBe(listed.devices[0]?.deviceId);

    const unknown = await mcp
      .tool("recall_send", { to: "desktop", message: "hi" })
      .catch((error: Error) => error.message);
    expect(unknown).toContain("no host or session named desktop");
  });

  it("reaches a host however its name is capitalised and names the sessions it reached", async () => {
    const { h, email, mcp } = await signedIn();
    const client = h.clientWithToken(await h.login(email, "sandbox"));
    for (const sessionId of ["s-one", "s-two"]) {
      expect((await client.sync(sessionId, { host: "sandbox", lastActivityAt: h.now() })).status).toBe(204);
    }
    const sessions = await client.request("GET", "/v2/sessions");
    const listed = (await sessions.json()) as { sessions: Array<{ sessionId: string; name: string }> };

    const everywhere = await mcp.json("recall_send", { to: "Sandbox", message: "ship it" });
    expect(everywhere).toMatchObject({
      toSessionId: "",
      sessions: 2,
      handles: listed.sessions.map((session) => session.name),
    });

    const one = listed.sessions[0];
    const answered = await mcp.json("recall_send", { to: (one?.name ?? "").toUpperCase(), message: "ship it" });
    expect(answered).toMatchObject({ toSessionId: one?.sessionId, sessions: 1, handles: [one?.name] });
  });
});

describe("peeking from the connector", () => {
  // Each call asks once and reads the answer back, so two calls are two peeks and the history holds
  // what each one answered with.
  it("asks one session and answers the digest its host wrote", async () => {
    const { h, mcp, laptop, token, sessionId } = await peekable();
    const host = await summarising(h, token, laptop, ["running the tenant migration", "reading the transcript"]);
    const [session] = (await mcp.json("recall_sessions")) as Array<{ handle: string }>;

    const first = (await mcp.json("recall_peek", { session: session?.handle ?? "" })) as {
      sessionId: string;
      peek: V2Peek;
    };
    expect(first.sessionId).toBe(sessionId);
    expect(first.peek).toMatchObject({ state: "Ready", digest: "running the tenant migration" });

    // The history reads newest first, and two peeks asked in the same millisecond are ordered by an
    // id neither this test nor the store picked, so the second is asked a second later.
    h.advance(1_000);
    const second = (await mcp.json("recall_peek", { session: sessionId })) as { sessionId: string; peek: V2Peek };
    expect(second.peek).toMatchObject({ state: "Ready", digest: "reading the transcript" });
    expect(second.peek.peekId).not.toBe(first.peek.peekId);

    const written = await Promise.all(host.written);
    expect(written.map((response) => response.status)).toEqual([204, 204]);
    expect(host.handed.map((peek) => peek.peekId)).toEqual([first.peek.peekId, second.peek.peekId]);
    expect(await history(laptop, sessionId)).toEqual([second.peek, first.peek]);
  }, 30_000);

  // Nothing is kept for a host that attaches later, so a peek nobody took has nothing to read back
  // and the caller is told what the bus made of it.
  it("names the reason no host took the peek", async () => {
    const { mcp, sessionId } = await peekable();

    const refused = await mcp.tool("recall_peek", { session: sessionId }).catch((error: Error) => error.message);

    expect(refused).toBe(`recall: no host took the peek of ${sessionId}: ${NO_PEEK_LISTENING}`);
  });

  it("refuses a host, which recall_send takes and one summariser cannot answer for", async () => {
    const { h, mcp, laptop, token } = await peekable();
    await summarising(h, token, laptop, []);

    const refused = await mcp.tool("recall_peek", { session: "laptop" }).catch((error: Error) => error.message);

    expect(refused).toContain("laptop names a host, and a peek asks one session");
  });

  it("refuses a session this account is not running", async () => {
    const { mcp } = await peekable();

    const refused = await mcp.tool("recall_peek", { session: "s-gone" }).catch((error: Error) => error.message);

    expect(refused).toContain("no host or session named s-gone");
  });
});

// The read back itself, which the tool runs with a two second wait and a test with none.
describe("reading a peek back", () => {
  const pending: V2Peek = { peekId: "p-1", state: "Pending", digest: "", requestedAt: "2026-01-01T00:00:00Z" };
  const ready: V2Peek = { ...pending, state: "Ready", digest: "running the tenant migration" };

  it("waits before every read and stops at the digest", async () => {
    const waits: number[] = [];
    const reads = [pending, pending, ready];

    const peek = await readBackPeek(
      pending,
      () => Promise.resolve(reads.shift() ?? null),
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    );

    expect(peek).toEqual(ready);
    expect(waits).toEqual([PEEK_WAIT_MS, PEEK_WAIT_MS, PEEK_WAIT_MS]);
  });

  it("answers the request it asked where the digest never lands", async () => {
    let reads = 0;

    const peek = await readBackPeek(
      pending,
      () => {
        reads += 1;
        return Promise.resolve(pending);
      },
      () => Promise.resolve(),
    );

    expect(peek).toEqual(pending);
    expect(reads).toBe(PEEK_READS);
  });

  // A peek trimmed out of the history while its host was still summarising has nothing left to
  // read, and the request the caller asked for is what it reads as.
  it("answers the request it asked where the peek is gone", async () => {
    const peek = await readBackPeek(
      pending,
      () => Promise.resolve(null),
      () => Promise.resolve(),
    );

    expect(peek).toEqual(pending);
  });
});

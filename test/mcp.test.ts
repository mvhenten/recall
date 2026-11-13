import { describe, expect, it } from "vitest";
import { MCP_PATH } from "../src/mcp";
import { TOOLS } from "../src/tools";
import { harness, MCP_PROTOCOL_VERSION } from "./harness";

const MODERN = "2026-07-28";
const MODERN_META = { "io.modelcontextprotocol/protocolVersion": MODERN };

const signedIn = async () => {
  const h = await harness();
  const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
  return { h, email, mcp: await h.connector(email) };
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

  it("scopes to global and refuses a repo-scoped save it has no repo for", async () => {
    const { mcp } = await signedIn();
    const refused = await mcp
      .tool("recall_save", { name: "deploy-steps", description: "d", type: "project", body: "b" })
      .catch((error: Error) => error.message);
    expect(refused).toContain("this connector runs in no repository");

    const scoped = (await mcp.json("recall_save", {
      name: "deploy-steps",
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

    const sessions = (await mcp.json("recall_sessions")) as Array<{ name: string; host: string; cwd: string }>;
    expect(sessions.map((session) => [session.host, session.cwd])).toEqual([["laptop", "/home/you/src/recall"]]);
    expect(await mcp.json("recall_send", { to: sessions[0]?.name ?? "", message: "ship it" })).toMatchObject({
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

import { describe, expect, it } from "vitest";
import { MCP_PATH } from "../src/mcp";
import { TOOLS } from "../src/tools";
import { harness, MCP_AUDIENCE, MCP_PROTOCOL_VERSION } from "./harness";

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
      "recall_edit",
      "recall_get",
      "recall_list",
      "recall_save",
      "recall_search",
      "recall_send",
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
    expect(await refused.text()).toContain("sign in to Access in a browser first");
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
  const headers = (assertion: string, method: string, extra: Record<string, string> = {}) => ({
    "cf-access-jwt-assertion": assertion,
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
    ...extra,
  });

  it("discovers the server and lists tools when the headers mirror the body", async () => {
    const { h, email } = await signedIn();
    const assertion = await h.assertionFor(email, MCP_AUDIENCE);
    const discovered = await h.rpc(modern("server/discover"), headers(assertion, "server/discover"));
    const result = ((await discovered.json()) as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toEqual([MODERN, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

    const listed = await h.rpc(modern("tools/list"), headers(assertion, "tools/list"));
    expect(((await listed.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOLS.length);
  });

  it("refuses a header that does not match the body, and a version it does not serve", async () => {
    const { h, email } = await signedIn();
    const assertion = await h.assertionFor(email, MCP_AUDIENCE);
    const mismatched = await h.rpc(
      modern("tools/call", { name: "recall_list", arguments: {} }),
      headers(assertion, "tools/call", { "mcp-name": "recall_search" }),
    );
    expect(mismatched.status).toBe(400);
    expect(((await mismatched.json()) as { error: { code: number } }).error.code).toBe(-32020);

    const old = await h.rpc(
      { id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" } } },
      headers(assertion, "tools/list", { "mcp-protocol-version": "2025-06-18" }),
    );
    expect(old.status).toBe(400);
    const refusal = (await old.json()) as { error: { code: number; data: { supported: string[] } } };
    expect(refusal.error.code).toBe(-32022);
    expect(refusal.error.data.supported).toContain(MODERN);
  });

  it("takes a tools/call whose Mcp-Name is base64 encoded", async () => {
    const { h, email } = await signedIn();
    const assertion = await h.assertionFor(email, MCP_AUDIENCE);
    const encoded = `=?base64?${btoa("recall_list")}?=`;
    const answered = await h.rpc(
      modern("tools/call", { name: "recall_list", arguments: {} }),
      headers(assertion, "tools/call", { "mcp-name": encoded }),
    );
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });
});

describe("the connector's two Access schemes", () => {
  it("names the scheme it tried when no assertion reaches the Worker", async () => {
    const h = await harness();
    const bare = await h.rpc({ id: 1, method: "tools/list" });
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as { error: { message: string } }).error.message).toContain(
      "sign in to Access in a browser first",
    );

    const serviceHeaders = await h.rpc({ id: 1, method: "tools/list" }, { "cf-access-client-id": "abc.access" });
    expect(((await serviceHeaders.json()) as { error: { message: string } }).error.message).toContain(
      "not a service token this account issued",
    );
  });

  it("refuses an assertion meant for another Access application", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const refused = await h.rpc(
      { id: 1, method: "tools/list" },
      { "cf-access-jwt-assertion": await h.assertionFor(email) },
    );
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      "meant for another Access application",
    );
  });

  it("refuses an email no one invited and a service token mapped to no user", async () => {
    const h = await harness();
    const stranger = await h.rpc(
      { id: 1, method: "tools/list" },
      { "cf-access-jwt-assertion": await h.assertionFor("nobody@example.com", MCP_AUDIENCE) },
    );
    expect(stranger.status).toBe(403);
    expect(((await stranger.json()) as { error: { message: string } }).error.message).toContain("is not invited");

    const unmapped = await h.rpc(
      { id: 1, method: "tools/list" },
      {
        "cf-access-jwt-assertion": await h.serviceAssertionFor("stray.access"),
        "cf-access-client-id": "stray.access",
      },
    );
    expect(unmapped.status).toBe(403);
    expect(((await unmapped.json()) as { error: { message: string } }).error.message).toContain(
      "acts for no user of this recall",
    );
  });

  it("serves a service token the deployment maps to a user", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    await h.invite(`owner-${crypto.randomUUID()}@example.com`, userId);
    h.serviceClients.set("connector.access", userId);
    const answered = await h.rpc(
      { id: 1, method: "tools/list" },
      {
        "cf-access-jwt-assertion": await h.serviceAssertionFor("connector.access"),
        "cf-access-client-id": "connector.access",
      },
    );
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOLS.length);
  });

  it("refuses a request carried from another origin, whichever scheme proved it", async () => {
    const { h, mcp } = await signedIn();
    const refused = await h.rpc({ id: 1, method: "tools/list" }, { ...mcp.headers, origin: "https://evil.test" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("https://evil.test");

    const userId = `user-${crypto.randomUUID()}`;
    await h.invite(`owner-${crypto.randomUUID()}@example.com`, userId);
    h.serviceClients.set("connector.access", userId);
    const token = await h.rpc(
      { id: 1, method: "tools/list" },
      {
        "cf-access-jwt-assertion": await h.serviceAssertionFor("connector.access"),
        "cf-access-client-id": "connector.access",
        origin: "https://evil.test",
      },
    );
    expect(token.status).toBe(403);
    expect(((await token.json()) as { error: { message: string } }).error.message).toContain("https://evil.test");
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
      hits: Array<{ memory: { name: string } }>;
    };
    expect(found.hits.map((hit) => hit.memory.name)).toEqual(["indent-style"]);

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

  it("refuses an argument the tool does not take and a tags-and-any search", async () => {
    const { mcp } = await signedIn();
    const extra = await mcp.tool("recall_get", { name: "x", depth: 2 }).catch((error: Error) => error.message);
    expect(extra).toBe("recall: recall_get takes no argument depth");

    const both = await mcp
      .tool("recall_search", { query: "q", tags: ["style"], any: true })
      .catch((error: Error) => error.message);
    expect(both).toBe("recall: pass tags or any, not both");
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
});

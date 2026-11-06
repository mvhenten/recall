import manifest from "../.claude-plugin/plugin.json";
import { TOOLS } from "./tools";

// The remote MCP endpoint, on streamable HTTP. It answers both eras of the transport: a client that
// opens with initialize is served the handshake revisions, and one that declares its version in
// _meta on every request is served the per-request revision. An answer rides the POST that asked
// for it, as a JSON body or, for a client of the older era that takes only a stream, as the one SSE
// event that stream carries. Nothing is ever sent unasked, so there is no session to keep and no
// standalone stream to open: a GET is refused the way the spec has a server decline one.

export const MCP_PATH = "/mcp";

const MODERN_VERSION = "2026-07-28";
const LATEST_LEGACY = "2025-11-25";
const LEGACY_VERSIONS = [LATEST_LEGACY, "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;

const SERVER_INFO = { name: "recall", version: manifest.version };

const INSTRUCTIONS =
  "recall is the user's durable memory across sessions, hosts and harnesses. Search it before answering from assumptions about the user or the project, and save what will matter in a later conversation. This connector runs in no repository, so memories scope to global unless a call names tags.";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
export const UNAUTHORIZED = -32001;

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolResult = { ok: true; text: string } | { ok: false; error: string };

export type RunTool = (call: ToolCall) => Promise<ToolResult>;

// Who may call, resolved once the endpoint knows the request is one it answers at all, so a client
// probing with a GET is told the shape is wrong rather than that its credentials are.
export type Authorize = () => Promise<RunTool | Response>;

type Id = string | number | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reply = (id: Id, result: unknown, status = 200): Response =>
  Response.json({ jsonrpc: "2.0", id, result }, { status, headers: { "cache-control": "no-store" } });

const refuse = (id: Id, code: number, message: string, status: number, data?: unknown): Response =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status, headers: { "cache-control": "no-store" } },
  );

// An auth refusal names the scheme that failed, since the desktop app offers several and only the
// message tells the user which one the endpoint actually saw.
export const mcpRefusal = (status: number, message: string): Response => refuse(null, UNAUTHORIZED, message, status);

// A client of the older transport era reads its answer off a stream rather than out of a JSON body,
// and says so by accepting text/event-stream and nothing else. The message is the same either way,
// so the stream carries the one event and closes.
const takesEventStream = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream") && !accept.includes("application/json") && !accept.includes("*/*");
};

const asEventStream = async (answer: Response): Promise<Response> => {
  if (answer.status !== 200 || answer.body === null) return answer;
  return new Response(`event: message\ndata: ${await answer.text()}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
};

const decodeHeader = (value: string): string => {
  const sentinel = BASE64_SENTINEL.exec(value);
  if (!sentinel?.[1]) return value;
  return new TextDecoder().decode(Uint8Array.from(atob(sentinel[1]), (char) => char.charCodeAt(0)));
};

const unsupportedVersion = (id: Id, requested: string): Response =>
  refuse(id, UNSUPPORTED_VERSION, "Unsupported protocol version", 400, {
    supported: SUPPORTED_VERSIONS,
    requested,
  });

const toolNamed = (name: unknown): (typeof TOOLS)[number] | undefined =>
  typeof name === "string" ? TOOLS.find((tool) => tool.name === name) : undefined;

const listResult = (): unknown => ({ tools: TOOLS });

const callResult = async (id: Id, params: unknown, run: RunTool): Promise<Response> => {
  if (!isRecord(params)) return refuse(id, INVALID_PARAMS, "tools/call takes {name, arguments}", 200);
  const tool = toolNamed(params.name);
  if (tool === undefined) return refuse(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`, 200);
  const args = params.arguments;
  if (args !== undefined && !isRecord(args)) {
    return refuse(id, INVALID_PARAMS, `${tool.name} takes its arguments as a JSON object`, 200);
  }
  const outcome = await run({ name: tool.name, arguments: args ?? {} });
  const text = outcome.ok ? outcome.text : outcome.error;
  return reply(id, { content: [{ type: "text", text }], ...(outcome.ok ? {} : { isError: true }) });
};

const initializeResult = (params: unknown): unknown => {
  const wanted = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  return {
    protocolVersion: LEGACY_VERSIONS.includes(wanted) ? wanted : LATEST_LEGACY,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
};

const discoverResult = (): unknown => ({
  resultType: "complete",
  supportedVersions: [MODERN_VERSION],
  capabilities: { tools: {} },
  _meta: { [META_SERVER_INFO]: SERVER_INFO },
  instructions: INSTRUCTIONS,
});

const declaredVersion = (params: unknown): string | null => {
  if (!isRecord(params) || !isRecord(params._meta)) return null;
  const version = params._meta[META_VERSION];
  return typeof version === "string" ? version : null;
};

// A modern request mirrors its method, its version and the name it addresses into headers, and a
// mismatch is a refusal: an intermediary routing on the header must never see one thing where the
// server reads another.
const headerMismatch = (request: Request, method: string, params: unknown, declared: string): string | null => {
  const header = (name: string): string | null => request.headers.get(name);
  const version = header("mcp-protocol-version");
  if (version === null) return "MCP-Protocol-Version is missing";
  if (version !== declared) {
    return `MCP-Protocol-Version header value '${version}' does not match the _meta value '${declared}'`;
  }
  const named = header("mcp-method");
  if (named === null) return "Mcp-Method is missing";
  if (named !== method) return `Mcp-Method header value '${named}' does not match body value '${method}'`;
  if (method !== "tools/call") return null;
  const name = isRecord(params) && typeof params.name === "string" ? params.name : "";
  const carried = header("mcp-name");
  if (carried === null) return "Mcp-Name is missing";
  if (decodeHeader(carried) !== name) {
    return `Mcp-Name header value '${carried}' does not match body value '${name}'`;
  }
  return null;
};

const modern = async (
  request: Request,
  id: Id,
  method: string,
  params: unknown,
  declared: string,
  run: RunTool,
): Promise<Response> => {
  if (declared !== MODERN_VERSION) return unsupportedVersion(id, declared);
  const mismatch = headerMismatch(request, method, params, declared);
  if (mismatch !== null) return refuse(id, HEADER_MISMATCH, `Header mismatch: ${mismatch}`, 400);
  if (method === "server/discover") return reply(id, discoverResult());
  if (method === "tools/list") return reply(id, listResult());
  if (method === "tools/call") return callResult(id, params, run);
  return refuse(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 404);
};

const legacy = async (request: Request, id: Id, method: string, params: unknown, run: RunTool): Promise<Response> => {
  const version = request.headers.get("mcp-protocol-version");
  if (method !== "initialize" && version !== null && !LEGACY_VERSIONS.includes(version)) {
    return unsupportedVersion(id, version);
  }
  if (method === "initialize") return reply(id, initializeResult(params));
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, listResult());
  if (method === "tools/call") return callResult(id, params, run);
  return refuse(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 404);
};

const answer = async (request: Request, authorize: Authorize): Promise<Response> => {
  const run = await authorize();
  if (run instanceof Response) return run;
  const body: unknown = await request.json().catch(() => null);
  if (body === null) return refuse(null, PARSE_ERROR, "the request body is not JSON", 400);
  if (Array.isArray(body)) {
    return refuse(null, INVALID_REQUEST, "this endpoint takes one JSON-RPC message per request", 400);
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return refuse(null, INVALID_REQUEST, 'a message must be {"jsonrpc": "2.0", "method": ...}', 400);
  }
  const { method, params } = body;
  const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  if (body.id === undefined) return new Response(null, { status: 202 });
  const declared = declaredVersion(params);
  return declared === null
    ? legacy(request, id, method, params, run)
    : modern(request, id, method, params, declared, run);
};

export const mcpEndpoint = async (request: Request, authorize: Authorize): Promise<Response> => {
  if (request.method !== "POST") {
    return refuse(
      null,
      INVALID_REQUEST,
      `${MCP_PATH} answers a POST; it opens no stream of its own and keeps no session`,
      405,
    );
  }
  const answered = await answer(request, authorize);
  return takesEventStream(request) ? asEventStream(answered) : answered;
};

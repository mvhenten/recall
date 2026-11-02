import {
  dashboardNotice,
  dashboardPage,
  HISTORY_TAB,
  historyPage,
  MEMORY_TAB,
  memoriesPage,
  memoryBodyPage,
  memorySearchPage,
  SESSIONS_TAB,
  sessionsPage,
  tabForPath,
} from "./dashboard";
import {
  type Caller,
  DEVICE_CODE_TTL_MS,
  type DeviceCodeLimits,
  decideDeviceCode,
  deviceForToken,
  formatUserCode,
  hasDevice,
  listDevices,
  POLL_INTERVAL_S,
  parseUserCode,
  pendingDeviceCode,
  pollDeviceCode,
  randomToken,
  revokeDevice,
  sameSecret,
  startDeviceCode,
  TOKEN_PATTERN,
  userForEmail,
} from "./device";
import { DEVICE_HEADER, MAX_BODY_BYTES, MAX_QUEUED_MESSAGES, type Mailbox, NOW_HEADER, parseSend } from "./mailbox";
import {
  DEFAULT_MIN_SCORE,
  type Embedder,
  FRESH_WINDOW_MS,
  type Live,
  type MemoryHit,
  type MemoryType,
  parseHistory,
  parseList,
  parseName,
  parseSave,
  parseSearch,
  parseSession,
  parseSessionId,
  parseUsage,
  type SearchInput,
  type Verify,
} from "./model";
import { CSRF_COOKIE, confirmPage, enterCodePage, messagePage, readCookie } from "./page";
import { dot, ftsQuery, quantize, reciprocalRankFusion } from "./rank";
import {
  decodeCursor,
  deleteMemory,
  describeMemories,
  endSession,
  getMemory,
  listMemories,
  listSessionHistory,
  listSessions,
  memoryCounts,
  putSession,
  recall,
  recordUsage,
  saveMemory,
  sessionHistoryFilters,
  sessionOnDevice,
  sessionTally,
  textCandidates,
  vectorCandidates,
} from "./store";

export interface Deps {
  verify: Verify;
  deviceCodeLimits: DeviceCodeLimits;
  embedder: Embedder;
  now: () => number;
}

export interface AppEnv {
  DB: D1Database;
  MAILBOX: DurableObjectNamespace<Mailbox>;
}

export interface App {
  fetch(request: Request, env: AppEnv): Promise<Response>;
}

type Refusal = (status: number, title: string, text: string) => Response;

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const error = (status: number, message: string): Response => json({ error: message }, status);

const readJson = (request: Request): Promise<unknown> => request.json().catch(() => null);

const embeddingText = (name: string, description: string, body: string): string => `${name}\n${description}\n\n${body}`;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const GRANT_ERRORS = {
  invalid_grant: "the device code is unknown or already used; run recall login again",
  expired_token: "the device code expired; run recall login again",
  slow_down: "polling too fast; wait the interval plus five seconds",
  authorization_pending: "waiting for approval in the browser",
  access_denied: "the sign-in was denied in the browser",
} as const;

const ELSEWHERE_LIMIT = 3;

type Ranking = Array<[string, number]>;

interface Rankings {
  inScope: Ranking;
  elsewhere: Ranking;
}

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export const createApp = (deps: Deps): App => {
  const authenticate = async (request: Request, db: D1Database): Promise<Caller | Response> => {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!TOKEN_PATTERN.test(token)) {
      return error(401, "missing or malformed Authorization: Bearer <device token>; run recall login");
    }
    const caller = await deviceForToken(db, token, deps.now());
    return caller ?? error(401, "this device token is unknown or revoked; run recall login");
  };

  const grantError = (code: string, description: string): Response =>
    json({ error: code, error_description: description }, 400);

  const readParams = async (request: Request): Promise<Record<string, unknown>> => {
    if ((request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(await request.text()));
    }
    const body = await readJson(request);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body } : {};
  };

  const startDevice = async (request: Request, url: URL, db: D1Database): Promise<Response> => {
    const { device_name: deviceName } = await readParams(request);
    if (typeof deviceName !== "string" || !/^[\p{L}\p{N} ._'()-]{1,100}$/u.test(deviceName)) {
      return grantError("invalid_request", "device_name must hold 1 to 100 letters, digits, spaces or . _ ' ( ) -");
    }
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    const started = await startDeviceCode(db, deviceName, clientIp, deps.deviceCodeLimits, deps.now());
    if (!started) {
      return json(
        {
          error: "slow_down",
          error_description: "too many sign-ins are waiting for approval; try again in ten minutes",
        },
        429,
      );
    }
    const userCode = formatUserCode(started.userCode);
    return json({
      device_code: started.deviceCode,
      user_code: userCode,
      verification_uri: `${url.origin}/device`,
      verification_uri_complete: `${url.origin}/device?code=${userCode}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: POLL_INTERVAL_S,
    });
  };

  const pollDevice = async (request: Request, db: D1Database): Promise<Response> => {
    const { grant_type: grantType, device_code: deviceCode } = await readParams(request);
    if (grantType !== DEVICE_GRANT) return grantError("unsupported_grant_type", `grant_type must be ${DEVICE_GRANT}`);
    if (typeof deviceCode !== "string" || !TOKEN_PATTERN.test(deviceCode)) {
      return grantError("invalid_request", "device_code is missing or malformed");
    }
    const outcome = await pollDeviceCode(db, deviceCode, deps.now());
    if (outcome.ok) return json({ access_token: outcome.accessToken, token_type: "Bearer" });
    return grantError(outcome.error, GRANT_ERRORS[outcome.error]);
  };

  const devices = async (
    request: Request,
    db: D1Database,
    caller: Caller,
    deviceId: string | undefined,
  ): Promise<Response> => {
    if (deviceId === undefined) {
      if (request.method !== "GET") return error(405, "method not allowed");
      const listed = await listDevices(db, caller.userId);
      return json({ devices: listed.map((device) => ({ ...device, current: device.deviceId === caller.deviceId })) });
    }
    if (request.method !== "DELETE") return error(405, "method not allowed");
    const target = deviceId === "current" ? caller.deviceId : deviceId;
    if (!(await revokeDevice(db, caller.userId, target))) return error(404, `no device ${target}`);
    return new Response(null, { status: 204 });
  };

  const sessions = async (
    request: Request,
    db: D1Database,
    caller: Caller,
    rawSessionId: string | undefined,
    subresource: string | undefined,
  ): Promise<Response> => {
    if (rawSessionId === undefined) {
      if (request.method !== "GET") return error(405, "method not allowed");
      const listed = await listSessions(db, caller.userId, deps.now());
      return json({
        sessions: listed.map((session) => ({ ...session, current: session.deviceId === caller.deviceId })),
      });
    }
    const sessionId = parseSessionId(decodeSegment(rawSessionId) ?? "");
    if (!sessionId.ok) return error(400, sessionId.error);
    if (subresource !== undefined) {
      if (subresource !== "usage") return error(404, "not found");
      return usage(request, db, caller, sessionId.value);
    }
    if (request.method === "PUT") {
      const input = parseSession(await readJson(request));
      if (!input.ok) return error(400, input.error);
      await putSession(db, caller, sessionId.value, input.value, deps.now());
      return new Response(null, { status: 204 });
    }
    if (request.method !== "DELETE") return error(405, "method not allowed");
    if (!(await endSession(db, caller.userId, sessionId.value))) return error(404, `no session ${sessionId.value}`);
    return new Response(null, { status: 204 });
  };

  const usage = async (request: Request, db: D1Database, caller: Caller, sessionId: string): Promise<Response> => {
    if (request.method !== "POST") return error(405, "method not allowed");
    const input = parseUsage(await readJson(request));
    if (!input.ok) return error(400, input.error);
    await recordUsage(db, caller.userId, sessionId, input.value, deps.now());
    return new Response(null, { status: 204 });
  };

  const mailboxFor = (env: AppEnv, userId: string): DurableObjectStub<Mailbox> =>
    env.MAILBOX.get(env.MAILBOX.idFromName(userId));

  const sendMessage = async (request: Request, env: AppEnv, caller: Caller): Promise<Response> => {
    const input = parseSend(await readJson(request));
    if (!input.ok) return error(400, input.error);
    if (new TextEncoder().encode(input.value.body).byteLength > MAX_BODY_BYTES) {
      return error(413, `body must hold at most ${MAX_BODY_BYTES} bytes`);
    }
    const { toDeviceId, toSessionId } = input.value;
    if (!(await hasDevice(env.DB, caller.userId, toDeviceId))) return error(404, `no device ${toDeviceId}`);
    if (toSessionId !== "" && !(await sessionOnDevice(env.DB, caller.userId, toSessionId, toDeviceId, deps.now()))) {
      return error(404, `no session ${toSessionId} on device ${toDeviceId}`);
    }
    const message = await mailboxFor(env, caller.userId).enqueue(input.value, caller, deps.now());
    if (message === null) return error(429, `this account already holds ${MAX_QUEUED_MESSAGES} queued messages`);
    return json({ message }, 201);
  };

  const listen = (request: Request, env: AppEnv, caller: Caller): Promise<Response> => {
    const upgrade = new Request(request.url, {
      headers: {
        upgrade: "websocket",
        [DEVICE_HEADER]: caller.deviceId,
        [NOW_HEADER]: String(deps.now()),
      },
    });
    return mailboxFor(env, caller.userId).fetch(upgrade);
  };

  const approver = async (request: Request, refuse: Refusal = messagePage): Promise<string | Response> => {
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) return refuse(401, "Sign in first", "This page needs a Cloudflare Access sign-in.");
    const verified = await deps.verify(assertion);
    if (!verified.ok) return refuse(401, "Sign in again", `Cloudflare Access sign-in rejected: ${verified.reason}.`);
    return verified.email;
  };

  const dashboard = async (request: Request, url: URL, db: D1Database): Promise<Response> => {
    const lost = (status: number, title: string, text: string): Response =>
      dashboardNotice(status, title, text, "Back to the dashboard");
    const signIn = (status: number, title: string, text: string): Response =>
      dashboardNotice(status, title, text, "Sign in again");
    if (request.method !== "GET") return lost(405, "Not allowed", "The dashboard only answers a GET.");
    const email = await approver(request, signIn);
    if (email instanceof Response) return email;
    const userId = await userForEmail(db, email);
    if (userId === null) {
      return signIn(403, "Not invited", `${email} is not invited to this recall. Ask its owner to add it.`);
    }
    const tab = tabForPath(url.pathname);
    const now = deps.now();
    const live = await sessionTally(db, userId, now);
    if (tab === null) {
      const prefix = `${MEMORY_TAB.path}/`;
      if (!url.pathname.startsWith(prefix)) {
        return lost(404, "No such page", "The dashboard has no page at this address.");
      }
      return memoryBody(url.pathname.slice(prefix.length), db, userId, email, live, lost);
    }
    if (tab.path === MEMORY_TAB.path) return memoryTab(url, db, userId, email, live, lost);
    if (tab.path === HISTORY_TAB.path) return historyTab(url, db, userId, email, live, lost);
    if (tab.path === SESSIONS_TAB.path) return sessionsPage(email, live, await listSessions(db, userId, now), now);
    return dashboardPage(email, tab, live);
  };

  const historyTab = async (
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    lost: Refusal,
  ): Promise<Response> => {
    const input = parseHistory(url.searchParams);
    if (!input.ok) return lost(400, "Filter refused", `${input.error}.`);
    const cursor = decodeCursor(input.value.cursor);
    if (!cursor) return lost(400, "Page link refused", "This link is malformed. Start again from the History tab.");
    const page = await listSessionHistory(db, userId, input.value, cursor, deps.now());
    const known = await sessionHistoryFilters(db, userId);
    return historyPage(email, live, url, input.value, known, page.sessions, page.nextCursor);
  };

  const memoryBody = async (
    rawName: string,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    lost: Refusal,
  ): Promise<Response> => {
    const name = parseName(decodeSegment(rawName) ?? "");
    const memory = name.ok ? await getMemory(db, userId, name.value) : null;
    if (!memory) return lost(404, "No such memory", "This recall holds no memory at this address.");
    return memoryBodyPage(email, live, memory, deps.now());
  };

  const memoryTab = async (
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    lost: Refusal,
  ): Promise<Response> => {
    const input = parseList(url.searchParams);
    if (!input.ok) return lost(400, "Filter refused", `${input.error}.`);
    const filter = input.value;
    const now = deps.now();
    const counts = await memoryCounts(db, userId, now - FRESH_WINDOW_MS);
    const query = url.searchParams.get("q") ?? "";
    if (query === "") {
      const cursor = decodeCursor(filter.cursor);
      if (!cursor) return lost(400, "Page link refused", "This link is malformed. Start again from the Memory tab.");
      const page = await listMemories(db, userId, filter, cursor);
      return memoriesPage(email, live, url, filter, counts, page.memories, page.nextCursor, now);
    }
    const searched = parseSearch({
      query,
      tags: filter.tags,
      any: filter.tags.length === 0,
      limit: filter.limit,
      minScore: DEFAULT_MIN_SCORE,
      mode: "hybrid",
    });
    if (!searched.ok) return lost(400, "Search refused", `${searched.error}.`);
    const rankings = await rank(db, userId, searched.value, filter.types);
    const found = await hits(db, userId, rankings.inScope, searched.value.limit);
    return memorySearchPage(email, live, url, filter, counts, found, now);
  };

  const devicePage = async (request: Request, url: URL, db: D1Database): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "POST") return error(405, "method not allowed");
    const email = await approver(request);
    if (email instanceof Response) return email;
    const userId = await userForEmail(db, email);
    if (userId === null) {
      return messagePage(403, "Not invited", `${email} is not invited to this recall. Ask its owner to add it.`);
    }
    if (request.method === "GET") {
      const raw = url.searchParams.get("code");
      if (raw === null || raw === "") return enterCodePage(email);
      const userCode = parseUserCode(raw);
      const pending = userCode ? await pendingDeviceCode(db, userCode, deps.now()) : null;
      if (!pending)
        return messagePage(404, "Code not found", "The code is wrong, expired or used. Run recall login again.");
      return confirmPage(email, formatUserCode(pending.userCode), pending.deviceName, randomToken());
    }
    const form = new URLSearchParams(await request.text());
    const cookie = readCookie(request.headers.get("cookie"), CSRF_COOKIE);
    const csrf = form.get("csrf") ?? "";
    if (request.headers.get("origin") !== url.origin || cookie === null || !sameSecret(cookie, csrf)) {
      return messagePage(403, "Request refused", "The form did not come from this page. Reload it and try again.");
    }
    const action = form.get("action");
    if (action !== "approve" && action !== "deny") return messagePage(400, "Bad request", "Choose approve or deny.");
    const userCode = parseUserCode(form.get("user_code") ?? "");
    const decision = action === "approve" ? "approved" : "denied";
    if (
      !userCode ||
      !(await decideDeviceCode(db, userCode, decision, decision === "approved" ? userId : "", deps.now()))
    ) {
      return messagePage(404, "Code not found", "The code is wrong, expired or used. Run recall login again.");
    }
    return decision === "approved"
      ? messagePage(200, "Device approved", "Return to your terminal. You can close this page.")
      : messagePage(200, "Device denied", "The device gets no access. You can close this page.");
  };

  const save = async (request: Request, db: D1Database, userId: string, name: string): Promise<Response> => {
    const input = parseSave(await readJson(request));
    if (!input.ok) return error(400, input.error);
    const vector = await deps.embedder.embed(embeddingText(name, input.value.description, input.value.body));
    const saved = await saveMemory(db, userId, name, input.value, quantize(vector), deps.now());
    return json(saved, saved.created ? 201 : 200);
  };

  const list = async (url: URL, db: D1Database, userId: string): Promise<Response> => {
    const input = parseList(url.searchParams);
    if (!input.ok) return error(400, input.error);
    const cursor = decodeCursor(input.value.cursor);
    if (!cursor) return error(400, "cursor is malformed; pass the nextCursor of a previous page");
    return json(await listMemories(db, userId, input.value, cursor));
  };

  const vectorRankings = async (
    db: D1Database,
    userId: string,
    input: SearchInput,
    types: MemoryType[],
  ): Promise<Rankings> => {
    const vector = await deps.embedder.embed(input.query);
    const inScope: Ranking = [];
    const elsewhere: Ranking = [];
    for (const candidate of await vectorCandidates(db, userId, input.tags, types)) {
      const score = dot(vector, candidate.embedding);
      if (score >= input.minScore) (candidate.inScope ? inScope : elsewhere).push([candidate.memoryId, score]);
    }
    const byScore = (a: [string, number], b: [string, number]): number => b[1] - a[1];
    return { inScope: inScope.sort(byScore), elsewhere: elsewhere.sort(byScore) };
  };

  const textRankings = async (
    db: D1Database,
    userId: string,
    input: SearchInput,
    types: MemoryType[],
  ): Promise<{ inScope: string[]; elsewhere: string[] }> => {
    const match = ftsQuery(input.query);
    const candidates = match ? await textCandidates(db, userId, input.tags, types, match) : [];
    return {
      inScope: candidates.filter((candidate) => candidate.inScope).map((candidate) => candidate.memoryId),
      elsewhere: candidates.filter((candidate) => !candidate.inScope).map((candidate) => candidate.memoryId),
    };
  };

  const rank = async (db: D1Database, userId: string, input: SearchInput, types: MemoryType[]): Promise<Rankings> => {
    if (input.mode === "vector") return vectorRankings(db, userId, input, types);
    if (input.mode === "text") {
      const text = await textRankings(db, userId, input, types);
      return { inScope: reciprocalRankFusion([text.inScope]), elsewhere: reciprocalRankFusion([text.elsewhere]) };
    }
    const [vector, text] = await Promise.all([
      vectorRankings(db, userId, input, types),
      textRankings(db, userId, input, types),
    ]);
    const ids = (ranking: Ranking): string[] => ranking.map(([id]) => id);
    return {
      inScope: reciprocalRankFusion([ids(vector.inScope), text.inScope]),
      elsewhere: reciprocalRankFusion([ids(vector.elsewhere), text.elsewhere]),
    };
  };

  const hits = async (db: D1Database, userId: string, ranking: Ranking, limit: number): Promise<MemoryHit[]> => {
    const top = ranking.slice(0, limit);
    if (top.length === 0) return [];
    const described = await describeMemories(
      db,
      userId,
      top.map(([id]) => id),
    );
    const byId = new Map(described.map((memory) => [memory.memoryId, memory]));
    return top.flatMap(([id, score]) => {
      const memory = byId.get(id);
      return memory ? [{ memory, score }] : [];
    });
  };

  const search = async (request: Request, db: D1Database, userId: string): Promise<Response> => {
    const parsed = parseSearch(await readJson(request));
    if (!parsed.ok) return error(400, parsed.error);
    const input = parsed.value;
    const rankings = await rank(db, userId, input, []);
    const [shown, nearby] = await Promise.all([
      hits(db, userId, rankings.inScope, input.limit),
      hits(db, userId, rankings.elsewhere, ELSEWHERE_LIMIT),
    ]);
    const elsewhere = nearby.map(({ memory, score }) => ({
      score,
      name: memory.name,
      type: memory.type,
      tags: memory.tags,
      description: memory.description,
    }));
    return json({ hits: shown, elsewhere });
  };

  const route = async (request: Request, env: AppEnv): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/device") return devicePage(request, url, env.DB);
    if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
      return dashboard(request, url, env.DB);
    }
    if (url.pathname === "/") {
      if ((request.headers.get("accept") ?? "").includes("text/html")) {
        return new Response(null, { status: 303, headers: { location: "/dashboard", vary: "accept" } });
      }
      return Response.json(
        { error: "not found" },
        { status: 404, headers: { vary: "accept", "cache-control": "no-store" } },
      );
    }
    const [version, collection, rawName, subresource, ...rest] = url.pathname.split("/").filter((part) => part !== "");
    if (version !== "v1" || rest.length > 0) return error(404, "not found");
    if (subresource !== undefined && collection !== "sessions") return error(404, "not found");
    if (collection === "device") {
      if (request.method !== "POST") return error(405, "method not allowed");
      if (rawName === "code") return startDevice(request, url, env.DB);
      if (rawName === "token") return pollDevice(request, env.DB);
      return error(404, "not found");
    }
    const caller = await authenticate(request, env.DB);
    if (caller instanceof Response) return caller;
    if (collection === "devices") return devices(request, env.DB, caller, rawName);
    if (collection === "sessions") return sessions(request, env.DB, caller, rawName, subresource);
    if (collection === "messages") {
      if (rawName === "listen") {
        if (request.method !== "GET") return error(405, "method not allowed");
        if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
          return error(426, "/v1/messages/listen only answers a WebSocket upgrade; send Upgrade: websocket");
        }
        return listen(request, env, caller);
      }
      if (rawName !== undefined) return error(404, "not found");
      return request.method === "POST" ? sendMessage(request, env, caller) : error(405, "method not allowed");
    }
    const { userId } = caller;
    if (collection === "search" && rawName === undefined) {
      return request.method === "POST" ? search(request, env.DB, userId) : error(405, "method not allowed");
    }
    if (collection !== "memories") return error(404, "not found");
    if (rawName === undefined) {
      return request.method === "GET" ? list(url, env.DB, userId) : error(405, "method not allowed");
    }
    const name = parseName(decodeSegment(rawName) ?? "");
    if (!name.ok) return error(400, name.error);
    if (request.method === "PUT") return save(request, env.DB, userId, name.value);
    if (request.method !== "GET" && request.method !== "DELETE") return error(405, "method not allowed");
    const memory = await getMemory(env.DB, userId, name.value);
    if (!memory) return error(404, `no memory named ${name.value}`);
    if (request.method === "GET" && url.searchParams.get("recall") !== "true") return json({ memory });
    if (request.method === "GET") {
      const [recalled] = await recall(env.DB, userId, [memory.memoryId], deps.now());
      return recalled ? json({ memory: recalled }) : error(404, `no memory named ${name.value}`);
    }
    await deleteMemory(env.DB, userId, memory.memoryId);
    return new Response(null, { status: 204 });
  };

  return {
    async fetch(request: Request, env: AppEnv): Promise<Response> {
      return route(request, env).catch((failure: unknown) => {
        const requestId = crypto.randomUUID();
        const message = failure instanceof Error ? failure.message : String(failure);
        console.error(
          JSON.stringify({ requestId, error: message, stack: failure instanceof Error ? failure.stack : "" }),
        );
        return json({ error: "internal error", requestId }, 500);
      });
    },
  };
};

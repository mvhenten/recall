import { EMAIL_ONLY } from "./access";
import {
  ARTIFACT_CONTENT_TYPE,
  type Artifact,
  deleteArtifact,
  listArtifacts,
  MAX_ARTIFACT_BYTES,
  putArtifact,
  readArtifact,
  type Stored,
} from "./artifacts";
import {
  dashboardNotice,
  HISTORY_TAB,
  historyPage,
  INSIGHTS_TAB,
  insightsPage,
  LABELS_TAB,
  labelsPage,
  MEMORY_TAB,
  memoriesPage,
  memoryBodyPage,
  memorySearchPage,
  STATS_TAB,
  sessionsPage,
  statsPage,
  tabForPath,
} from "./dashboard";
import {
  type Caller,
  connectorDevice,
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
import { MCP_PATH, mcpEndpoint, mcpRefusal, type RunTool, type ToolCall, type ToolResult } from "./mcp";
import {
  DAY_MS,
  DEFAULT_MIN_SCORE,
  dayWindow,
  type Embedder,
  FRESH_WINDOW_MS,
  type Live,
  type MemoryHit,
  type MemoryType,
  parseChunkOffset,
  parseHistory,
  parseLabels,
  parseList,
  parseName,
  parseSave,
  parseSearch,
  parseSession,
  parseSessionId,
  parseSessionScope,
  parseTranscriptFile,
  parseUsage,
  type SaveInput,
  type SearchInput,
  type StatsWindows,
  USAGE_CHART_DAYS,
  USAGE_MONTH_DAYS,
  USAGE_WEEK_DAYS,
  type Verify,
} from "./model";
import { artifactPage, CSRF_COOKIE, confirmPage, enterCodePage, messagePage, readCookie } from "./page";
import { dot, ftsQuery, quantize, reciprocalRankFusion } from "./rank";
import {
  countedFiles,
  decodeCursor,
  deleteMemory,
  describeMemories,
  endSession,
  getMemory,
  labelTargets,
  listMemories,
  listSessionHistory,
  listSessionHistoryIds,
  listSessions,
  liveTally,
  memoryCounts,
  putSession,
  readInsights,
  readLabels,
  readStats,
  recall,
  recordUsage,
  saveMemory,
  sessionHistoryFilters,
  sessionOnDevice,
  sessionOnRecord,
  textCandidates,
  vectorCandidates,
  writeLabels,
} from "./store";
import {
  editedMemory,
  parseEditArgs,
  parseListArgs,
  parseNameArgs,
  parsePublishArgs,
  parseSaveArgs,
  parseSearchArgs,
  parseSendArgs,
  renderMemory,
  resolveTarget,
  SEARCH_LIMIT,
  TOOLS,
  toolArguments,
} from "./tools";
import { appendChunk, MAX_CHUNK_BYTES, transcriptFiles } from "./transcripts";

export interface ArtifactHost {
  hostname: string;
  verify: Verify;
  bucket: R2Bucket;
}

// The connector endpoint, where a deployment switched it on. Its Access application admits a
// browser sign-in and an Access service token, and the service token's common name names the user
// it acts for, since a token carries no email to look up.
export interface McpHost {
  verify: Verify;
  serviceClients: Map<string, string>;
}

export interface Deps {
  verify: Verify;
  artifactHost: ArtifactHost | null;
  mcpHost: McpHost | null;
  deviceCodeLimits: DeviceCodeLimits;
  embedder: Embedder;
  now: () => number;
}

export interface AppEnv {
  DB: D1Database;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  TRANSCRIPTS: R2Bucket;
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
    url: URL,
    env: AppEnv,
    caller: Caller,
    rawSessionId: string | undefined,
    subresource: string | undefined,
  ): Promise<Response> => {
    const db = env.DB;
    if (rawSessionId === undefined) {
      if (request.method !== "GET") return error(405, "method not allowed");
      const scope = parseSessionScope(url.searchParams.get("scope"));
      if (!scope.ok) return error(400, scope.error);
      if (scope.value === "history") return sessionHistoryIds(url, db, caller);
      const listed = await listSessions(db, caller.userId, deps.now());
      return json({
        sessions: listed.map((session) => ({ ...session, current: session.deviceId === caller.deviceId })),
      });
    }
    const sessionId = parseSessionId(decodeSegment(rawSessionId) ?? "");
    if (!sessionId.ok) return error(400, sessionId.error);
    if (subresource !== undefined) {
      if (subresource === "usage") return usage(request, db, caller, sessionId.value);
      if (subresource !== "transcript") return error(404, "not found");
      return transcript(request, url, env, caller, sessionId.value);
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

  const sessionHistoryIds = async (url: URL, db: D1Database, caller: Caller): Promise<Response> =>
    json(await listSessionHistoryIds(db, caller.userId, url.searchParams.get("cursor") ?? ""));

  const usage = async (request: Request, db: D1Database, caller: Caller, sessionId: string): Promise<Response> => {
    if (request.method !== "POST") return error(405, "method not allowed");
    const now = deps.now();
    const input = parseUsage(await readJson(request), now);
    if (!input.ok) return error(400, input.error);
    await recordUsage(db, caller.userId, sessionId, input.value, now);
    return new Response(null, { status: 204 });
  };

  // A session's transcript, read back as the stretches already written and appended to one stretch
  // at a time. The host that holds the file asks where it left off and sends on from there; it is
  // its own mark, so what the usage counter has read of the same file moves apart from it.
  const transcript = async (
    request: Request,
    url: URL,
    env: AppEnv,
    caller: Caller,
    sessionId: string,
  ): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") return error(405, "method not allowed");
    if (!(await sessionOnRecord(env.DB, caller.userId, sessionId))) return error(404, `no session ${sessionId}`);
    if (request.method === "GET") {
      const [files, counted] = await Promise.all([
        transcriptFiles(env.DB, caller.userId, sessionId),
        countedFiles(env.DB, caller.userId, sessionId),
      ]);
      return json({ files, counted });
    }
    const file = parseTranscriptFile(url.searchParams.get("file"));
    if (!file.ok) return error(400, file.error);
    const offset = parseChunkOffset(url.searchParams.get("offset"));
    if (!offset.ok) return error(400, offset.error);
    const tooLarge = error(413, `a transcript stretch must hold at most ${MAX_CHUNK_BYTES} bytes`);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_CHUNK_BYTES) return tooLarge;
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_CHUNK_BYTES) return tooLarge;
    const appended = await appendChunk(
      env.DB,
      env.TRANSCRIPTS,
      caller.userId,
      sessionId,
      file.value,
      offset.value,
      body,
    );
    if (!appended.ok) {
      return json(
        {
          error: `${file.value} holds ${appended.offset} bytes; send the stretch starting there`,
          offset: appended.offset,
        },
        409,
      );
    }
    return json({ file: file.value, offset: appended.offset });
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

  const approver = async (
    request: Request,
    verify: Verify,
    refuse: Refusal = messagePage,
  ): Promise<string | Response> => {
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) return refuse(401, "Sign in first", "This page needs a Cloudflare Access sign-in.");
    const verified = await verify(assertion);
    if (!verified.ok) return refuse(401, "Sign in again", `Cloudflare Access sign-in rejected: ${verified.reason}.`);
    if (verified.principal.kind !== "email") {
      return refuse(401, "Sign in again", `Cloudflare Access sign-in rejected: ${EMAIL_ONLY}.`);
    }
    return verified.principal.email;
  };

  const invited = async (db: D1Database, email: string, refuse: Refusal): Promise<string | Response> => {
    const userId = await userForEmail(db, email);
    return userId ?? refuse(403, "Not invited", `${email} is not invited to this recall. Ask its owner to add it.`);
  };

  const artifactSite = async (request: Request, url: URL, db: D1Database, host: ArtifactHost): Promise<Response> => {
    const lost = (): Response => messagePage(404, "No such page", "This recall publishes no page at this address.");
    if (request.method !== "GET") return messagePage(405, "Not allowed", "This host only answers a GET.");
    const email = await approver(request, host.verify);
    if (email instanceof Response) return email;
    const userId = await invited(db, email, messagePage);
    if (userId instanceof Response) return userId;
    const name = parseName(decodeSegment(url.pathname.slice(1)) ?? "");
    if (!name.ok) return lost();
    const object = await readArtifact(host.bucket, userId, name.value);
    return object === null ? lost() : artifactPage(object.body);
  };

  const dashboard = async (request: Request, url: URL, db: D1Database): Promise<Response> => {
    const lost = (status: number, title: string, text: string): Response =>
      dashboardNotice(status, title, text, "Back to the dashboard");
    const signIn = (status: number, title: string, text: string): Response =>
      dashboardNotice(status, title, text, "Sign in again");
    const tab = tabForPath(url.pathname);
    const saving = request.method === "POST" && tab?.path === LABELS_TAB.path;
    if (request.method !== "GET" && !saving) {
      return lost(405, "Not allowed", "The dashboard only answers a GET, and the Labels tab its own POST.");
    }
    const email = await approver(request, deps.verify, signIn);
    if (email instanceof Response) return email;
    const userId = await invited(db, email, signIn);
    if (userId instanceof Response) return userId;
    if (saving) return saveLabels(request, url, db, userId, lost);
    const now = deps.now();
    const live = await liveTally(db, userId, now);
    if (tab === null) {
      const prefix = `${MEMORY_TAB.path}/`;
      if (!url.pathname.startsWith(prefix)) {
        return lost(404, "No such page", "The dashboard has no page at this address.");
      }
      return memoryBody(url.pathname.slice(prefix.length), db, userId, email, live, lost);
    }
    if (tab.path === MEMORY_TAB.path) return memoryTab(url, db, userId, email, live, lost);
    if (tab.path === HISTORY_TAB.path) return historyTab(url, db, userId, email, live, lost);
    if (tab.path === STATS_TAB.path) return statsTab(db, userId, email, live, now);
    if (tab.path === INSIGHTS_TAB.path) return insightsTab(db, userId, email, live, now);
    if (tab.path === LABELS_TAB.path) return labelsTab(db, userId, email, live);
    const [sessions, labels] = await Promise.all([listSessions(db, userId, now), readLabels(db, userId)]);
    return sessionsPage(email, live, sessions, labels, now);
  };

  const labelsTab = async (db: D1Database, userId: string, email: string, live: Live): Promise<Response> => {
    const [targets, labels] = await Promise.all([labelTargets(db, userId), readLabels(db, userId)]);
    return labelsPage(email, live, targets, labels, randomToken());
  };

  const saveLabels = async (
    request: Request,
    url: URL,
    db: D1Database,
    userId: string,
    lost: Refusal,
  ): Promise<Response> => {
    const form = new URLSearchParams(await request.text());
    const cookie = readCookie(request.headers.get("cookie"), CSRF_COOKIE);
    const csrf = form.get("csrf") ?? "";
    if (request.headers.get("origin") !== url.origin || cookie === null || !sameSecret(cookie, csrf)) {
      return lost(403, "Request refused", "The form did not come from this page. Reload it and try again.");
    }
    const labels = parseLabels(form);
    if (!labels.ok) return lost(400, "Labels refused", `${labels.error}.`);
    await writeLabels(db, userId, labels.value);
    return new Response(null, { status: 303, headers: { location: LABELS_TAB.path } });
  };

  const statsTab = async (
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    now: number,
  ): Promise<Response> => {
    const windows: StatsWindows = {
      month: dayWindow(now, USAGE_MONTH_DAYS),
      fortnight: dayWindow(now, USAGE_CHART_DAYS),
      week: dayWindow(now, USAGE_WEEK_DAYS),
      prior: dayWindow(now - USAGE_WEEK_DAYS * DAY_MS, USAGE_WEEK_DAYS),
    };
    const [stats, labels] = await Promise.all([readStats(db, userId, windows), readLabels(db, userId)]);
    return statsPage(email, live, stats, labels, now);
  };

  const insightsTab = async (
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    now: number,
  ): Promise<Response> =>
    insightsPage(email, live, await readInsights(db, userId, dayWindow(now, USAGE_CHART_DAYS), now), now);

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
    const [known, labels] = await Promise.all([sessionHistoryFilters(db, userId), readLabels(db, userId)]);
    return historyPage(email, live, url, input.value, known, page.sessions, page.nextCursor, labels);
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
    const email = await approver(request, deps.verify);
    if (email instanceof Response) return email;
    const userId = await invited(db, email, messagePage);
    if (userId instanceof Response) return userId;
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

  const artifacts = async (request: Request, userId: string, rawName: string | undefined): Promise<Response> => {
    if (deps.artifactHost === null) {
      return error(404, "this recall publishes no pages; its deployment names no artifact hostname");
    }
    const { bucket, hostname } = deps.artifactHost;
    const published = (stored: Stored): Artifact => ({ ...stored, url: `https://${hostname}/${stored.name}` });
    if (rawName === undefined) {
      if (request.method !== "GET") return error(405, "method not allowed");
      return json({ artifacts: (await listArtifacts(bucket, userId)).map(published) });
    }
    const name = parseName(decodeSegment(rawName) ?? "");
    if (!name.ok) return error(400, name.error);
    const tooLarge = (): Response => error(413, `the page must hold at most ${MAX_ARTIFACT_BYTES} bytes`);
    if (request.method === "PUT") {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) return tooLarge();
      const body = await request.arrayBuffer();
      if (body.byteLength === 0) return error(400, "the request body must hold the page's HTML");
      if (body.byteLength > MAX_ARTIFACT_BYTES) return tooLarge();
      return json({ artifact: published(await putArtifact(bucket, userId, name.value, body)) });
    }
    if (request.method === "DELETE") {
      await deleteArtifact(bucket, userId, name.value);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return error(405, "method not allowed");
    const object = await readArtifact(bucket, userId, name.value);
    if (object === null) return error(404, `no page named ${name.value}`);
    return new Response(object.body, {
      headers: {
        "content-type": ARTIFACT_CONTENT_TYPE,
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
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

  const searched = async (db: D1Database, userId: string, input: SearchInput): Promise<unknown> => {
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
    return { hits: shown, elsewhere };
  };

  const search = async (request: Request, db: D1Database, userId: string): Promise<Response> => {
    const parsed = parseSearch(await readJson(request));
    if (!parsed.ok) return error(400, parsed.error);
    return json(await searched(db, userId, parsed.value));
  };

  // Which identity the endpoint saw, and which user it acts for. Each refusal names the scheme it
  // tried, so a connector that will not connect says why rather than only that it did not.
  const mcpCaller = async (request: Request, env: AppEnv, host: McpHost): Promise<Caller | Response> => {
    const assertion = request.headers.get("cf-access-jwt-assertion");
    const sentServiceHeaders = request.headers.get("cf-access-client-id") !== null;
    if (assertion === null) {
      return mcpRefusal(
        401,
        sentServiceHeaders
          ? "Cloudflare Access let the request through without an assertion, so the CF-Access-Client-Id and CF-Access-Client-Secret pair is not a service token this account issued"
          : `no Cloudflare Access assertion reached ${MCP_PATH}: sign in to Access in a browser first, or send CF-Access-Client-Id and CF-Access-Client-Secret for a service token`,
      );
    }
    const verified = await host.verify(assertion);
    if (!verified.ok) {
      return mcpRefusal(
        401,
        `Cloudflare Access ${sentServiceHeaders ? "service token" : "sign-in"} rejected: ${verified.reason}`,
      );
    }
    const { principal } = verified;
    if (principal.kind === "serviceToken") {
      const owner = host.serviceClients.get(principal.commonName);
      if (owner === undefined) {
        return mcpRefusal(
          403,
          `the Access service token ${principal.commonName} acts for no user of this recall; the deployment names one token per user`,
        );
      }
      return connectorDevice(env.DB, owner, deps.now());
    }
    const origin = request.headers.get("origin");
    const own = new URL(request.url).origin;
    if (origin !== null && origin !== own) {
      return mcpRefusal(
        403,
        `the Access sign-in scheme answers ${own} alone and this request came from ${origin}; use the CF-Access-Client-Id and CF-Access-Client-Secret service token scheme instead`,
      );
    }
    const userId = await userForEmail(env.DB, principal.email);
    if (userId === null) {
      return mcpRefusal(403, `${principal.email} is not invited to this recall; ask its owner to add it`);
    }
    return connectorDevice(env.DB, userId, deps.now());
  };

  const runTool = (env: AppEnv, caller: Caller): RunTool => {
    const db = env.DB;
    const { userId } = caller;
    const refused = (error: string): ToolResult => ({ ok: false, error: `recall: ${error}` });
    const document = (value: unknown): ToolResult => ({ ok: true, text: JSON.stringify(value) });
    const saved = async (name: string, input: SaveInput): Promise<ToolResult> => {
      const vector = await deps.embedder.embed(embeddingText(name, input.description, input.body));
      const written = await saveMemory(db, userId, name, input, quantize(vector), deps.now());
      return document({ name: written.memory.name, created: written.created, tags: written.memory.tags });
    };
    return async (call: ToolCall): Promise<ToolResult> => {
      const definition = TOOLS.find((tool) => tool.name === call.name);
      if (definition === undefined) return refused(`no tool named ${call.name}`);
      const args = toolArguments(definition, call.arguments);
      if (!args.ok) return refused(args.error);
      if (call.name === "recall_search") {
        const input = parseSearchArgs(args.value);
        if (!input.ok) return refused(input.error);
        const { query, tags, mode } = input.value;
        return document(
          await searched(db, userId, { query, tags, mode, limit: SEARCH_LIMIT, minScore: DEFAULT_MIN_SCORE }),
        );
      }
      if (call.name === "recall_get") {
        const input = parseNameArgs(args.value);
        if (!input.ok) return refused(input.error);
        const memory = await getMemory(db, userId, input.value.name);
        if (memory === null) return refused(`no memory named ${input.value.name}`);
        const [recalled] = await recall(db, userId, [memory.memoryId], deps.now());
        return { ok: true, text: renderMemory(recalled ?? memory) };
      }
      if (call.name === "recall_list") {
        const input = parseListArgs(args.value);
        if (!input.ok) return refused(input.error);
        const cursor = decodeCursor("");
        if (!cursor) return refused("the listing cursor is malformed");
        const page = await listMemories(db, userId, { ...input.value, types: [], cursor: "" }, cursor);
        return document(page.memories);
      }
      if (call.name === "recall_save") {
        const input = parseSaveArgs(args.value);
        if (!input.ok) return refused(input.error);
        const name = parseName(input.value.name);
        if (!name.ok) return refused(name.error);
        const { description, type, body, tags } = input.value;
        return saved(name.value, { description, type, body, tags });
      }
      if (call.name === "recall_edit") {
        const input = parseEditArgs(args.value);
        if (!input.ok) return refused(input.error);
        const memory = await getMemory(db, userId, input.value.name);
        if (memory === null) return refused(`no memory named ${input.value.name}`);
        const edited = editedMemory(memory, input.value);
        return saved(memory.name, edited);
      }
      if (call.name === "recall_delete") {
        const input = parseNameArgs(args.value);
        if (!input.ok) return refused(input.error);
        const memory = await getMemory(db, userId, input.value.name);
        if (memory === null) return refused(`no memory named ${input.value.name}`);
        await deleteMemory(db, userId, memory.memoryId);
        return document({ deleted: memory.name });
      }
      if (call.name === "recall_send") {
        const input = parseSendArgs(args.value);
        if (!input.ok) return refused(input.error);
        const [devices, sessions] = await Promise.all([listDevices(db, userId), listSessions(db, userId, deps.now())]);
        const target = resolveTarget(devices, sessions, input.value.to);
        if (!target.ok) return refused(target.error);
        if (new TextEncoder().encode(input.value.message).byteLength > MAX_BODY_BYTES) {
          return refused(`message must hold at most ${MAX_BODY_BYTES} bytes`);
        }
        const message = await mailboxFor(env, userId).enqueue(
          { ...target.value, body: input.value.message },
          caller,
          deps.now(),
        );
        if (message === null) return refused(`this account already holds ${MAX_QUEUED_MESSAGES} queued messages`);
        return document({
          messageId: message.messageId,
          toDeviceId: message.toDeviceId,
          toSessionId: message.toSessionId,
        });
      }
      const input = parsePublishArgs(args.value);
      if (!input.ok) return refused(input.error);
      if (deps.artifactHost === null) {
        return refused("this recall publishes no pages; its deployment names no artifact hostname");
      }
      const name = parseName(input.value.name);
      if (!name.ok) return refused(name.error);
      const bytes = new TextEncoder().encode(input.value.html).byteLength;
      if (bytes > MAX_ARTIFACT_BYTES) return refused(`the page must hold at most ${MAX_ARTIFACT_BYTES} bytes`);
      const { bucket, hostname } = deps.artifactHost;
      const stored = await putArtifact(bucket, userId, name.value, input.value.html);
      return document({ name: stored.name, url: `https://${hostname}/${stored.name}`, bytes: stored.bytes });
    };
  };

  const mcp = (request: Request, env: AppEnv): Promise<Response> =>
    mcpEndpoint(request, async () => {
      const host = deps.mcpHost;
      if (host === null) {
        return mcpRefusal(404, "this recall serves no MCP connector; its deployment has not switched one on");
      }
      const caller = await mcpCaller(request, env, host);
      return caller instanceof Response ? caller : runTool(env, caller);
    });

  const route = async (request: Request, env: AppEnv): Promise<Response> => {
    const url = new URL(request.url);
    const host = deps.artifactHost;
    if (host !== null && url.hostname === host.hostname) return artifactSite(request, url, env.DB, host);
    if (url.pathname === MCP_PATH) return mcp(request, env);
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
    if (collection === "sessions") return sessions(request, url, env, caller, rawName, subresource);
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
    if (collection === "artifacts") return artifacts(request, userId, rawName);
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

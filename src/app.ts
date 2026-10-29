import {
  type Caller,
  DEVICE_CODE_TTL_MS,
  type DeviceCodeLimits,
  decideDeviceCode,
  deviceForToken,
  formatUserCode,
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
import {
  type Embedder,
  type Memory,
  parseList,
  parseName,
  parseSave,
  parseSearch,
  type SearchInput,
  type Verify,
} from "./model";
import { CSRF_COOKIE, confirmPage, enterCodePage, messagePage, readCookie } from "./page";
import { dot, ftsQuery, quantize, reciprocalRankFusion } from "./rank";
import {
  decodeCursor,
  deleteMemory,
  describeMemories,
  getMemory,
  listMemories,
  recall,
  saveMemory,
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
}

export interface App {
  fetch(request: Request, env: AppEnv): Promise<Response>;
}

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

  const approver = async (request: Request): Promise<string | Response> => {
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) return messagePage(401, "Sign in first", "This page needs a Cloudflare Access sign-in.");
    const verified = await deps.verify(assertion);
    if (!verified.ok)
      return messagePage(401, "Sign in again", `Cloudflare Access sign-in rejected: ${verified.reason}.`);
    return verified.email;
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

  const vectorRankings = async (db: D1Database, userId: string, input: SearchInput): Promise<Rankings> => {
    const vector = await deps.embedder.embed(input.query);
    const inScope: Ranking = [];
    const elsewhere: Ranking = [];
    for (const candidate of await vectorCandidates(db, userId, input.tags)) {
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
  ): Promise<{ inScope: string[]; elsewhere: string[] }> => {
    const match = ftsQuery(input.query);
    const candidates = match ? await textCandidates(db, userId, input.tags, match) : [];
    return {
      inScope: candidates.filter((candidate) => candidate.inScope).map((candidate) => candidate.memoryId),
      elsewhere: candidates.filter((candidate) => !candidate.inScope).map((candidate) => candidate.memoryId),
    };
  };

  const rank = async (db: D1Database, userId: string, input: SearchInput): Promise<Rankings> => {
    if (input.mode === "vector") return vectorRankings(db, userId, input);
    if (input.mode === "text") {
      const text = await textRankings(db, userId, input);
      return { inScope: reciprocalRankFusion([text.inScope]), elsewhere: reciprocalRankFusion([text.elsewhere]) };
    }
    const [vector, text] = await Promise.all([vectorRankings(db, userId, input), textRankings(db, userId, input)]);
    const ids = (ranking: Ranking): string[] => ranking.map(([id]) => id);
    return {
      inScope: reciprocalRankFusion([ids(vector.inScope), text.inScope]),
      elsewhere: reciprocalRankFusion([ids(vector.elsewhere), text.elsewhere]),
    };
  };

  const search = async (request: Request, db: D1Database, userId: string): Promise<Response> => {
    const parsed = parseSearch(await readJson(request));
    if (!parsed.ok) return error(400, parsed.error);
    const input = parsed.value;
    const rankings = await rank(db, userId, input);
    const top = rankings.inScope.slice(0, input.limit);
    const nearby = rankings.elsewhere.slice(0, ELSEWHERE_LIMIT);
    const [recalled, described] = await Promise.all([
      top.length > 0
        ? recall(
            db,
            userId,
            top.map(([id]) => id),
            deps.now(),
          )
        : [],
      nearby.length > 0
        ? describeMemories(
            db,
            userId,
            nearby.map(([id]) => id),
          )
        : [],
    ]);
    const byId = (memories: Memory[]): Map<string, Memory> =>
      new Map(memories.map((memory) => [memory.memoryId, memory]));
    const recalledById = byId(recalled);
    const describedById = byId(described);
    const hits = top.flatMap(([id, score]) => {
      const memory = recalledById.get(id);
      return memory ? [{ score, memory }] : [];
    });
    const elsewhere = nearby.flatMap(([id, score]) => {
      const memory = describedById.get(id);
      return memory
        ? [{ score, name: memory.name, type: memory.type, tags: memory.tags, description: memory.description }]
        : [];
    });
    return json({ hits, elsewhere });
  };

  const route = async (request: Request, env: AppEnv): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/device") return devicePage(request, url, env.DB);
    const [version, collection, rawName, ...rest] = url.pathname.split("/").filter((part) => part !== "");
    if (version !== "v1" || rest.length > 0) return error(404, "not found");
    if (collection === "device") {
      if (request.method !== "POST") return error(405, "method not allowed");
      if (rawName === "code") return startDevice(request, url, env.DB);
      if (rawName === "token") return pollDevice(request, env.DB);
      return error(404, "not found");
    }
    const caller = await authenticate(request, env.DB);
    if (caller instanceof Response) return caller;
    if (collection === "devices") return devices(request, env.DB, caller, rawName);
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
    if (request.method === "GET") return json({ memory });
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

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
import { agentName, chunkTurns, readTurns } from "./chunks";
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
import {
  DEVICE_HEADER,
  MAX_BODY_BYTES,
  MAX_QUEUED_MESSAGES,
  type Mailbox,
  NOW_HEADER,
  parseSend,
  type Sender,
} from "./mailbox";
import {
  DAY_MS,
  DEFAULT_MIN_SCORE,
  dayWindow,
  type Embedder,
  FRESH_WINDOW_MS,
  isRecord,
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
  parseSessionSearch,
  parseTranscriptFile,
  parseUsage,
  type SearchInput,
  type SessionHit,
  type StatsWindows,
  sessionHandle,
  USAGE_CHART_DAYS,
  USAGE_MONTH_DAYS,
  USAGE_WEEK_DAYS,
  type Verify,
} from "./model";
import { artifactPage, CSRF_COOKIE, confirmPage, enterCodePage, messagePage, readCookie } from "./page";
import { dot, ftsQuery, quantize, reciprocalRankFusion } from "./rank";
import {
  type ChunkCandidate,
  type ChunkMatch,
  chunkExcerpts,
  chunkMatches,
  chunkVectors,
  countedFiles,
  decodeCursor,
  deleteMemory,
  describeMemories,
  describeSessions,
  endSession,
  findSession,
  getMemory,
  type IndexedChunk,
  type IndexMark,
  indexMark,
  labelTargets,
  listMemories,
  listSessionHistory,
  listSessionHistoryIds,
  listSessions,
  liveTally,
  memoryCounts,
  nameSession,
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
  writeChunks,
  writeLabels,
} from "./store";
import {
  archivedFiles,
  type Chunk,
  cacheChunk,
  MAIN_FILE,
  MAX_CHUNK_BYTES,
  parseChunkKey,
  putChunk,
  readStretch,
  readTranscript,
} from "./transcripts";

export interface ArtifactHost {
  hostname: string;
  verify: Verify;
  bucket: R2Bucket;
}

export interface Deps {
  verify: Verify;
  artifactHost: ArtifactHost | null;
  deviceCodeLimits: DeviceCodeLimits;
  embedder: Embedder;
  now: () => number;
}

export interface AppEnv {
  DB: D1Database;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  TRANSCRIPTS: R2Bucket;
}

// One storage event as the queue hands it over. Only the body and the two ways of answering for
// it are read, so the consumer can be driven by anything that carries a stretch.
export interface Delivered {
  body: unknown;
  ack(): void;
  retry(): void;
}

export interface App {
  fetch(request: Request, env: AppEnv): Promise<Response>;
  consume(env: AppEnv, delivered: readonly Delivered[]): Promise<number>;
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

// How much of one file an indexing pass reads. A stretch is at most a megabyte, so a session
// keeping up with its own events is caught up in one pass per event; a session far behind — one
// backfilled from years of transcripts — is caught up over as many passes as it takes, each
// committing its own mark, so the work survives a consumer that runs out of time and resumes.
const INDEX_BYTES_PER_PASS = 1_048_576;

// The largest set of chunks one embedding call carries.
const EMBED_BATCH = 96;

// How much of a transcript's head is read for the name the harness gave the session. The harness
// writes it among the first entries; mirrors HEAD in cli/src/adopt.rs.
const HEAD_BYTES = 8_192;

// How many chunks the full-text pass returns. The vector pass scores every chunk the account
// holds, so this bounds only the half that cannot be ranked by score.
const CHUNK_MATCHES = 100;

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
      const [listed, labels] = await Promise.all([listDevices(db, caller.userId), readLabels(db, caller.userId)]);
      return json({
        devices: listed.map((device) => ({
          ...device,
          label: labels.hosts.get(device.host) ?? "",
          current: device.deviceId === caller.deviceId,
        })),
      });
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
      if (scope.value === "search") return searchSessions(url, db, caller.userId);
      const [listed, labels] = await Promise.all([
        listSessions(db, caller.userId, deps.now()),
        readLabels(db, caller.userId),
      ]);
      return json({
        sessions: listed.map((session) => ({
          ...session,
          hostLabel: labels.hosts.get(session.host) ?? "",
          current: session.deviceId === caller.deviceId,
        })),
      });
    }
    const sessionId = parseSessionId(decodeSegment(rawSessionId) ?? "");
    if (!sessionId.ok) return error(400, sessionId.error);
    if (subresource !== undefined) {
      if (subresource === "usage") return usage(request, db, caller, sessionId.value);
      if (subresource !== "transcript") return error(404, "not found");
      return transcript(request, url, env, caller, sessionId.value);
    }
    if (request.method === "GET") return session(env, caller, sessionId.value);
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

  // One session, addressed by its Claude Code session id, by the name the harness gave it, or by
  // the handle `recall send` takes. It answers with the transcript files the archive holds too, so
  // a host restoring the session asks once and then reads them. Those are counted off the objects:
  // a restore writes the files it is given to disk, so a count a second behind would write a
  // session short of its last stretch.
  const session = async (env: AppEnv, caller: Caller, target: string): Promise<Response> => {
    const db = env.DB;
    const found = await findSession(db, caller.userId, target, deps.now());
    if (!found) return error(404, `no session named ${target}`);
    const [files, labels] = await Promise.all([
      archivedFiles(env.TRANSCRIPTS, caller.userId, found.session.sessionId),
      readLabels(db, caller.userId),
    ]);
    return json({
      session: { ...found.session, hostLabel: labels.hosts.get(found.session.host) ?? "" },
      matches: found.matches,
      files,
    });
  };

  // Sessions by meaning. Every chunk the account holds is scored against the query and the
  // full-text query runs over the same table, and the two rankings are fused with a third: the
  // user's own chunks, scored again on their own, so a session that was asked for a thing
  // outranks one that merely mentioned it.
  const searchSessions = async (url: URL, db: D1Database, userId: string): Promise<Response> => {
    const parsed = parseSessionSearch(url.searchParams);
    if (!parsed.ok) return error(400, parsed.error);
    const input = parsed.value;
    const [vector] = await deps.embedder.embed([input.query]);
    if (!vector) throw new Error("the embedder answered the query with no vector");
    const match = ftsQuery(input.query);
    const [chunks, matched] = await Promise.all([
      chunkVectors(db, userId),
      match === null ? Promise.resolve<ChunkMatch[]>([]) : chunkMatches(db, userId, match, CHUNK_MATCHES),
    ]);
    if (chunks.length === 0) return json({ hits: [] });
    const scored = chunks
      .map((chunk): [ChunkCandidate, number] => [chunk, dot(vector, chunk.embedding)])
      .sort((a, b) => b[1] - a[1]);
    const ids = (held: Array<[ChunkCandidate, number]>): string[] => held.map(([chunk]) => String(chunk.chunkSeq));
    const fused = reciprocalRankFusion([
      ids(scored),
      ids(scored.filter(([chunk]) => chunk.speaker === "user")),
      matched.map((hit) => String(hit.chunkSeq)),
    ]);
    const bySeq = new Map(chunks.map((chunk) => [chunk.chunkSeq, chunk]));
    const best = new Map<string, { chunkSeq: number; score: number }>();
    for (const [id, score] of fused) {
      const chunk = bySeq.get(Number(id));
      if (chunk && !best.has(chunk.sessionId)) best.set(chunk.sessionId, { chunkSeq: chunk.chunkSeq, score });
    }
    const top = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, input.limit);
    const [described, excerpts] = await Promise.all([
      describeSessions(
        db,
        userId,
        top.map(([id]) => id),
        deps.now(),
      ),
      chunkExcerpts(
        db,
        userId,
        top.map(([, hit]) => hit.chunkSeq),
      ),
    ]);
    // A chunk exists only for a session that was archived, and archiving answers only for a
    // session on record, so a chunk whose session or own text has gone is a store that has come
    // apart. Dropping the hit would answer a search with a short list and say nothing.
    const hits: SessionHit[] = top.map(([sessionId, hit]) => {
      const found = described.get(sessionId);
      const excerpt = excerpts.get(hit.chunkSeq);
      if (!found || !excerpt) throw new Error(`chunk ${hit.chunkSeq} of session ${sessionId} has no session or text`);
      return { session: found, score: hit.score, excerpt };
    });
    return json({ hits });
  };

  // One bite of one session's prose, read out of the archive and written into the index. It
  // reads from where the last bite stopped and at most a megabyte, and the mark it leaves is
  // where the bite ended in the file and never how much it read, so a pass over a hole in the
  // archive moves on rather than reading the same bite again. The pass answers where it reached,
  // which is what says whether there is more.
  const indexBite = async (env: AppEnv, userId: string, sessionId: string, mark: IndexMark): Promise<number> => {
    const bite = await readStretch(
      env.TRANSCRIPTS,
      userId,
      sessionId,
      MAIN_FILE,
      mark.indexed,
      mark.archived,
      INDEX_BYTES_PER_PASS,
    );
    if (mark.indexed === 0 && bite.text !== "") {
      const named = agentName(bite.text.slice(0, HEAD_BYTES));
      if (named !== "") await nameSession(env.DB, userId, sessionId, named);
    }
    const chunks = chunkTurns(readTurns(bite.text));
    const indexed: IndexedChunk[] = [];
    for (let at = 0; at < chunks.length; at += EMBED_BATCH) {
      const batch = chunks.slice(at, at + EMBED_BATCH);
      const vectors = await deps.embedder.embed(batch.map((chunk) => chunk.text));
      batch.forEach((chunk, index) => {
        const vector = vectors[index];
        if (!vector) throw new Error(`the embedder answered ${batch.length} chunks with ${vectors.length} vectors`);
        indexed.push({ ...chunk, embedding: quantize(vector) });
      });
    }
    await writeChunks(env.DB, userId, sessionId, mark.chunks, indexed, bite.through);
    return bite.through;
  };

  // One session, caught up with its archive. The event that wrote the stretch is what brings the
  // indexer here, so there is no queue to read and no session to pick; a session with nothing new
  // costs the row that says so. A bite that reaches no further than the last is the end of what
  // the objects hold, whatever the cache says, and stops the pass rather than repeating it.
  const indexSession = async (env: AppEnv, userId: string, sessionId: string): Promise<number> => {
    let read = 0;
    for (;;) {
      const mark = await indexMark(env.DB, userId, sessionId);
      if (mark === null || mark.indexed >= mark.archived) return read;
      const through = await indexBite(env, userId, sessionId, mark);
      if (through <= mark.indexed) return read;
      read += through - mark.indexed;
    }
  };

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
  //
  // The listing is counted off the objects, since a host deciding where to write next cannot be
  // a second behind the archive. An append writes the object and nothing else: it claims no
  // offset, so there is no second write to disagree with the first and nothing to give back when
  // one fails, and where the file reaches afterwards is arithmetic rather than a read. The one
  // append that costs a listing is the one beaten to its offset, which is told where the file
  // reaches so it can carry on from there.
  const transcript = async (
    request: Request,
    url: URL,
    env: AppEnv,
    caller: Caller,
    sessionId: string,
  ): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") return error(405, "method not allowed");
    if (!(await sessionOnRecord(env.DB, caller.userId, sessionId))) return error(404, `no session ${sessionId}`);
    const wanted = url.searchParams.get("file");
    if (request.method === "GET" && wanted === null) {
      const [files, counted] = await Promise.all([
        archivedFiles(env.TRANSCRIPTS, caller.userId, sessionId),
        countedFiles(env.DB, caller.userId, sessionId),
      ]);
      return json({ files, counted });
    }
    const file = parseTranscriptFile(wanted);
    if (!file.ok) return error(400, file.error);
    if (request.method === "GET") {
      const body = await readTranscript(env.TRANSCRIPTS, caller.userId, sessionId, file.value);
      if (body === null) return error(404, `session ${sessionId} has no ${file.value} on record`);
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      });
    }
    const offset = parseChunkOffset(url.searchParams.get("offset"));
    if (!offset.ok) return error(400, offset.error);
    const tooLarge = error(413, `a transcript stretch must hold at most ${MAX_CHUNK_BYTES} bytes`);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_CHUNK_BYTES) return tooLarge;
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_CHUNK_BYTES) return tooLarge;
    const end = await putChunk(env.TRANSCRIPTS, caller.userId, sessionId, file.value, offset.value, body);
    if (end !== null) return json({ file: file.value, offset: end });
    const held = await archivedFiles(env.TRANSCRIPTS, caller.userId, sessionId);
    const reaches = held.find((archived) => archived.file === file.value)?.bytes ?? offset.value;
    return json(
      { error: `${file.value} holds ${reaches} bytes; send the stretch starting there`, offset: reaches },
      409,
    );
  };

  const mailboxFor = (env: AppEnv, userId: string): DurableObjectStub<Mailbox> =>
    env.MAILBOX.get(env.MAILBOX.idFromName(userId));

  // The handle is minted the same way the sessions listing mints it, so `recall send` takes it back
  // verbatim. A sender naming a session it does not have live is named by its host alone.
  const senderOf = async (db: D1Database, caller: Caller, fromSessionId: string, now: number): Promise<Sender> => {
    const labels = await readLabels(db, caller.userId);
    const named =
      fromSessionId !== "" && (await sessionOnDevice(db, caller.userId, fromSessionId, caller.deviceId, now));
    return {
      deviceId: caller.deviceId,
      host: labels.hosts.get(caller.host) ?? caller.host,
      name: named ? sessionHandle(caller.name, fromSessionId) : "",
    };
  };

  const sendMessage = async (request: Request, env: AppEnv, caller: Caller): Promise<Response> => {
    const input = parseSend(await readJson(request));
    if (!input.ok) return error(400, input.error);
    if (new TextEncoder().encode(input.value.body).byteLength > MAX_BODY_BYTES) {
      return error(413, `body must hold at most ${MAX_BODY_BYTES} bytes`);
    }
    const { toDeviceId, toSessionId, fromSessionId } = input.value;
    const now = deps.now();
    if (!(await hasDevice(env.DB, caller.userId, toDeviceId))) return error(404, `no device ${toDeviceId}`);
    if (toSessionId !== "" && !(await sessionOnDevice(env.DB, caller.userId, toSessionId, toDeviceId, now))) {
      return error(404, `no session ${toSessionId} on device ${toDeviceId}`);
    }
    const sender = await senderOf(env.DB, caller, fromSessionId, now);
    const message = await mailboxFor(env, caller.userId).enqueue(input.value, sender, now);
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
    return verified.email;
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
    const [vector] = await deps.embedder.embed([embeddingText(name, input.value.description, input.value.body)]);
    if (!vector) throw new Error("the embedder answered the memory with no vector");
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
    const [vector] = await deps.embedder.embed([input.query]);
    if (!vector) throw new Error("the embedder answered the query with no vector");
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
    const host = deps.artifactHost;
    if (host !== null && url.hostname === host.hostname) return artifactSite(request, url, env.DB, host);
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
    // Everything the service derives from a stretch, done when the stretch lands. The storage
    // event carries the object key, the key carries who wrote what where, and both the cache and
    // the index are computed from that alone — never from what the consumer did last — so an
    // event delivered twice writes the same rows and indexes nothing a second time.
    //
    // The cache goes down for the whole delivery in one batch; a D1 failure there fails the
    // delivery and the retry writes the same rows again. Indexing is caught per session, and the
    // messages that brought a session here are sent back for redelivery when it fails: a
    // transcript the indexer cannot get through — a hole in the archive, an embedding call the
    // model refuses — is tried again on its own while every other session's message acks.
    async consume(env: AppEnv, delivered: readonly Delivered[]): Promise<number> {
      const landed: Chunk[] = [];
      const sessions = new Map<string, { chunk: Chunk; messages: Delivered[] }>();
      for (const message of delivered) {
        const event = isRecord(message.body) && isRecord(message.body.object) ? message.body.object : {};
        const chunk = parseChunkKey(event.key, event.size);
        if (chunk === null) {
          console.error(JSON.stringify({ error: "no transcript stretch in this storage event", event: message.body }));
          message.ack();
          continue;
        }
        landed.push(chunk);
        if (chunk.file !== MAIN_FILE) continue;
        const session = sessions.get(`${chunk.userId}/${chunk.sessionId}`);
        if (session === undefined) sessions.set(`${chunk.userId}/${chunk.sessionId}`, { chunk, messages: [message] });
        else session.messages.push(message);
      }
      if (landed.length === 0) return 0;
      const cached = landed.flatMap((chunk) => cacheChunk(env.DB, chunk));
      if (cached.length > 0) await env.DB.batch(cached);
      let indexed = 0;
      for (const { chunk, messages } of sessions.values()) {
        const read = await indexSession(env, chunk.userId, chunk.sessionId).catch((failure: unknown) => {
          console.error(
            JSON.stringify({
              error: failure instanceof Error ? failure.message : String(failure),
              indexing: chunk.sessionId,
              stack: failure instanceof Error ? failure.stack : "",
            }),
          );
          return null;
        });
        if (read === null) {
          for (const message of messages) message.retry();
          continue;
        }
        indexed += read;
      }
      return indexed;
    },
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

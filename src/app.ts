import {
  type ArtifactRefusal,
  artifactNotice,
  documentPage,
  PLAYER_SCRIPT_PATH,
  playerPage,
  playerScript,
  RAW_VIEW,
  RENDER_CEILING_BYTES,
  rawDocumentPage,
} from "./artifact-page";
import {
  type ArtifactFile,
  type ArtifactListInput,
  type ArtifactRecord,
  type ArtifactView,
  contentTypeFor,
  deleteArtifactFiles,
  deleteRevision,
  fileKey,
  headArtifactFile,
  MAX_ARTIFACT_BYTES,
  MAX_FILE_BYTES,
  parseArtifactList,
  parseFilePath,
  parseManifest,
  RAW_INLINE_BYTES,
  readArtifactFile,
} from "./artifacts";
import { chunkTurns } from "./chunks";
import {
  ARTIFACTS_TAB,
  type ArtifactShelf,
  artifactsPage,
  dashboardNotice,
  type Flash,
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
  SESSIONS_PATH,
  type SessionView,
  STATS_TAB,
  sessionPage,
  sessionPath,
  sessionsPage,
  statsPage,
  TRANSCRIPT_SCRIPT_PATH,
  TRANSCRIPT_SEGMENT,
  type TranscriptPlan,
  tabForPath,
  transcriptScript,
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
import { ARTIFACT_SORTS, HISTORY_SORTS, MAX_SEARCH_MATCHES, MEMORY_SORTS, sortInForce } from "./listing";
import {
  DEVICE_HEADER,
  MAX_BODY_BYTES,
  MAX_QUEUED_MESSAGES,
  type Mailbox,
  NOW_HEADER,
  parseSend,
  type Sender,
} from "./mailbox";
import { render } from "./markdown";
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
  parseByteRange,
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
import { boundaryOf, readMultipart } from "./multipart";
import {
  artifactPage,
  CSRF_COOKIE,
  confirmPage,
  enterCodePage,
  messagePage,
  readCookie,
  SENT_COOKIE,
  sizeText,
} from "./page";
import { dot, ftsQuery, quantize, reciprocalRankFusion } from "./rank";
import {
  accountReadableElsewhere,
  adoptArtifacts,
  artifactCounts,
  artifactCursorDirection,
  type ChunkCandidate,
  type ChunkMatch,
  type Cursor,
  chunkExcerpts,
  chunkMatches,
  chunkVectors,
  claimRevision,
  countedFiles,
  createArtifact,
  decodeCursor,
  deleteArtifactRow,
  deleteMemory,
  describeMemories,
  describeSessions,
  endSession,
  findSession,
  getArtifact,
  getMemory,
  historyCursorDirection,
  type IndexedChunk,
  type IndexMark,
  indexMark,
  labelTargets,
  listArtifactPage,
  listMemories,
  listSessionHistory,
  listSessionHistoryIds,
  listSessions,
  liveSessionDevice,
  liveTally,
  memoryCounts,
  memoryCursorDirection,
  nameSession,
  putSession,
  readInsights,
  readLabels,
  readStats,
  recall,
  recordUsage,
  replaceArtifact,
  resolveArtifact,
  saveMemory,
  searchArtifacts,
  searchSessionHistory,
  sessionHistoryFilters,
  sessionOnDevice,
  sessionOnRecord,
  sessionSpend,
  textCandidates,
  vectorCandidates,
  writeChunks,
  writeLabels,
} from "./store";
import type { Reach } from "./transcript-plan";
import {
  archivedFiles,
  archivedSince,
  archivedTranscript,
  type Chunk,
  cacheChunk,
  MAIN_FILE,
  MAX_CHUNK_BYTES,
  parseChunkKey,
  putChunk,
  readChunk,
  readStretch,
  readTranscript,
} from "./transcripts";
import { agentName, readTurns } from "./turns";

export interface ArtifactHost {
  hostname: string;
  verify: Verify;
  bucket: R2Bucket;
  // Where an artifact page's footer points. The artifact hostname answers artifacts and nothing
  // else, so the dashboard is a second host and this is the only place its address is known.
  dashboard: string;
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

export type Delivered = Pick<Message<unknown>, "body" | "ack" | "retry">;

export interface App {
  fetch(request: Request, env: AppEnv): Promise<Response>;
  consume(env: AppEnv, delivered: readonly Delivered[]): Promise<void>;
}

type Refusal = (status: number, title: string, text: string) => Response;

const json = (body: unknown, status = 200, headers?: HeadersInit): Response => Response.json(body, { status, headers });
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

// A message typed into the dashboard comes from a person at a browser and from no device at all,
// so it says so rather than borrowing one: its host and its device id both read `dashboard`, and
// the name it carries is the Access email that signed in. Device ids are UUIDs, so no device of
// the account can be mistaken for the sender of something it did not send.
const DASHBOARD_DEVICE = "dashboard";

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

// The largest manifest a publish may send. It carries a title, a description, two permissions and
// at most fifty paths, so a body past this is not a manifest.
const MANIFEST_BYTES = 64 * 1024;

const viewOf = (host: ArtifactHost, record: ArtifactRecord): ArtifactView => ({
  name: record.name,
  url: `https://${host.hostname}/${encodeURIComponent(record.name)}`,
  type: record.type,
  title: record.title,
  description: record.description,
  read: record.read,
  write: record.write,
  fileCount: record.fileCount,
  bytes: record.bytes,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  lastWriter: record.lastWriter,
});

const jsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const momentOf = (at: number): string => `${new Date(at).toISOString().slice(0, 16)}Z`;

// What the file route answers for a ranged read. R2 computed the slice, so the header is read back
// off the object rather than off the request.
const contentRangeOf = (range: R2Range | undefined, size: number): string => {
  if (range === undefined) return `bytes 0-${Math.max(size - 1, 0)}/${size}`;
  const suffix = "suffix" in range ? range.suffix : 0;
  const offset = "offset" in range && range.offset !== undefined ? range.offset : size - suffix;
  const length = "length" in range && range.length !== undefined ? range.length : size - offset;
  return `bytes ${offset}-${offset + length - 1}/${size}`;
};

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
    const chunks = chunkTurns(readTurns(bite.text, MAIN_FILE));
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
  const indexSession = async (env: AppEnv, userId: string, sessionId: string): Promise<boolean> => {
    for (;;) {
      const mark = await indexMark(env.DB, userId, sessionId);
      if (mark === null || mark.indexed >= mark.archived) return true;
      const through = await indexBite(env, userId, sessionId, mark);
      if (through <= mark.indexed) return true;
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
    const reaches = held.find((archived) => archived.file === file.value)?.bytes;
    // The put was refused because an object already sits at that key, and the listing that found
    // it out is strongly consistent, so the file is always among them. Answering `offset` where it
    // is not would send the client back to the stretch it was just refused, forever.
    if (reaches === undefined) {
      throw new Error(
        `the archive refused a stretch of ${file.value} but holds no ${file.value} of session ${sessionId}`,
      );
    }
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

  // One file of one artifact, streamed. The request's own headers are handed to R2, so the slice is
  // R2's to compute and a seek in a long track never waits for the bytes before it. The manifest
  // names the content type, and a path the manifest does not name is a 404 whoever asks.
  const artifactFile = async (
    request: Request,
    bucket: R2Bucket,
    record: ArtifactRecord,
    path: string,
    lost: () => Response,
  ): Promise<Response> => {
    const asked = parseFilePath(path);
    if (!asked.ok) return lost();
    const entry = record.files.find((file) => file.path === asked.value);
    if (entry === undefined) return lost();
    const object = await bucket.get(fileKey(record.ownerUserId, record.name, record.rev, entry.path), {
      range: request.headers,
      onlyIf: request.headers,
    });
    if (object === null) return lost();
    const headers: Record<string, string> = {
      "content-type": entry.contentType,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
    };
    if (!("body" in object)) return new Response(null, { status: 304, headers });
    if (!request.headers.has("range")) return new Response(object.body, { headers });
    return new Response(object.body, {
      status: 206,
      headers: { ...headers, "content-range": contentRangeOf(object.range, object.size) },
    });
  };

  const entryBody = async (bucket: R2Bucket, record: ArtifactRecord): Promise<R2ObjectBody> => {
    const object = await readArtifactFile(bucket, record.ownerUserId, record.name, record.rev, record.entryPath);
    if (object === null) {
      throw new Error(`artifact ${record.name} names ${record.entryPath} and storage holds no such file`);
    }
    return object;
  };

  // The start of the entry, and no more. The raw view is the fallback for a document too long to
  // render, so it is the one view handed a file of up to 32 MB: it reads a bounded range rather
  // than the whole object, because the page escapes what it prints and concatenates it into one
  // string. A range can cut a UTF-8 sequence in half, and a decoder left mid-stream holds the
  // trailing bytes back rather than printing a replacement character for them.
  const entryHead = async (bucket: R2Bucket, record: ArtifactRecord, bytes: number): Promise<string> => {
    const object = await bucket.get(fileKey(record.ownerUserId, record.name, record.rev, record.entryPath), {
      range: { offset: 0, length: bytes },
    });
    if (object === null) {
      throw new Error(`artifact ${record.name} names ${record.entryPath} and storage holds no such file`);
    }
    return new TextDecoder().decode(await object.arrayBuffer(), { stream: true });
  };

  // The rendered view, the raw view, and the redirect that stands in for a render too long to
  // spend the CPU on. Both views are recall's own HTML off the publisher's markdown, so neither
  // carries a script and the renderer escapes every character it prints.
  const documentView = async (url: URL, host: ArtifactHost, record: ArtifactRecord): Promise<Response> => {
    const entry = record.files[0];
    if (entry === undefined) throw new Error(`artifact ${record.name} names no file`);
    if (url.searchParams.get("view") === RAW_VIEW) {
      const source = await entryHead(host.bucket, record, RAW_INLINE_BYTES);
      return rawDocumentPage(record, host.dashboard, source, entry.bytes > RAW_INLINE_BYTES);
    }
    if (entry.bytes > RENDER_CEILING_BYTES) {
      return new Response(null, {
        status: 302,
        headers: { location: `/${encodeURIComponent(record.name)}?view=${RAW_VIEW}`, "cache-control": "no-store" },
      });
    }
    const source = await (await entryBody(host.bucket, record)).text();
    return documentPage(record, host.dashboard, render(source, record.name));
  };

  // The player, with every entry the manifest names checked against storage as the page is drawn:
  // a track whose file is gone keeps its row and its mark rather than failing silently when a
  // reader presses play.
  const playerView = async (host: ArtifactHost, record: ArtifactRecord): Promise<Response> => {
    const held = await Promise.all(
      record.files.map((file) => headArtifactFile(host.bucket, record.ownerUserId, record.name, record.rev, file.path)),
    );
    const missing = record.files.filter((_file, index) => held[index] === null).map((file) => file.path);
    return playerPage(record, host.dashboard, missing);
  };

  // An artifact published before a row carried its type. Its bytes are at the bare key and no row
  // names them, so the address keeps working and the tab lists it once the operator adopts it.
  const legacySite = async (host: ArtifactHost, userId: string, name: string): Promise<Response | null> => {
    const object = await host.bucket.get(fileKey(userId, name, 0, ""));
    return object === null ? null : artifactPage(object.body);
  };

  const artifactSite = async (request: Request, url: URL, db: D1Database, host: ArtifactHost): Promise<Response> => {
    const notice = (refusal: ArtifactRefusal): Response => artifactNotice(refusal, host.dashboard);
    if (request.method !== "GET") return notice({ kind: "method" });
    const address = `${url.pathname}${url.search}`;
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) {
      return notice({ kind: "unauthorized", reason: "this host saw no sign-in at all", address });
    }
    const verified = await host.verify(assertion);
    if (!verified.ok) return notice({ kind: "unauthorized", reason: verified.reason, address });
    const userId = await userForEmail(db, verified.email);
    if (userId === null) return notice({ kind: "forbidden", email: verified.email });
    // A name is a kebab-case slug and cannot hold a dot, so the player's script answers here
    // without standing in front of any artifact's address.
    if (url.pathname === PLAYER_SCRIPT_PATH) return playerScript();
    const [rawName, ...rest] = url.pathname.slice(1).split("/");
    const name = parseName(decodeSegment(rawName ?? "") ?? "");
    if (!name.ok) return notice({ kind: "lost" });
    const record = await resolveArtifact(db, userId, name.value);
    if (record === null) {
      return rest.length > 0
        ? notice({ kind: "lost" })
        : ((await legacySite(host, userId, name.value)) ?? notice({ kind: "lost" }));
    }
    if (rest.length > 0) {
      return artifactFile(request, host.bucket, record, rest.join("/"), () => notice({ kind: "lost" }));
    }
    if (record.type === "document") return documentView(url, host, record);
    if (record.type === "audio") return playerView(host, record);
    return artifactPage((await entryBody(host.bucket, record)).body);
  };

  const dashboard = async (request: Request, url: URL, env: AppEnv): Promise<Response> => {
    const db = env.DB;
    const lost = (status: number, title: string, text: string): Response =>
      dashboardNotice(status, title, text, "Back to the dashboard");
    const signIn = (status: number, title: string, text: string): Response =>
      dashboardNotice(status, title, text, "Sign in again");
    const tab = tabForPath(url.pathname);
    const sessionPrefix = `${SESSIONS_PATH}/`;
    const segments = url.pathname.startsWith(sessionPrefix) ? url.pathname.slice(sessionPrefix.length).split("/") : [];
    const rawSessionId = segments[0] ?? "";
    const bytes = segments.length === 2 && segments[1] === TRANSCRIPT_SEGMENT;
    const saving = request.method === "POST" && tab?.path === LABELS_TAB.path;
    const sending = request.method === "POST" && segments.length === 1;
    if (request.method !== "GET" && !saving && !sending) {
      return lost(
        405,
        "Not allowed",
        "The dashboard only answers a GET, the Labels tab its own POST, and a session page the message it sends.",
      );
    }
    const email = await approver(request, deps.verify, signIn);
    if (email instanceof Response) return email;
    const userId = await invited(db, email, signIn);
    if (userId instanceof Response) return userId;
    if (saving) return saveLabels(request, url, db, userId, lost);
    // A ranged read renders no page, so it does not pay for the tally a page carries in its
    // header: a scroll back through a long transcript is thousands of them, and a D1 write batch
    // apiece would be the whole cost of reading one. A box following a live session beats against
    // the same route, and `from` is what tells the two apart: it asks how far the file now reaches
    // rather than for the bytes of one stretch named in the manifest.
    if (bytes) {
      return url.searchParams.has("from")
        ? transcriptTail(url, env, userId, rawSessionId)
        : transcriptBytes(request, url, env, userId, rawSessionId);
    }
    const now = deps.now();
    const live = await liveTally(db, userId, now);
    if (tab === null) {
      if (segments.length === 1) {
        return sessionDetail(request, url, env, userId, email, live, rawSessionId, lost);
      }
      const prefix = `${MEMORY_TAB.path}/`;
      if (segments.length > 0 || !url.pathname.startsWith(prefix)) {
        return lost(404, "No such page", "The dashboard has no page at this address.");
      }
      return memoryBody(url.pathname.slice(prefix.length), db, userId, email, live, lost);
    }
    if (tab.path === MEMORY_TAB.path) return memoryTab(url, db, userId, email, live, lost);
    if (tab.path === ARTIFACTS_TAB.path) return artifactsTab(url, db, userId, email, live, lost);
    if (tab.path === HISTORY_TAB.path) return historyTab(url, db, userId, email, live, lost);
    if (tab.path === STATS_TAB.path) return statsTab(db, userId, email, live, now);
    if (tab.path === INSIGHTS_TAB.path) return insightsTab(db, userId, email, live, now);
    if (tab.path === LABELS_TAB.path) return labelsTab(request, db, userId, email, live);
    const [sessions, labels] = await Promise.all([listSessions(db, userId, now), readLabels(db, userId)]);
    return sessionsPage(email, live, url, sessions, labels, now);
  };

  // The token every dashboard form posts back. A browser holds one cookie for the whole site, so
  // a page that minted a fresh one on each view would invalidate the form of every page already
  // open; the cookie it arrived with is the token it keeps.
  const pageToken = (request: Request): string =>
    readCookie(request.headers.get("cookie"), CSRF_COOKIE) ?? randomToken();

  // What a dashboard form post is worth: the fields it carries, and whether it came from a page
  // of this site holding the cookie's token. The caller decides how to answer an untrusted one.
  const formPost = async (request: Request, url: URL): Promise<{ form: URLSearchParams; trusted: boolean }> => {
    const form = new URLSearchParams(await request.text());
    const cookie = readCookie(request.headers.get("cookie"), CSRF_COOKIE);
    const trusted =
      request.headers.get("origin") === url.origin && cookie !== null && sameSecret(cookie, form.get("csrf") ?? "");
    return { form, trusted };
  };

  const labelsTab = async (
    request: Request,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
  ): Promise<Response> => {
    const [targets, labels] = await Promise.all([labelTargets(db, userId), readLabels(db, userId)]);
    return labelsPage(email, live, targets, labels, pageToken(request));
  };

  const saveLabels = async (
    request: Request,
    url: URL,
    db: D1Database,
    userId: string,
    lost: Refusal,
  ): Promise<Response> => {
    const posted = await formPost(request, url);
    if (!posted.trusted) {
      return lost(403, "Request refused", "The form did not come from this page. Reload it and try again.");
    }
    const labels = parseLabels(posted.form);
    if (!labels.ok) return lost(400, "Labels refused", `${labels.error}.`);
    await writeLabels(db, userId, labels.value);
    return new Response(null, { status: 303, headers: { location: LABELS_TAB.path } });
  };

  // What the page tells the browser about a session's transcript: which files it holds, and where
  // every stretch of the chosen one sits. It is one listing and no reads — the browser fetches the
  // bytes it wants itself, off the stretches named here.
  const transcriptPlan = async (
    env: AppEnv,
    userId: string,
    sessionId: string,
    url: URL,
  ): Promise<TranscriptPlan | Response> => {
    const wanted = url.searchParams.get("file");
    const chosen = wanted === null ? { ok: true as const, value: MAIN_FILE } : parseTranscriptFile(wanted);
    if (!chosen.ok) return dashboardNotice(400, "File refused", `${chosen.error}.`, "Back to the dashboard");
    const file = chosen.value;
    const held = await archivedTranscript(env.TRANSCRIPTS, userId, sessionId);
    if (held.length === 0) return { kind: "none" };
    const files = held.map((archived) => archived.file);
    const archive = held.find((archived) => archived.file === file);
    if (archive === undefined || archive.bytes === 0) return { kind: "missing", file, files };
    return { kind: "read", file, files, bytes: archive.bytes, runs: archive.runs };
  };

  // The bytes of one stretch, streamed as they come off the archive. The key is built from the
  // user the Access assertion resolved to, so a caller reaches nothing outside its own prefix, and
  // the range is the browser's to choose: this reads no listing, joins no stretches and parses
  // nothing, which is the whole of why the window the reader sees is the browser's own business.
  const transcriptBytes = async (
    request: Request,
    url: URL,
    env: AppEnv,
    userId: string,
    rawSessionId: string,
  ): Promise<Response> => {
    const session = parseSessionId(decodeSegment(rawSessionId) ?? "");
    if (!session.ok) return error(400, session.error);
    const file = parseTranscriptFile(url.searchParams.get("file"));
    if (!file.ok) return error(400, file.error);
    const at = parseChunkOffset(url.searchParams.get("at"));
    if (!at.ok) return error(400, at.error);
    const asked = parseByteRange(request.headers.get("range"));
    if (!asked.ok) return error(416, asked.error);
    const { offset, length } = asked.value;
    const object = await readChunk(env.TRANSCRIPTS, userId, session.value, file.value, at.value, { offset, length });
    if (object === null) {
      return error(404, `the archive holds no stretch of ${file.value} at ${at.value} of session ${session.value}`);
    }
    if (offset + length > object.size) {
      return error(416, `the stretch at ${at.value} holds ${object.size} bytes`);
    }
    return new Response(object.body, {
      status: 206,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        "content-range": `bytes ${offset}-${offset + length - 1}/${object.size}`,
      },
    });
  };

  // Whether anyone is still running the session, and the stretches of its file around and past
  // where the reader has read. A box following a live session beats against this, so it answers
  // off the cheapest readings there are: the extent the storage event caches says whether the
  // file has grown past where the reader has read, and a beat that finds it has not opens no
  // object and lists nothing at all.
  //
  // That extent is a cache and lags the objects for as long as the event behind it is in flight,
  // so it is trusted to say a file has grown and never to say it has not. A session no event has
  // ever landed for keeps no row at all, and that one never corrects itself; with no row the
  // objects are listed regardless, so a reader is never left watching a box that beats on in
  // silence about a session writing away.
  //
  // `from` is how far the reader has read, and the only cursor there is: the listing reaches one
  // stretch back from it so that a stretch straddling it, or written below a key already taken,
  // is named too, and the reader reads forward from `from` across whatever comes back.
  //
  // Only the session's own file is followed. Every other file is a delegated turn, which derives
  // nothing and so keeps no extent, and a listing is the only reading that could answer for one.
  const transcriptTail = async (url: URL, env: AppEnv, userId: string, rawSessionId: string): Promise<Response> => {
    const session = parseSessionId(decodeSegment(rawSessionId) ?? "");
    if (!session.ok) return error(400, session.error);
    const file = parseTranscriptFile(url.searchParams.get("file"));
    if (!file.ok) return error(400, file.error);
    if (file.value !== MAIN_FILE) return error(400, `only ${MAIN_FILE} is followed as it is written`);
    const from = parseChunkOffset(url.searchParams.get("from"));
    if (!from.ok) return error(400, from.error);
    const [mark, device] = await Promise.all([
      indexMark(env.DB, userId, session.value),
      liveSessionDevice(env.DB, userId, session.value, deps.now()),
    ]);
    const grown = mark === null || mark.archived > from.value;
    const runs = grown ? await archivedSince(env.TRANSCRIPTS, userId, session.value, file.value, from.value) : [];
    const reach: Reach = { running: device !== null, runs };
    return json(reach, 200, { "cache-control": "no-store" });
  };

  // One session the dashboard can read and talk to. The page is reached by clicking a row of the
  // ledger or the history, and both carry sessions this account has on record, live or long over.
  const sessionDetail = async (
    request: Request,
    url: URL,
    env: AppEnv,
    userId: string,
    email: string,
    live: Live,
    rawSessionId: string,
    lost: Refusal,
  ): Promise<Response> => {
    const parsed = parseSessionId(decodeSegment(rawSessionId) ?? "");
    if (!parsed.ok) return lost(404, "No such session", "The dashboard has no page at this address.");
    const now = deps.now();
    const found = await findSession(env.DB, userId, parsed.value, now);
    if (!found) return lost(404, "No such session", `This recall holds no session ${parsed.value}.`);
    const { session } = found;
    const [deviceId, spend, labels] = await Promise.all([
      liveSessionDevice(env.DB, userId, session.sessionId, now),
      sessionSpend(env.DB, userId, session.sessionId),
      readLabels(env.DB, userId),
    ]);
    const csrf = pageToken(request);
    const render = async (flash: Flash | null, draft: string, status: number): Promise<Response> => {
      const transcript = await transcriptPlan(env, userId, session.sessionId, url);
      if (transcript instanceof Response) return transcript;
      const view: SessionView = { session, deviceId, spend, transcript, send: { csrf, draft, flash } };
      return sessionPage(email, live, view, labels, now, status);
    };
    if (request.method === "GET") {
      const sent = readCookie(request.headers.get("cookie"), SENT_COOKIE) === session.sessionId;
      return render(sent ? { tone: "sent" } : null, "", 200);
    }
    return sendToSession(request, url, env, userId, email, session.sessionId, deviceId, render);
  };

  // The dashboard's own send, which is the Labels tab's post shape pointed at the message bus: an
  // origin and CSRF check, then the same enqueue `POST /v1/messages` makes. A browser carries no
  // device token, so it cannot reach that endpoint; what it shares with it is the mailbox.
  //
  // Every refusal, the refused origin and token among them, re-renders the page with the typing
  // still in the box and says what went wrong, since a send box that clears itself and shows
  // nothing is indistinguishable from one that worked.
  const sendToSession = async (
    request: Request,
    url: URL,
    env: AppEnv,
    userId: string,
    email: string,
    sessionId: string,
    deviceId: string | null,
    render: (flash: Flash | null, draft: string, status: number) => Promise<Response>,
  ): Promise<Response> => {
    const posted = await formPost(request, url);
    const body = posted.form.get("body") ?? "";
    const refuse = (text: string, status: number): Promise<Response> => render({ tone: "refused", text }, body, status);
    if (!posted.trusted) {
      return refuse("The form did not come from this page, so nothing was sent. Send it again from here.", 403);
    }
    if (body.trim() === "") return refuse("The message was empty, so nothing was sent.", 400);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return refuse(`A message holds at most ${MAX_BODY_BYTES} bytes, and this one is longer. Nothing was sent.`, 400);
    }
    if (deviceId === null) {
      return refuse("No host is running this session any more, so the bus has nowhere to deliver it.", 400);
    }
    if (!(await hasDevice(env.DB, userId, deviceId))) {
      return refuse("The host that ran this session is signed out, so the bus has nowhere to deliver it.", 400);
    }
    const sender: Sender = { deviceId: DASHBOARD_DEVICE, host: DASHBOARD_DEVICE, name: email };
    const input = { toDeviceId: deviceId, toSessionId: sessionId, fromSessionId: "", body };
    const message = await mailboxFor(env, userId).enqueue(input, sender, deps.now());
    if (message === null) {
      return refuse(`This account already holds ${MAX_QUEUED_MESSAGES} queued messages, so the bus took nothing.`, 400);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: sessionPath(sessionId),
        "set-cookie": `${SENT_COOKIE}=${sessionId}; Path=/; Max-Age=30; Secure; HttpOnly; SameSite=Strict`,
      },
    });
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

  // A page link cut from an order a reader has since left behind, or one a hand edited, reads as
  // page one rather than as an error: the address still names the list it names.
  const pageCursor = (cursor: string, direction: "desc" | "asc"): Cursor =>
    decodeCursor(cursor, direction) ?? decodeCursor("", direction) ?? [Number.MAX_SAFE_INTEGER, ""];

  const historyTab = async (
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    lost: Refusal,
  ): Promise<Response> => {
    const chosen = sortInForce(url, HISTORY_SORTS);
    const input = parseHistory(url.searchParams, chosen.sort);
    if (!input.ok) return lost(400, "Filter refused", `${input.error}.`);
    const filter = input.value;
    const now = deps.now();
    const match = filter.query === "" ? null : ftsQuery(filter.query);
    const page =
      filter.query === ""
        ? {
            ...(await listSessionHistory(
              db,
              userId,
              filter,
              pageCursor(filter.cursor, historyCursorDirection(filter.sort)),
              now,
            )),
            cut: false,
          }
        : {
            nextCursor: "",
            ...(match === null
              ? { sessions: [], cut: false }
              : await searchSessionHistory(db, userId, filter, match, MAX_SEARCH_MATCHES, now)),
          };
    const [known, labels] = await Promise.all([sessionHistoryFilters(db, userId), readLabels(db, userId)]);
    return historyPage(email, live, url, filter, known, page.sessions, page.nextCursor, page.cut, labels);
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

  // One page of the shelf: one indexed read of the artifact rows, and one read of the counts the
  // chips and the heading print. No bytes are read and the bucket is not listed.
  const shelfFor = async (
    db: D1Database,
    host: ArtifactHost,
    userId: string,
    input: ArtifactListInput,
    cursor: Cursor,
  ): Promise<ArtifactShelf> => {
    const match = input.query === "" ? null : ftsQuery(input.query);
    const [counts, page] = await Promise.all([
      artifactCounts(db, userId),
      input.query === ""
        ? listArtifactPage(db, userId, input, cursor).then((read) => ({ ...read, cut: false }))
        : match === null
          ? Promise.resolve({ artifacts: [], nextCursor: "", cut: false })
          : searchArtifacts(db, userId, input.type, match, MAX_SEARCH_MATCHES).then((found) => ({
              ...found,
              nextCursor: "",
            })),
    ]);
    return {
      artifacts: page.artifacts.map((record) => viewOf(host, record)),
      counts,
      nextCursor: page.nextCursor,
      cut: page.cut,
    };
  };

  // The artifacts this account has published, off the same listing `GET /v1/artifacts` reads and
  // scoped by the user the Access assertion resolved to. The tab browses and nothing else:
  // publishing and unpublishing stay with `recall publish` and `recall unpublish`.
  const artifactsTab = async (
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    lost: Refusal,
  ): Promise<Response> => {
    const host = deps.artifactHost;
    if (host === null) return artifactsPage(email, live, url, { kind: "off" });
    const chosen = sortInForce(url, ARTIFACT_SORTS);
    const input = parseArtifactList(url.searchParams, chosen.sort);
    if (!input.ok) return lost(400, "Filter refused", `${input.error}.`);
    const cursor = pageCursor(input.value.cursor, artifactCursorDirection(input.value.sort));
    const shelf = await shelfFor(db, host, userId, input.value, cursor);
    return artifactsPage(email, live, url, { kind: "shelf", shelf });
  };

  const memoryTab = async (
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    lost: Refusal,
  ): Promise<Response> => {
    const chosen = sortInForce(url, MEMORY_SORTS);
    const input = parseList(url.searchParams, chosen.sort);
    if (!input.ok) return lost(400, "Filter refused", `${input.error}.`);
    const filter = input.value;
    const now = deps.now();
    const counts = await memoryCounts(db, userId, now - FRESH_WINDOW_MS);
    const query = url.searchParams.get("q") ?? "";
    if (query === "") {
      const cursor = pageCursor(filter.cursor, memoryCursorDirection(filter.sort));
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

  // What a publish is refused with when the name is taken: the artifact, its type, its size, when
  // it was last written and the email that wrote it, in a string the CLI prints verbatim and in
  // fields a tool reads.
  const conflict = (record: ArtifactRecord): Response =>
    json(
      {
        error: `${record.name} already holds a ${record.type} artifact of ${sizeText(record.bytes)}, last written ${momentOf(
          record.updatedAt,
        )} by ${record.lastWriter === "" ? "a device of this account" : record.lastWriter}; pass --replace to replace it`,
        artifact: {
          name: record.name,
          type: record.type,
          bytes: record.bytes,
          updatedAt: record.updatedAt,
          lastWriter: record.lastWriter,
        },
      },
      409,
    );

  // What a write would replace. The caller's own row comes first and is the only one a write that
  // is not replacing anything may find: one account publishing a name for the account to read must
  // not take that name away from everyone else, who would otherwise be refused their own first
  // publish under it. A caller who does mean to replace reaches the account-readable one, and the
  // write permission decides whether they may.
  const writeTarget = async (
    db: D1Database,
    userId: string,
    name: string,
    replacing: boolean,
  ): Promise<ArtifactRecord | Response | null> => {
    const own = await getArtifact(db, userId, name);
    if (own !== null) return own;
    if (!replacing) return null;
    const shared = await resolveArtifact(db, userId, name);
    if (shared === null || shared.write === "account") return shared;
    return error(403, "this artifact's write permission is owner, and only its owner replaces or deletes it");
  };

  // The revision a failed publish wrote, and the one a publish that worked replaced. Neither is
  // reachable from any address once the commit has run, so a delete that fails costs a dead
  // revision an unpublish collects later rather than the answer the caller is owed.
  const collect = (bucket: R2Bucket, userId: string, name: string, rev: number): Promise<void> =>
    deleteRevision(bucket, userId, name, rev).catch((failure: unknown) => {
      console.error(
        JSON.stringify({
          error: failure instanceof Error ? failure.message : String(failure),
          collecting: `${userId}/${name}/${rev}`,
          stack: failure instanceof Error ? failure.stack : "",
        }),
      );
    });

  // The publish. The manifest, the stored row and the gates come first and write nothing; then the
  // revision is claimed in D1, so the prefix every file streams into is one no other writer can
  // reach; then one compare-and-swap moves the row forward, which is the publish. Anything that
  // fails before that statement leaves the artifact and every one of its files exactly as they
  // were.
  const publish = async (
    request: Request,
    url: URL,
    db: D1Database,
    host: ArtifactHost,
    caller: Caller,
    name: string,
  ): Promise<Response> => {
    const tooLarge = (): Response =>
      error(413, `a file holds at most ${MAX_FILE_BYTES} bytes and an artifact at most ${MAX_ARTIFACT_BYTES}`);
    const boundary = boundaryOf(request.headers.get("content-type") ?? "");
    if (boundary === null || request.body === null) {
      return error(400, "a publish sends multipart/form-data: a manifest part, then one part per file");
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) return tooLarge();
    const parts = readMultipart(request.body, boundary);
    const head = await parts.nextPart();
    if (head === null || head.name !== "manifest") return error(400, "the first part must be named manifest");
    const text = await parts.text(MANIFEST_BYTES);
    if (text === null) return error(400, `the manifest part holds at most ${MANIFEST_BYTES} bytes`);
    const manifest = parseManifest(jsonOrNull(text));
    if (!manifest.ok) return error(400, manifest.error);
    const declaredFiles = manifest.value.files;
    const total = declaredFiles.reduce((running, file) => running + file.bytes, 0);
    if (total > MAX_ARTIFACT_BYTES || declaredFiles.some((file) => file.bytes > MAX_FILE_BYTES)) return tooLarge();
    const replacing = url.searchParams.get("replace") === "true";
    const target = await writeTarget(db, caller.userId, name, replacing);
    if (target instanceof Response) return target;
    if (target !== null && !replacing) return conflict(target);
    const owner = target?.ownerUserId ?? caller.userId;
    if (manifest.value.read === "account" && (await accountReadableElsewhere(db, owner, name))) {
      return error(409, `another account publishes ${name} for this recall to read; publish it under another name`);
    }
    const rev = await claimRevision(db, owner, name);
    const refuse = async (status: number, message: string): Promise<Response> => {
      await collect(host.bucket, owner, name, rev);
      return error(status, message);
    };
    const files: ArtifactFile[] = [];
    for (const file of declaredFiles) {
      const part = await parts.nextPart();
      if (part === null) {
        return refuse(400, `the manifest names ${declaredFiles.length} files and the body holds ${files.length}`);
      }
      // R2 takes a stream whose length is known, so the length the manifest declared is the length
      // the object is written at and the part is held to it exactly.
      const sized = new FixedLengthStream(file.bytes);
      const stored = host.bucket.put(fileKey(owner, name, rev, file.path), sized.readable);
      const written = await parts.pipe(sized.writable, file.bytes);
      if (!written.ok) {
        await stored.catch(() => undefined);
        return refuse(400, `${file.path} holds ${written.bytes} bytes and the manifest names ${file.bytes}`);
      }
      await stored;
      files.push({ path: file.path, bytes: file.bytes, contentType: contentTypeFor(file.path) });
    }
    const commit = {
      userId: owner,
      name,
      rev,
      type: manifest.value.type,
      title: manifest.value.title,
      description: manifest.value.description,
      read: manifest.value.read,
      write: manifest.value.write,
      files,
      at: deps.now(),
      writerUserId: caller.userId,
    };
    const committed =
      target === null ? await createArtifact(db, commit) : await replaceArtifact(db, commit, target.rev);
    if (!committed) {
      await collect(host.bucket, owner, name, rev);
      const held = await getArtifact(db, owner, name);
      return held === null
        ? error(409, `${name} was written by another request while this one was publishing`)
        : conflict(held);
    }
    const saved = await getArtifact(db, owner, name);
    if (saved === null) throw new Error(`artifact ${name} vanished right after it was published`);
    if (target !== null) await collect(host.bucket, owner, name, target.rev);
    return json({ artifact: viewOf(host, saved), ownedByAnother: owner !== caller.userId });
  };

  const unpublish = async (db: D1Database, bucket: R2Bucket, caller: Caller, name: string): Promise<Response> => {
    const target = await writeTarget(db, caller.userId, name, true);
    if (target instanceof Response) return target;
    if (target === null) {
      // An artifact published before a row carried its type has bytes and no row, and unpublishing
      // it is still deleting what the address serves.
      const legacy = await bucket.head(fileKey(caller.userId, name, 0, ""));
      if (legacy === null) return error(404, `no artifact named ${name}`);
      await bucket.delete(legacy.key);
      return new Response(null, { status: 204 });
    }
    await deleteArtifactRow(db, target.ownerUserId, name);
    await deleteArtifactFiles(bucket, target.ownerUserId, name);
    return new Response(null, { status: 204 });
  };

  const artifactsListing = async (url: URL, db: D1Database, host: ArtifactHost, userId: string): Promise<Response> => {
    const chosen = sortInForce(url, ARTIFACT_SORTS);
    const input = parseArtifactList(url.searchParams, chosen.sort);
    if (!input.ok) return error(400, input.error);
    const cursor = decodeCursor(input.value.cursor, artifactCursorDirection(input.value.sort));
    if (!cursor) return error(400, "cursor is malformed; pass the nextCursor of a previous page");
    const shelf = await shelfFor(db, host, userId, input.value, cursor);
    return json({
      artifacts: shelf.artifacts,
      nextCursor: shelf.nextCursor,
      total: shelf.counts.total,
      cut: shelf.cut,
    });
  };

  const artifacts = async (
    request: Request,
    url: URL,
    db: D1Database,
    caller: Caller,
    rawName: string | undefined,
    subpath: string,
  ): Promise<Response> => {
    const host = deps.artifactHost;
    if (host === null) {
      return error(404, "this recall publishes no artifacts; its deployment names no artifact hostname");
    }
    const { bucket } = host;
    const { userId } = caller;
    if (rawName === undefined) {
      if (request.method !== "GET") return error(405, "method not allowed");
      return artifactsListing(url, db, host, userId);
    }
    // An artifact answers a PUT, a GET and a DELETE and never a POST, so the adopt cannot be
    // shadowed by an artifact named adopt.
    if (rawName === "adopt" && subpath === "" && request.method === "POST") {
      return json({ adopted: await adoptArtifacts(db, bucket, userId) });
    }
    const name = parseName(decodeSegment(rawName) ?? "");
    if (!name.ok) return error(400, name.error);
    if (subpath !== "") {
      if (request.method !== "GET") return error(405, "method not allowed");
      const record = await resolveArtifact(db, userId, name.value);
      const lost = (): Response => error(404, `no file ${subpath} in artifact ${name.value}`);
      if (record === null) return lost();
      return artifactFile(request, bucket, record, subpath, lost);
    }
    if (request.method === "PUT") return publish(request, url, db, host, caller, name.value);
    if (request.method === "DELETE") return unpublish(db, bucket, caller, name.value);
    if (request.method !== "GET") return error(405, "method not allowed");
    // The same artifact a read of one of its files names, so a shared artifact never answers its
    // files over the API while refusing to say anything about itself.
    const record = await resolveArtifact(db, userId, name.value);
    if (record === null) return error(404, `no artifact named ${name.value}`);
    return json({ artifact: viewOf(host, record) });
  };

  const list = async (url: URL, db: D1Database, userId: string): Promise<Response> => {
    const input = parseList(url.searchParams, sortInForce(url, MEMORY_SORTS).sort);
    if (!input.ok) return error(400, input.error);
    const cursor = decodeCursor(input.value.cursor, memoryCursorDirection(input.value.sort));
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
    if (url.pathname === TRANSCRIPT_SCRIPT_PATH) return transcriptScript();
    if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
      return dashboard(request, url, env);
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
    const [version, collection, rawName, ...rest] = url.pathname.split("/").filter((part) => part !== "");
    if (version !== "v1") return error(404, "not found");
    const subresource = rest[0];
    // An artifact's files are addressed by a path of up to three segments, so the tail below the
    // name belongs to the collection rather than to the router.
    if (rest.length > 0 && collection !== "sessions" && collection !== "artifacts") return error(404, "not found");
    if (rest.length > 1 && collection !== "artifacts") return error(404, "not found");
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
    if (collection === "artifacts") return artifacts(request, url, env.DB, caller, rawName, rest.join("/"));
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
    async consume(env: AppEnv, delivered: readonly Delivered[]): Promise<void> {
      const landed: Chunk[] = [];
      const sessions = new Map<string, { chunk: Chunk; messages: Delivered[] }>();
      for (const message of delivered) {
        const event = isRecord(message.body) && isRecord(message.body.object) ? message.body.object : {};
        const { key, size } = event;
        const chunk = typeof key === "string" && typeof size === "number" ? parseChunkKey(key, size) : null;
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
      if (landed.length === 0) return;
      const cached = landed.flatMap((chunk) => cacheChunk(env.DB, chunk));
      if (cached.length > 0) await env.DB.batch(cached);
      for (const { chunk, messages } of sessions.values()) {
        const caughtUp = await indexSession(env, chunk.userId, chunk.sessionId).catch((failure: unknown) => {
          console.error(
            JSON.stringify({
              error: failure instanceof Error ? failure.message : String(failure),
              indexing: chunk.sessionId,
              stack: failure instanceof Error ? failure.stack : "",
            }),
          );
          return false;
        });
        if (!caughtUp) for (const message of messages) message.retry();
      }
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

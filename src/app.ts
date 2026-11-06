import { EMAIL_ONLY, emailOf } from "./access";
import {
  type ArtifactChrome,
  type ArtifactRefusal,
  type Audience,
  artifactNotice,
  documentPage,
  playerPage,
  playerScript,
  RAW_VIEW,
  RENDER_CEILING_BYTES,
  rawDocumentPage,
  type ShareRefusal,
  shareNotice,
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
import { type BoardAddress, type BoardTaker, parsePost } from "./board";
import { chunkTurns } from "./chunks";
import {
  ARTIFACTS_TAB,
  type ArtifactShelf,
  artifactsPage,
  BOARD_TAB,
  type BoardOption,
  type BoardPoster,
  boardPage,
  dashboardNotice,
  FLEET_OPTION,
  type Flash,
  HISTORY_TAB,
  historyPage,
  INSIGHTS_TAB,
  insightsPage,
  LABELS_TAB,
  labelsPage,
  MEMORY_TAB,
  type Minted,
  memoriesPage,
  memoryBodyPage,
  memorySearchPage,
  SESSIONS_PATH,
  type SessionView,
  SHARES_SEGMENT,
  type ShareAsk,
  type ShareFlash,
  type SharePage,
  STATS_TAB,
  sessionPage,
  sessionPath,
  sessionsPage,
  sharesPage,
  sharesPath,
  statsPage,
  TRANSCRIPT_SCRIPT_PATH,
  TRANSCRIPT_SEGMENT,
  type TranscriptPlan,
  tabForPath,
  transcriptScript,
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
import { ARTIFACT_SORTS, CURSOR_PARAM, HISTORY_SORTS, MAX_SEARCH_MATCHES, MEMORY_SORTS, sortInForce } from "./listing";
import {
  DEVICE_HEADER,
  MAX_BODY_BYTES,
  type Mailbox,
  ORDERS_HEADER,
  parseSend,
  type Sender,
  type SendInput,
} from "./mailbox";
import { render } from "./markdown";
import { MCP_PATH, mcpEndpoint, mcpRefusal, type RunTool, type ToolCall, type ToolResult } from "./mcp";
import {
  DAY_MS,
  DEFAULT_MIN_SCORE,
  dayWindow,
  type Embedder,
  FRESH_WINDOW_MS,
  fail,
  isRecord,
  type Live,
  type MemoryHit,
  type MemoryType,
  type Parsed,
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
  parseStretchName,
  parseStretchSpan,
  parseTranscriptFile,
  parseUsage,
  type SaveInput,
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
  ARTIFACT_CSP,
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
  ARTIFACT_PREFIX,
  FILE_SEGMENT,
  hashShareToken,
  MAX_EMAIL_SHARES,
  newShareId,
  newShareToken,
  PLAYER_SEGMENT,
  parseShareAddress,
  SHARE_EMAIL_PREFIX,
  SHARE_LINK_PREFIX,
  SHARE_WINDOW_MS,
  type ShareMode,
  type ShareRecord,
  type ShareView,
} from "./shares";
import {
  type ArtifactCounts,
  accountReadableElsewhere,
  adoptArtifacts,
  artifactCounts,
  artifactCursorDirection,
  artifactShares,
  type ChunkCandidate,
  type ChunkMatch,
  type Cursor,
  chunkExcerpts,
  chunkMatches,
  chunkVectors,
  claimBoardMessages,
  claimRevision,
  countedFiles,
  createArtifact,
  createEmailShare,
  createLinkShare,
  decodeCursor,
  deleteArtifactWithShares,
  deleteDeadEmailShare,
  deleteExpiredShare,
  deleteMemory,
  describeMemories,
  describeSessions,
  endSession,
  extendLinkShare,
  findSession,
  getArtifact,
  getMemory,
  historyCursorDirection,
  type IndexedChunk,
  type IndexMark,
  indexMark,
  labelTargets,
  listArtifactPage,
  listBoard,
  listMemories,
  listSessionHistory,
  listSessionHistoryIds,
  listSessions,
  liveSessionDevice,
  liveTally,
  memoryCounts,
  memoryCursorDirection,
  nameSession,
  postBoardMessage,
  putSession,
  type RevokeScope,
  readInsights,
  readLabels,
  readStats,
  recall,
  recordShareUse,
  recordUsage,
  replaceArtifact,
  replaceLinkShare,
  resolveArtifact,
  revokeShares,
  saveMemory,
  searchArtifacts,
  searchSessionHistory,
  sessionHistoryFilters,
  sessionOnDevice,
  sessionOnRecord,
  sessionSpend,
  shareById,
  shareByToken,
  shareCount,
  shareCountsFor,
  sharesFor,
  startCursor,
  textCandidates,
  vectorCandidates,
  writeChunks,
  writeLabels,
} from "./store";
import {
  editedMemory,
  parseEditArgs,
  parseListArgs,
  parseNameArgs,
  parseSaveArgs,
  parseSearchArgs,
  parseSendArgs,
  renderMemory,
  resolveTarget,
  SEARCH_LIMIT,
  TOOLS,
  toolArguments,
} from "./tools";
import type { Reach } from "./transcript-plan";
import {
  appendStretch,
  archivedBytes,
  archivedFiles,
  archivedSince,
  archivedTranscript,
  cacheChunk,
  legacyStretchName,
  MAIN_FILE,
  MAX_CHUNK_BYTES,
  parseChunkKey,
  putStretch,
  readChunk,
  readStretch,
  readTranscript,
  type Stretched,
} from "./transcripts";
import { agentName, readTurns } from "./turns";

export interface ArtifactHost {
  hostname: string;
  verify: Verify;
  bucket: R2Bucket;
  // Where an artifact page's footer points. The artifact hostname answers artifacts and nothing
  // else, so the dashboard is a second host and this is the only place its address is known.
  dashboard: string;
  // One binding gates both share modes. `verify` is bound to the email share application's
  // audience and no other, so an assertion minted for the host's own application opens no share;
  // the link lane mints no assertion at all and its credential is the token in the address.
  sharing: { verify: Verify } | null;
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

// How many board messages one page of the listing holds, for the dashboard and `recall board`
// alike. The window is a week, so a board a fleet actually works from fits in one or two.
const BOARD_PAGE = 50;

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

// Every artifact address begins with the artifact prefix, which is the one place that address is
// built and the reason a name can never collide with a route on that hostname.
const artifactBase = (name: string): string => `${ARTIFACT_PREFIX}/${encodeURIComponent(name)}`;

const viewOf = (host: ArtifactHost, record: ArtifactRecord, shares: number): ArtifactView => ({
  name: record.name,
  url: `https://${host.hostname}${artifactBase(record.name)}`,
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
  shareCount: shares,
});

// What crosses to a page and to the CLI. A link share carries no address field, so neither can
// print one for it by accident, and the token's hash never leaves storage.
const shareViewOf = (share: ShareRecord): ShareView =>
  share.mode === "link"
    ? {
        mode: "link",
        shareId: share.shareId,
        name: share.name,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        lastUsedAt: share.lastUsedAt,
        uses: share.uses,
      }
    : {
        mode: "email",
        shareId: share.shareId,
        name: share.name,
        address: share.subject,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        lastUsedAt: share.lastUsedAt,
        uses: share.uses,
      };

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
    env: AppEnv,
    caller: Caller,
    deviceId: string | undefined,
  ): Promise<Response> => {
    const db = env.DB;
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
    await mailboxFor(env, caller.userId).revoke(target);
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
  // a second behind the archive. An append is one read and one write and claims nothing: the read
  // says how far into the file the archive reaches, the write lands only where the stretch begins
  // exactly there, and how far the archive reaches afterwards is the stretch's own end. A writer
  // beaten to the place is told the reach and carries on from it.
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
    const tooLarge = error(413, `a transcript stretch must hold at most ${MAX_CHUNK_BYTES} bytes`);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_CHUNK_BYTES) return tooLarge;
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_CHUNK_BYTES) return tooLarge;
    const span = parseStretchSpan(url.searchParams);
    if (!span.ok) return error(400, span.error);
    const asked = span.value;
    // A host that named the span of the file its stretch accounts for is answered in places in
    // that file; one that named an archive offset is answered in those. So the deploy that takes
    // the span strands no host that has yet to learn to send one.
    if (asked.kind === "source") {
      if (body.byteLength === 0) return json({ file: file.value, through: asked.from });
      const landed = await appendStretch(
        env.TRANSCRIPTS,
        caller.userId,
        sessionId,
        file.value,
        asked.from,
        asked.through,
        body,
      );
      if (landed.kind === "written") return json({ file: file.value, through: landed.through });
      return json(
        {
          error: `the archive of ${file.value} reaches ${landed.through} bytes into the file; send the stretch starting there`,
          through: landed.through,
        },
        409,
      );
    }
    if (body.byteLength === 0) return json({ file: file.value, offset: asked.from });
    if (await putStretch(env.TRANSCRIPTS, caller.userId, sessionId, file.value, legacyStretchName(asked.from), body)) {
      return json({ file: file.value, offset: asked.from + body.byteLength });
    }
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
    return json(await mailboxFor(env, caller.userId).publish(input.value, sender, now), 201);
  };

  // The board, which is the bus's opposite. A message posted here is held until a session picks it
  // up, and the address is the one `recall send` already resolves: the fleet, a host, or a session.
  const board = async (
    request: Request,
    url: URL,
    env: AppEnv,
    caller: Caller,
    segment: string | undefined,
  ): Promise<Response> => {
    if (segment === "pickup") {
      return request.method === "POST" ? pickUpBoard(request, env, caller) : error(405, "method not allowed");
    }
    if (segment !== undefined) return error(404, "not found");
    if (request.method === "GET") return readBoard(url, env.DB, caller.userId);
    return request.method === "POST" ? postToBoard(request, env, caller) : error(405, "method not allowed");
  };

  const readBoard = async (url: URL, db: D1Database, userId: string): Promise<Response> => {
    const cursor = decodeCursor(url.searchParams.get("cursor") ?? "", "desc");
    if (cursor === null) return error(400, "cursor must be one this listing issued");
    return json(await listBoard(db, userId, BOARD_PAGE, cursor, deps.now()));
  };

  // A post names an address the account holds, and is refused outright where it does not: a message
  // waiting on a device or a session that is not this account's would sit on the board for a week
  // with nobody who could ever take it.
  const addressFor = async (
    db: D1Database,
    userId: string,
    address: BoardAddress,
  ): Promise<BoardAddress | Response> => {
    if (address.scope === "host" && !(await hasDevice(db, userId, address.target))) {
      return error(404, `no device ${address.target}`);
    }
    if (address.scope === "session" && !(await sessionOnRecord(db, userId, address.target))) {
      return error(404, `no session ${address.target}`);
    }
    return address;
  };

  const postToBoard = async (request: Request, env: AppEnv, caller: Caller): Promise<Response> => {
    const input = parsePost(await readJson(request), caller.userId);
    if (!input.ok) return error(400, input.error);
    if (new TextEncoder().encode(input.value.body).byteLength > MAX_BODY_BYTES) {
      return error(413, `body must hold at most ${MAX_BODY_BYTES} bytes`);
    }
    const now = deps.now();
    const address = await addressFor(env.DB, caller.userId, input.value.address);
    if (address instanceof Response) return address;
    const from = await senderOf(env.DB, caller, input.value.fromSessionId, now);
    return json(
      await postBoardMessage(env.DB, {
        userId: caller.userId,
        messageId: crypto.randomUUID(),
        address,
        fromDeviceId: from.deviceId,
        fromHost: from.host,
        fromName: from.name,
        body: input.value.body,
        createdAt: now,
      }),
      201,
    );
  };

  // The caller names the session taking the messages, and the claim is what settles whether that
  // session is the caller's: a session-addressed message is only taken from the device that session
  // runs on. The check lives in the claim rather than here because a session the hook has not
  // synced yet must leave its message waiting instead of having the pickup refused.
  const pickUpBoard = async (request: Request, env: AppEnv, caller: Caller): Promise<Response> => {
    const body = await readJson(request);
    const asked = isRecord(body) ? body.sessionId : undefined;
    if (typeof asked !== "string") return error(400, "sessionId must be the id of the session taking the messages");
    const sessionId = parseSessionId(asked);
    if (!sessionId.ok) return error(400, sessionId.error);
    const now = deps.now();
    const taker: BoardTaker = {
      sessionId: sessionId.value,
      deviceId: caller.deviceId,
      host: caller.host,
      pickedUpAt: now,
    };
    return json({ messages: await claimBoardMessages(env.DB, caller.userId, taker, now) });
  };

  const listen = (request: Request, env: AppEnv, caller: Caller): Promise<Response> => {
    const upgrade = new Request(request.url, {
      headers: {
        upgrade: "websocket",
        [DEVICE_HEADER]: caller.deviceId,
        [ORDERS_HEADER]: request.headers.get(ORDERS_HEADER) ?? "",
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

  // One file of one artifact, streamed. The request's own headers are handed to R2, so the slice is
  // R2's to compute and a seek in a long track never waits for the bytes before it. The manifest
  // names the content type, and a path the manifest does not name is a 404 whoever asks.
  // A file carries the policy a site's page does, because a document may hold HTML or SVG of its
  // publisher's and an address under a name is navigated to as readily as the name itself.
  // `sandbox` binds the document a navigation makes, and a subresource the player or a rendered
  // document asks for is fetched under the asking page's policy, so a track still plays and a
  // range still answers.
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
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
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
  const documentView = async (
    url: URL,
    host: ArtifactHost,
    record: ArtifactRecord,
    chrome: ArtifactChrome,
  ): Promise<Response> => {
    const entry = record.files[0];
    if (entry === undefined) throw new Error(`artifact ${record.name} names no file`);
    if (url.searchParams.get("view") === RAW_VIEW) {
      const source = await entryHead(host.bucket, record, RAW_INLINE_BYTES);
      return rawDocumentPage(record, chrome, source, entry.bytes > RAW_INLINE_BYTES);
    }
    if (entry.bytes > RENDER_CEILING_BYTES) {
      return new Response(null, {
        status: 302,
        headers: { location: `${chrome.base}?view=${RAW_VIEW}`, "cache-control": "no-store" },
      });
    }
    const source = await (await entryBody(host.bucket, record)).text();
    return documentPage(record, chrome, render(source, chrome.base));
  };

  // The player, with every entry the manifest names checked against storage as the page is drawn:
  // a track whose file is gone keeps its row and its mark rather than failing silently when a
  // reader presses play.
  const playerView = async (host: ArtifactHost, record: ArtifactRecord, chrome: ArtifactChrome): Promise<Response> => {
    const held = await Promise.all(
      record.files.map((file) => headArtifactFile(host.bucket, record.ownerUserId, record.name, record.rev, file.path)),
    );
    const missing = record.files.filter((_file, index) => held[index] === null).map((file) => file.path);
    return playerPage(record, chrome, missing);
  };

  // Which of the three routes under a base the tail names. An empty tail and one empty segment are
  // both the page, because recipients copy addresses with a trailing slash; the script answers
  // directly under the base and a file under the file segment, so no file path and no name can
  // reach either position.
  type UnderBase = { kind: "page" } | { kind: "script" } | { kind: "file"; path: string } | { kind: "elsewhere" };

  const underBase = (tail: readonly string[]): UnderBase => {
    if (tail.length === 0 || (tail.length === 1 && tail[0] === "")) return { kind: "page" };
    if (tail.length === 1 && tail[0] === PLAYER_SEGMENT) return { kind: "script" };
    if (tail.length > 1 && tail[0] === FILE_SEGMENT) return { kind: "file", path: tail.slice(1).join("/") };
    return { kind: "elsewhere" };
  };

  // The one place a record is turned into a page. The chrome says what address space the page sits
  // in and who is reading it, and every address the page draws is built from its base, which is
  // what keeps a shared page inside its share without a check anywhere.
  const artifactView = (
    request: Request,
    url: URL,
    host: ArtifactHost,
    record: ArtifactRecord,
    chrome: ArtifactChrome,
    route: UnderBase,
    lost: () => Response,
  ): Promise<Response> | Response => {
    if (route.kind === "elsewhere") return lost();
    if (route.kind === "script") return playerScript();
    if (route.kind === "file") return artifactFile(request, host.bucket, record, route.path, lost);
    if (record.type === "document") return documentView(url, host, record, chrome);
    if (record.type === "audio") return playerView(host, record, chrome);
    return entryBody(host.bucket, record).then((object) => artifactPage(object.body));
  };

  // An artifact published before a row carried its type. Its bytes are at the bare key and no row
  // names them, so the address keeps working and the tab lists it once the operator adopts it.
  const legacySite = async (host: ArtifactHost, userId: string, name: string): Promise<Response | null> => {
    const object = await host.bucket.get(fileKey(userId, name, 0, ""));
    return object === null ? null : artifactPage(object.body);
  };

  // Who the reader is, which is what the band draws and what decides whether the share count is
  // read at all. The bar is the artifact's owner's, on recall's own page for a document or an
  // audio artifact, in a deployment that has turned sharing on; everything else is an account
  // reading somebody's artifact and gets an empty slot.
  const audienceFor = async (
    db: D1Database,
    host: ArtifactHost,
    record: ArtifactRecord,
    userId: string,
    now: number,
  ): Promise<Audience> => {
    const owned = host.sharing !== null && record.ownerUserId === userId;
    if (!owned || (record.type !== "document" && record.type !== "audio")) {
      return { kind: "account", dashboard: host.dashboard };
    }
    return {
      kind: "owner",
      shares: await shareCount(db, userId, record.name, now),
      sharesUrl: new URL(sharesPath(record.name), host.dashboard).toString(),
      dashboard: host.dashboard,
    };
  };

  const artifactSite = async (request: Request, url: URL, db: D1Database, host: ArtifactHost): Promise<Response> => {
    const notice = (refusal: ArtifactRefusal): Response => artifactNotice(refusal, host.dashboard);
    const lost = (): Response => notice({ kind: "lost" });
    if (request.method !== "GET") return notice({ kind: "method" });
    const address = `${url.pathname}${url.search}`;
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) {
      return notice({ kind: "unauthorized", reason: "this host saw no sign-in at all", address });
    }
    const verified = await host.verify(assertion);
    if (!verified.ok) return notice({ kind: "unauthorized", reason: verified.reason, address });
    const email = emailOf(verified.principal);
    if (email === null) return notice({ kind: "unauthorized", reason: EMAIL_ONLY, address });
    const userId = await userForEmail(db, email);
    if (userId === null) return notice({ kind: "forbidden", email });
    // Every artifact address begins with the artifact prefix, so no name occupies the hostname's
    // first segment and no path a publisher controls can name a route.
    const [prefix, rawName, ...tail] = url.pathname.slice(1).split("/");
    if (prefix !== ARTIFACT_PREFIX.slice(1) || rawName === undefined) return lost();
    const name = parseName(decodeSegment(rawName) ?? "");
    if (!name.ok) return lost();
    const route = underBase(tail);
    if (route.kind === "elsewhere") return lost();
    const record = await resolveArtifact(db, userId, name.value);
    if (record === null) {
      return route.kind === "page" ? ((await legacySite(host, userId, name.value)) ?? lost()) : lost();
    }
    const audience = await audienceFor(db, host, record, userId, deps.now());
    return artifactView(request, url, host, record, { base: artifactBase(name.value), audience }, route, lost);
  };

  const SHARE_PREFIXES: ReadonlyArray<readonly [ShareMode, string]> = [
    ["link", SHARE_LINK_PREFIX],
    ["email", SHARE_EMAIL_PREFIX],
  ];

  const underSharePrefix = (pathname: string): boolean =>
    SHARE_PREFIXES.some(([, prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  // Which share lane an address sits in, and the credential it carries. A prefix with nothing
  // under it carries no credential at all and answers the share's own 404.
  const shareLane = (
    pathname: string,
  ): { mode: ShareMode; base: string; credential: string; tail: string[] } | null => {
    for (const [mode, prefix] of SHARE_PREFIXES) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
      const [credential, ...tail] = pathname.slice(prefix.length + 1).split("/");
      if (credential === undefined || credential === "") return null;
      return { mode, base: `${prefix}/${credential}`, credential, tail };
    }
    return null;
  };

  // Cloudflare serves the logout at the edge and the Worker never sees it. It is host-wide, so the
  // copy beside the control says so; there is no prefix-scoped logout to ask for.
  const signInAgainAt = (url: URL): string =>
    `https://${url.hostname}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(url.toString())}`;

  // The share a credential resolves to, or the refusal a recipient sees instead. Every dead end is
  // the same 404, because a page that told an unknown token from a revoked one would tell its
  // holder the artifact exists. An unknown credential costs one read and no write.
  const shareFor = async (
    request: Request,
    url: URL,
    db: D1Database,
    sharing: { verify: Verify },
    lane: { mode: ShareMode; credential: string },
    now: number,
  ): Promise<{ ok: true; share: ShareRecord } | { ok: false; refusal: ShareRefusal }> => {
    const gone = { ok: false as const, refusal: { kind: "gone" as const } };
    const live = async (share: ShareRecord | null): Promise<ShareRecord | null> => {
      if (share === null) return null;
      if (share.expiresAt > now) return share;
      await deleteExpiredShare(db, share.shareId, now);
      return null;
    };
    if (lane.mode === "link") {
      const share = await live(await shareByToken(db, await hashShareToken(lane.credential)));
      return share === null ? gone : { ok: true, share };
    }
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) return gone;
    const verified = await sharing.verify(assertion);
    if (!verified.ok) return gone;
    const share = await live(await shareById(db, lane.credential));
    if (share === null) return gone;
    // The proven address and the one the share names, compared and neither printed: one is on the
    // reader's own screen and naming the other would say who the artifact was shared with.
    if (share.subject !== emailOf(verified.principal)) {
      return { ok: false, refusal: { kind: "elsewhere", signInAgain: signInAgainAt(url) } };
    }
    return { ok: true, share };
  };

  // Both share lanes, which differ only in how a credential is proven. From the artifact row on
  // they are one path: a share names its owner and the row is read directly rather than through
  // the account-readable fallback, so a share can never reach another account's artifact of the
  // same name.
  const sharedSite = async (request: Request, url: URL, db: D1Database, host: ArtifactHost): Promise<Response> => {
    const gone = (): Response => shareNotice({ kind: "gone" });
    if (request.method !== "GET") return shareNotice({ kind: "method" });
    const { sharing } = host;
    if (sharing === null) return gone();
    const lane = shareLane(url.pathname);
    if (lane === null) return gone();
    const route = underBase(lane.tail);
    if (route.kind === "elsewhere") return gone();
    const now = deps.now();
    const resolved = await shareFor(request, url, db, sharing, lane, now);
    if (!resolved.ok) return shareNotice(resolved.refusal);
    const { share } = resolved;
    const record = await getArtifact(db, share.userId, share.name);
    if (record === null) return gone();
    const chrome: ArtifactChrome = {
      base: lane.base,
      audience: { kind: "recipient", expiresAt: share.expiresAt },
    };
    if (route.kind === "page") await recordShareUse(db, share.shareId, now);
    return artifactView(request, url, host, record, chrome, route, gone);
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
    const shareName = sharedArtifactName(url.pathname);
    const saving = request.method === "POST" && tab?.path === LABELS_TAB.path;
    const posting = request.method === "POST" && tab?.path === BOARD_TAB.path;
    const sending = request.method === "POST" && segments.length === 1;
    const sharing = request.method === "POST" && shareName !== null;
    if (request.method !== "GET" && !saving && !posting && !sending && !sharing) {
      return lost(
        405,
        "Not allowed",
        "The dashboard only answers a GET, the Labels and Board tabs their own POST, an artifact's share page its own POST, and a session page the message it sends.",
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
    if (shareName !== null) {
      return request.method === "POST"
        ? sharesPost(request, url, db, userId, email, live, shareName, now, lost)
        : sharesTab(request, url, db, userId, email, live, shareName, now, lost);
    }
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
    if (tab.path === BOARD_TAB.path) return boardTab(request, url, db, userId, email, live, now);
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

  // The artifact a share page is about, as the address holds it, and null where the address is no
  // share page at all. The segment is not decoded here: a state drawn for no artifact echoes the
  // address unrewritten, which is the page's to do.
  const sharedArtifactName = (pathname: string): string | null => {
    const segments = pathname.replace(/\/$/, "").split("/");
    if (segments.length !== 5 || segments[4] !== SHARES_SEGMENT) return null;
    return `/${segments[1]}/${segments[2]}` === ARTIFACTS_TAB.path ? (segments[3] ?? null) : null;
  };

  // The whole address a share answers on, built in one place. For a link it exists on the one
  // response that mints it and nowhere else, because storage holds only the token's hash.
  const shareAddress = (host: ArtifactHost, mode: ShareMode, credential: string): string =>
    `https://${host.hostname}${mode === "link" ? SHARE_LINK_PREFIX : SHARE_EMAIL_PREFIX}/${credential}`;

  const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

  const GONE_FLASH: ShareFlash = { tone: "refused", text: "That share is already gone." };

  const UNTRUSTED_FLASH: ShareFlash = {
    tone: "refused",
    text: "This form did not come from this page, so nothing was created, extended or revoked; reload the page and try again.",
  };

  // Where a row the mutation just wrote belongs in the list the page already read: the link first,
  // then the addresses oldest first, which is the order the index supplies. The list is rebuilt
  // rather than read again, so a POST costs the page's two reads and its one write and no more.
  const sameSubject = (left: ShareView, right: ShareView): boolean => {
    if (left.shareId === right.shareId) return true;
    if (left.mode === "link" && right.mode === "link") return true;
    return left.mode === "email" && right.mode === "email" && left.address === right.address;
  };

  const relisted = (shares: readonly ShareView[], written: ShareView): ShareView[] => {
    const others = shares.filter((one) => !sameSubject(one, written));
    const link = written.mode === "link" ? written : others.find((one) => one.mode === "link");
    const addresses = [...(written.mode === "email" ? [written] : []), ...others.filter((one) => one.mode === "email")];
    addresses.sort((left, right) => left.createdAt - right.createdAt);
    return [...(link === undefined ? [] : [link]), ...addresses];
  };

  // The artifact a share page draws, or the state it draws instead of one, off one read. A name
  // this account does not own answers the 403 the API answers, and a name it holds no artifact
  // under is the dashboard's own notice; a private artifact of another account resolves to
  // neither, so the reader learns nothing about it.
  const shareTarget = async (
    db: D1Database,
    url: URL,
    userId: string,
    email: string,
    live: Live,
    rawName: string,
    lost: Refusal,
  ): Promise<ArtifactRecord | Response> => {
    const name = parseName(decodeSegment(rawName) ?? "");
    const record = name.ok ? await resolveArtifact(db, userId, name.value) : null;
    if (record === null) {
      return lost(404, "No such artifact", "This recall publishes no artifact under this name.");
    }
    if (record.ownerUserId !== userId) return sharesPage(email, live, url, { kind: "foreign" });
    return record;
  };

  // The question the query asks, against the shares the page holds. An id naming no live share is
  // not a question at all: the page says so and lists what remains.
  const askFor = (url: URL, shares: readonly ShareView[]): { ask: ShareAsk | null; flash: ShareFlash | null } => {
    if (url.searchParams.get("relink") === "1") {
      return shares.some((share) => share.mode === "link")
        ? { ask: { kind: "relink" }, flash: null }
        : { ask: null, flash: GONE_FLASH };
    }
    const revoke = url.searchParams.get("revoke");
    if (revoke === null) return { ask: null, flash: null };
    if (revoke === "all") {
      return shares.length === 0
        ? { ask: null, flash: GONE_FLASH }
        : { ask: { kind: "revoke-all", count: shares.length }, flash: null };
    }
    const share = shares.find((one) => one.shareId === revoke);
    return share === undefined ? { ask: null, flash: GONE_FLASH } : { ask: { kind: "revoke", share }, flash: null };
  };

  interface ShareState {
    shares: ShareView[];
    flash: ShareFlash | null;
    minted: Minted | null;
    ask: ShareAsk | null;
    emailDraft: string;
  }

  const sharePageOf = (
    host: ArtifactHost,
    record: ArtifactRecord,
    state: ShareState,
    csrf: string,
    now: number,
  ): SharePage => ({
    artifact: viewOf(host, record, state.shares.length),
    shares: state.shares,
    csrf,
    flash: state.flash,
    minted: state.minted,
    ask: state.ask,
    emailDraft: state.emailDraft,
    emailFull: state.shares.filter((share) => share.mode === "email").length >= MAX_EMAIL_SHARES,
    now,
  });

  const sharesTab = async (
    request: Request,
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    rawName: string,
    now: number,
    lost: Refusal,
  ): Promise<Response> => {
    const host = deps.artifactHost;
    if (host === null || host.sharing === null) return sharesPage(email, live, url, { kind: "off" });
    const target = await shareTarget(db, url, userId, email, live, rawName, lost);
    if (target instanceof Response) return target;
    const shares = (await artifactShares(db, userId, target.name, now)).map(shareViewOf);
    const { ask, flash } = askFor(url, shares);
    const state: ShareState = { shares, flash, minted: null, ask, emailDraft: "" };
    const page = sharePageOf(host, target, state, pageToken(request), now);
    return sharesPage(email, live, url, { kind: "page", page });
  };

  // Every mutation the page posts, each one write against the artifact's own shares. Nothing is a
  // redirect: the response carries the page, because a minted address exists on that one response
  // and nowhere else.
  const shareMutation = async (
    db: D1Database,
    host: ArtifactHost,
    record: ArtifactRecord,
    shares: ShareView[],
    form: URLSearchParams,
    now: number,
  ): Promise<ShareState> => {
    const { ownerUserId: userId, name } = record;
    const expiresAt = now + SHARE_WINDOW_MS;
    const kept = (extra: Partial<ShareState>): ShareState => ({
      shares,
      flash: null,
      minted: null,
      ask: null,
      emailDraft: "",
      ...extra,
    });
    const mintedLink = async (replacing: boolean): Promise<ShareState> => {
      const token = newShareToken();
      const input = { shareId: newShareId(), userId, name, subject: await hashShareToken(token), at: now, expiresAt };
      const made = replacing ? await replaceLinkShare(db, input) : await createLinkShare(db, input);
      // A live link refused the write, which is the one reload worth catching: the page asks
      // whether to retire the address already in use rather than minting a second one.
      if (made === null) return kept({ ask: { kind: "relink" } });
      return kept({
        shares: relisted(shares, shareViewOf(made)),
        minted: { mode: "link", address: shareAddress(host, "link", token), expiresAt: made.expiresAt },
      });
    };
    const todo = form.get("do") ?? "";
    if (todo === "email") {
      const typed = form.get("address") ?? "";
      const address = parseShareAddress(typed);
      if (!address.ok) return kept({ flash: { tone: "refused", text: address.error }, emailDraft: typed });
      const addresses = shares.filter((share) => share.mode === "email");
      const renewing = addresses.some((share) => share.mode === "email" && share.address === address.value);
      if (!renewing && addresses.length >= MAX_EMAIL_SHARES) {
        return kept({
          flash: {
            tone: "refused",
            text: `${name} holds ${MAX_EMAIL_SHARES} email shares, the most one artifact takes, so ${address.value} was not shared.`,
          },
          emailDraft: typed,
        });
      }
      await deleteDeadEmailShare(db, userId, name, address.value, now);
      const made = await createEmailShare(db, {
        shareId: newShareId(),
        userId,
        name,
        subject: address.value,
        at: now,
        expiresAt,
      });
      return kept({
        shares: relisted(shares, shareViewOf(made.share)),
        flash: made.renewed
          ? { tone: "done", text: `${address.value} already held a share, so its expiry moved instead.` }
          : null,
        minted: {
          mode: "email",
          address: shareAddress(host, "email", made.share.shareId),
          recipient: address.value,
          expiresAt: made.share.expiresAt,
        },
      });
    }
    if (todo === "link") return mintedLink(false);
    if (todo === "relink") return mintedLink(true);
    if (todo === "extend") {
      const extended = await extendLinkShare(db, userId, name, now, expiresAt);
      if (extended === null) return kept({ flash: GONE_FLASH });
      return kept({
        shares: relisted(shares, shareViewOf(extended)),
        flash: { tone: "done", text: `The link share now stops working on ${dayOf(extended.expiresAt)}.` },
      });
    }
    if (todo === "revoke") {
      const shareId = form.get("share") ?? "";
      const going = shares.find((share) => share.shareId === shareId);
      if (going === undefined) return kept({ flash: GONE_FLASH });
      const revoked = await revokeShares(db, userId, name, { kind: "one", shareId });
      if (revoked === 0) return kept({ flash: GONE_FLASH });
      return kept({
        shares: shares.filter((share) => share.shareId !== shareId),
        flash: {
          tone: "done",
          text: going.mode === "link" ? "The link share is revoked." : `The share with ${going.address} is revoked.`,
        },
      });
    }
    if (todo === "revoke-all") {
      const revoked = await revokeShares(db, userId, name, { kind: "all" });
      return kept({
        shares: [],
        flash: revoked === 0 ? GONE_FLASH : { tone: "done", text: `Every share on ${name} is revoked.` },
      });
    }
    return kept({});
  };

  const sharesPost = async (
    request: Request,
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    rawName: string,
    now: number,
    lost: Refusal,
  ): Promise<Response> => {
    const host = deps.artifactHost;
    if (host === null || host.sharing === null) return sharesPage(email, live, url, { kind: "off" });
    const posted = await formPost(request, url);
    const target = await shareTarget(db, url, userId, email, live, rawName, lost);
    if (target instanceof Response) return target;
    const shares = (await artifactShares(db, userId, target.name, now)).map(shareViewOf);
    const csrf = pageToken(request);
    // Nothing is created, extended or revoked for a post that did not come from this page, and the
    // refusal says nothing the page does not already draw.
    if (!posted.trusted) {
      const state: ShareState = { shares, flash: UNTRUSTED_FLASH, minted: null, ask: null, emailDraft: "" };
      return sharesPage(email, live, url, { kind: "page", page: sharePageOf(host, target, state, csrf, now) }, 403);
    }
    const state = await shareMutation(db, host, target, shares, posted.form, now);
    return sharesPage(email, live, url, { kind: "page", page: sharePageOf(host, target, state, csrf, now) });
  };

  // The addresses the form offers, which are the pairs the board stores rather than strings a
  // second resolver would have to read: the fleet, every host signed in, and every live session.
  const boardOptions = async (db: D1Database, userId: string, now: number): Promise<BoardOption[]> => {
    const [hosts, live, labels] = await Promise.all([
      listDevices(db, userId),
      listSessions(db, userId, now),
      readLabels(db, userId),
    ]);
    return [
      { value: FLEET_OPTION, label: "The fleet — the first session anywhere that reads it" },
      ...hosts.map((host) => ({
        value: `host:${host.deviceId}`,
        label: `${labels.hosts.get(host.host) ?? host.host} — the first session on that host`,
      })),
      ...live.map((session) => ({ value: `session:${session.sessionId}`, label: `${session.name} — that session` })),
    ];
  };

  const askedAddress = (to: string, userId: string): BoardAddress | null => {
    if (to === FLEET_OPTION) return { scope: "fleet", target: userId };
    const colon = to.indexOf(":");
    if (colon < 1) return null;
    const scope = to.slice(0, colon);
    const target = to.slice(colon + 1);
    if (target === "") return null;
    if (scope === "host") return { scope: "host", target };
    return scope === "session" ? { scope: "session", target } : null;
  };

  const boardTab = async (
    request: Request,
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    live: Live,
    now: number,
  ): Promise<Response> => {
    const csrf = pageToken(request);
    const options = await boardOptions(db, userId, now);
    const render = async (post: BoardPoster, status: number): Promise<Response> => {
      const cursor = pageCursor(url.searchParams.get(CURSOR_PARAM) ?? "", "desc");
      const listed = await listBoard(db, userId, BOARD_PAGE, cursor, now);
      return boardPage(email, live, url, { ...listed, post }, now, status);
    };
    if (request.method === "GET") {
      const posted = readCookie(request.headers.get("cookie"), SENT_COOKIE) === BOARD_TAB.path;
      return render({ csrf, to: FLEET_OPTION, draft: "", flash: posted ? { tone: "posted" } : null, options }, 200);
    }
    return postFromDashboard(request, url, db, userId, email, now, csrf, options, render);
  };

  // The dashboard's own post, which is the Labels tab's post shape pointed at the board. A browser
  // carries no device token, so it cannot reach `POST /v1/board`; what it shares with it is the
  // table. Every refusal re-renders with the typing still in the box and says what went wrong.
  const postFromDashboard = async (
    request: Request,
    url: URL,
    db: D1Database,
    userId: string,
    email: string,
    now: number,
    csrf: string,
    options: BoardOption[],
    render: (post: BoardPoster, status: number) => Promise<Response>,
  ): Promise<Response> => {
    const posted = await formPost(request, url);
    const body = posted.form.get("body") ?? "";
    const to = posted.form.get("to") ?? FLEET_OPTION;
    const refuse = (text: string, status: number): Promise<Response> =>
      render({ csrf, to, draft: body, flash: { tone: "refused", text }, options }, status);
    if (!posted.trusted) {
      return refuse("The form did not come from this page, so nothing was posted. Post it again from here.", 403);
    }
    if (body.trim() === "") return refuse("The message was empty, so nothing was posted.", 400);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return refuse(
        `A message holds at most ${MAX_BODY_BYTES} bytes, and this one is longer. Nothing was posted.`,
        400,
      );
    }
    const asked = askedAddress(to, userId);
    if (asked === null) return refuse("That is not an address this page offers, so nothing was posted.", 400);
    const address = await addressFor(db, userId, asked);
    if (address instanceof Response) {
      return refuse("That host or session is no longer on this account, so nothing was posted.", 400);
    }
    await postBoardMessage(db, {
      userId,
      messageId: crypto.randomUUID(),
      address,
      fromDeviceId: DASHBOARD_DEVICE,
      fromHost: DASHBOARD_DEVICE,
      fromName: email,
      body,
      createdAt: now,
    });
    return new Response(null, {
      status: 303,
      headers: {
        location: BOARD_TAB.path,
        "set-cookie": `${SENT_COOKIE}=${BOARD_TAB.path}; Path=/; Max-Age=30; Secure; HttpOnly; SameSite=Strict`,
      },
    });
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
    const at = parseStretchName(url.searchParams.get("at"));
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
  // origin and CSRF check, then the same publish `POST /v1/messages` makes. A browser carries no
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
    const input: SendInput = { kind: "news", toDeviceId: deviceId, toSessionId: sessionId, fromSessionId: "", body };
    await mailboxFor(env, userId).publish(input, sender, deps.now());
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

  // One page of the shelf's rows and the counts the chips and the heading print. No bytes are read
  // and the bucket is not listed.
  const artifactRows = async (
    db: D1Database,
    userId: string,
    input: ArtifactListInput,
    cursor: Cursor,
  ): Promise<{ artifacts: ArtifactRecord[]; counts: ArtifactCounts; nextCursor: string; cut: boolean }> => {
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
    return { artifacts: page.artifacts, counts, nextCursor: page.nextCursor, cut: page.cut };
  };

  // The shelf, with the third read: the live share counts for the artifacts on this page, grouped
  // by name rather than read per row, so the read is bounded by the page and not by the account.
  // Where sharing is off it does not run at all and every count is zero.
  const shelfFor = async (
    db: D1Database,
    host: ArtifactHost,
    userId: string,
    input: ArtifactListInput,
    cursor: Cursor,
    now: number,
  ): Promise<ArtifactShelf> => {
    const page = await artifactRows(db, userId, input, cursor);
    const counted =
      host.sharing === null
        ? new Map<string, number>()
        : await shareCountsFor(
            db,
            userId,
            page.artifacts.map((record) => record.name),
            now,
          );
    return {
      artifacts: page.artifacts.map((record) => viewOf(host, record, counted.get(record.name) ?? 0)),
      counts: page.counts,
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
    const shelf = await shelfFor(db, host, userId, input.value, cursor, deps.now());
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
    const shares = await sharesHeld(db, host, saved, caller.userId, deps.now());
    return json({ artifact: viewOf(host, saved, shares), ownedByAnother: owner !== caller.userId });
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
    await deleteArtifactWithShares(db, target.ownerUserId, name);
    await deleteArtifactFiles(bucket, target.ownerUserId, name);
    return new Response(null, { status: 204 });
  };

  const artifactsListing = async (
    url: URL,
    db: D1Database,
    host: ArtifactHost,
    userId: string,
    now: number,
  ): Promise<Response> => {
    const chosen = sortInForce(url, ARTIFACT_SORTS);
    const input = parseArtifactList(url.searchParams, chosen.sort);
    if (!input.ok) return error(400, input.error);
    const cursor = decodeCursor(input.value.cursor, artifactCursorDirection(input.value.sort));
    if (!cursor) return error(400, "cursor is malformed; pass the nextCursor of a previous page");
    // One optional param turns the page's third read from the counts into the rows themselves,
    // which is what `recall shares` with no name walks instead of a collection of its own.
    const wanted = url.searchParams.get("shares") === "true" && host.sharing !== null;
    const page = await artifactRows(db, userId, input.value, cursor);
    const names = page.artifacts.map((record) => record.name);
    const held = wanted ? await sharesFor(db, userId, names, now) : new Map<string, ShareRecord[]>();
    const counted =
      wanted || host.sharing === null ? new Map<string, number>() : await shareCountsFor(db, userId, names, now);
    const artifacts = page.artifacts.map((record) => {
      const shares = held.get(record.name) ?? [];
      const view = viewOf(host, record, wanted ? shares.length : (counted.get(record.name) ?? 0));
      return wanted ? { ...view, shares: shares.map(shareViewOf) } : view;
    });
    return json({ artifacts, nextCursor: page.nextCursor, total: page.counts.total, cut: page.cut });
  };

  // How many live shares one artifact holds, read for its owner alone: an account reading somebody
  // else's account-readable artifact learns nothing about who else holds a share on it.
  const sharesHeld = async (
    db: D1Database,
    host: ArtifactHost,
    record: ArtifactRecord,
    userId: string,
    now: number,
  ): Promise<number> => {
    if (host.sharing === null || record.ownerUserId !== userId) return 0;
    return shareCount(db, userId, record.name, now);
  };

  // What a `DELETE` on the collection names, which is exactly one of three. Naming none or more
  // than one is refused by naming the three rather than picking one.
  const revokeSelector = (url: URL): Parsed<RevokeScope> => {
    const asked: RevokeScope[] = [];
    if (url.searchParams.has("link")) asked.push({ kind: "link" });
    if (url.searchParams.has("email")) {
      const address = parseShareAddress(url.searchParams.get("email"));
      if (!address.ok) return address;
      asked.push({ kind: "email", address: address.value });
    }
    if (url.searchParams.get("all") === "true") asked.push({ kind: "all" });
    const [scope] = asked;
    if (asked.length !== 1 || scope === undefined) {
      return fail("a revoke names exactly one of link, email=<address> and all=true");
    }
    return { ok: true, value: scope };
  };

  // The shares of one artifact, nested under the artifact that owns them: a share is meaningless
  // without it, and the ownership check that answers the 403 falls out of the lookup the path
  // already requires.
  const artifactShareRoutes = async (
    request: Request,
    url: URL,
    db: D1Database,
    host: ArtifactHost,
    userId: string,
    name: string,
    rawShareId: string | undefined,
    now: number,
  ): Promise<Response> => {
    if (host.sharing === null) {
      return error(404, "this recall shares no artifacts; its deployment binds no share audience");
    }
    const record = await resolveArtifact(db, userId, name);
    if (record === null) return error(404, `no artifact named ${name}`);
    if (record.ownerUserId !== userId) return error(403, "only an artifact's owner shares it");
    const remaining = async (): Promise<ShareView[]> => (await artifactShares(db, userId, name, now)).map(shareViewOf);
    if (rawShareId !== undefined) {
      if (request.method !== "DELETE") return error(405, "method not allowed");
      const revoked = await revokeShares(db, userId, name, { kind: "one", shareId: rawShareId });
      if (revoked === 0) return error(404, `no share ${rawShareId} on ${name}`);
      return json({ revoked, shares: await remaining() });
    }
    if (request.method === "GET") return json({ shares: await remaining() });
    if (request.method === "DELETE") {
      const scope = revokeSelector(url);
      if (!scope.ok) return error(400, scope.error);
      const revoked = await revokeShares(db, userId, name, scope.value);
      return json({ revoked, shares: await remaining() });
    }
    if (request.method !== "POST") return error(405, "method not allowed");
    const body = await readJson(request);
    if (!isRecord(body)) return error(400, "a share names a mode of link or email");
    const expiresAt = now + SHARE_WINDOW_MS;
    if (body.mode === "link") {
      const shares = await artifactShares(db, userId, name, now);
      const token = newShareToken();
      const share = await replaceLinkShare(db, {
        shareId: newShareId(),
        userId,
        name,
        subject: await hashShareToken(token),
        at: now,
        expiresAt,
      });
      return json({
        share: shareViewOf(share),
        address: shareAddress(host, "link", token),
        replaced: shares.some((one) => one.mode === "link"),
      });
    }
    if (body.mode !== "email") return error(400, "a share names a mode of link or email");
    const address = parseShareAddress(body.address);
    if (!address.ok) return error(400, address.error);
    const shares = await artifactShares(db, userId, name, now);
    const addresses = shares.filter((one) => one.mode === "email");
    if (!addresses.some((one) => one.subject === address.value) && addresses.length >= MAX_EMAIL_SHARES) {
      return error(409, `${name} holds ${MAX_EMAIL_SHARES} email shares, the most one artifact takes`);
    }
    await deleteDeadEmailShare(db, userId, name, address.value, now);
    const made = await createEmailShare(db, {
      shareId: newShareId(),
      userId,
      name,
      subject: address.value,
      at: now,
      expiresAt,
    });
    return json({
      share: shareViewOf(made.share),
      address: shareAddress(host, "email", made.share.shareId),
      renewed: made.renewed,
    });
  };

  const artifacts = async (
    request: Request,
    url: URL,
    db: D1Database,
    caller: Caller,
    rawName: string | undefined,
    rest: readonly string[],
  ): Promise<Response> => {
    const host = deps.artifactHost;
    if (host === null) {
      return error(404, "this recall publishes no artifacts; its deployment names no artifact hostname");
    }
    const { bucket } = host;
    const { userId } = caller;
    const now = deps.now();
    if (rawName === undefined) {
      if (request.method !== "GET") return error(405, "method not allowed");
      return artifactsListing(url, db, host, userId, now);
    }
    // An artifact answers a PUT, a GET and a DELETE and never a POST, so the adopt cannot be
    // shadowed by an artifact named adopt.
    if (rawName === "adopt" && rest.length === 0 && request.method === "POST") {
      return json({ adopted: await adoptArtifacts(db, bucket, userId) });
    }
    const name = parseName(decodeSegment(rawName) ?? "");
    if (!name.ok) return error(400, name.error);
    // Under a name the next segment is a route word and nothing else, which is what frees `shares`
    // beside `files` and is the same rule the artifact hostname holds: no position where a name or
    // a file path meets a route.
    const [word, ...tail] = rest;
    if (word === SHARES_SEGMENT) {
      if (tail.length > 1) return error(404, "not found");
      return artifactShareRoutes(request, url, db, host, userId, name.value, tail[0], now);
    }
    if (word === "files") {
      if (request.method !== "GET") return error(405, "method not allowed");
      const subpath = tail.join("/");
      const lost = (): Response => error(404, `no file ${subpath} in artifact ${name.value}`);
      if (subpath === "") return lost();
      const record = await resolveArtifact(db, userId, name.value);
      if (record === null) return lost();
      return artifactFile(request, bucket, record, subpath, lost);
    }
    if (word !== undefined) return error(404, "not found");
    if (request.method === "PUT") return publish(request, url, db, host, caller, name.value);
    if (request.method === "DELETE") return unpublish(db, bucket, caller, name.value);
    if (request.method !== "GET") return error(405, "method not allowed");
    // The same artifact a read of one of its files names, so a shared artifact never answers its
    // files over the API while refusing to say anything about itself.
    const record = await resolveArtifact(db, userId, name.value);
    if (record === null) return error(404, `no artifact named ${name.value}`);
    return json({ artifact: viewOf(host, record, await sharesHeld(db, host, record, userId, now)) });
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
    // Origin validation is a MUST on every incoming connection, whichever scheme proved the caller,
    // so it runs before either branch rather than inside the browser one.
    const origin = request.headers.get("origin");
    const own = new URL(request.url).origin;
    if (origin !== null && origin !== own) {
      return mcpRefusal(
        403,
        `${MCP_PATH} answers ${own} alone and this request declared the origin ${origin}; a client that is not a browser sends no Origin header`,
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
    const userId = await userForEmail(env.DB, principal.email);
    if (userId === null) {
      return mcpRefusal(403, `${principal.email} is not invited to this recall; ask its owner to add it`);
    }
    return connectorDevice(env.DB, userId, deps.now());
  };

  const runTool = (env: AppEnv, caller: Caller): RunTool => {
    const db = env.DB;
    const { userId } = caller;
    const refused = (reason: string): ToolResult => ({ ok: false, error: `recall: ${reason}` });
    const document = (value: unknown): ToolResult => ({ ok: true, text: JSON.stringify(value) });
    const saved = async (name: string, input: SaveInput): Promise<ToolResult> => {
      const [vector] = await deps.embedder.embed([embeddingText(name, input.description, input.body)]);
      if (!vector) throw new Error("the embedder answered the memory with no vector");
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
        const sort = "newest";
        const page = await listMemories(
          db,
          userId,
          { ...input.value, types: [], cursor: "", sort },
          startCursor(memoryCursorDirection(sort)),
        );
        return document(page.memories);
      }
      if (call.name === "recall_save") {
        const input = parseSaveArgs(args.value);
        if (!input.ok) return refused(input.error);
        const name = parseName(input.value.name);
        if (!name.ok) return refused(name.error);
        return saved(name.value, input.value);
      }
      if (call.name === "recall_edit") {
        const input = parseEditArgs(args.value);
        if (!input.ok) return refused(input.error);
        const memory = await getMemory(db, userId, input.value.name);
        if (memory === null) return refused(`no memory named ${input.value.name}`);
        return saved(memory.name, editedMemory(memory, input.value));
      }
      if (call.name === "recall_delete") {
        const input = parseNameArgs(args.value);
        if (!input.ok) return refused(input.error);
        const memory = await getMemory(db, userId, input.value.name);
        if (memory === null) return refused(`no memory named ${input.value.name}`);
        await deleteMemory(db, userId, memory.memoryId);
        return document({ deleted: memory.name });
      }
      const input = parseSendArgs(args.value);
      if (!input.ok) return refused(input.error);
      const now = deps.now();
      const [devices, sessions, labels] = await Promise.all([
        listDevices(db, userId),
        listSessions(db, userId, now),
        readLabels(db, userId),
      ]);
      const target = resolveTarget(devices, labels, sessions, input.value.to);
      if (!target.ok) return refused(target.error);
      if (new TextEncoder().encode(input.value.message).byteLength > MAX_BODY_BYTES) {
        return refused(`message must hold at most ${MAX_BODY_BYTES} bytes`);
      }
      const sender: Sender = { deviceId: caller.deviceId, host: caller.host, name: caller.name };
      const message: SendInput = {
        kind: "news",
        toDeviceId: target.value.toDeviceId,
        toSessionId: target.value.toSessionId,
        fromSessionId: "",
        body: input.value.message,
      };
      const sent = await mailboxFor(env, userId).publish(message, sender, now);
      return document({
        messageId: sent.message.messageId,
        toDeviceId: sent.message.toDeviceId,
        toSessionId: sent.message.toSessionId,
      });
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
    if (host !== null && url.hostname === host.hostname) {
      return underSharePrefix(url.pathname)
        ? sharedSite(request, url, env.DB, host)
        : artifactSite(request, url, env.DB, host);
    }
    if (url.pathname === MCP_PATH) return mcp(request, env);
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
    if (collection === "devices") return devices(request, env, caller, rawName);
    if (collection === "board") return board(request, url, env, caller, rawName);
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
    if (collection === "artifacts") return artifacts(request, url, env.DB, caller, rawName, rest);
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
    // event carries the object key, the key says which file of which session grew, and both the
    // cache and the index are then counted off the objects of that file — never off what the
    // consumer did last — so an event delivered twice writes the same rows and indexes nothing a
    // second time.
    //
    // How many bytes of the file the archive holds is a listing and not the key and the size the
    // event carries: a redacted stretch runs to another length than the file it was read from, so
    // where it sits in the archive is the sizes of the stretches in front of it. That count goes
    // down before any indexing, so a session the indexer cannot get through still has a box
    // following it told the file has grown.
    //
    // The cache goes down for the whole delivery in one batch; a D1 failure there fails the
    // delivery and the retry writes the same rows again. Indexing is caught per session, and the
    // messages that brought a session here are sent back for redelivery when it fails: a
    // transcript the indexer cannot get through — a hole in the archive, an embedding call the
    // model refuses — is tried again on its own while every other session's message acks.
    async consume(env: AppEnv, delivered: readonly Delivered[]): Promise<void> {
      const sessions = new Map<string, { chunk: Stretched; messages: Delivered[] }>();
      for (const message of delivered) {
        const event = isRecord(message.body) && isRecord(message.body.object) ? message.body.object : {};
        const { key } = event;
        const chunk = typeof key === "string" ? parseChunkKey(key) : null;
        if (chunk === null) {
          console.error(JSON.stringify({ error: "no transcript stretch in this storage event", event: message.body }));
          message.ack();
          continue;
        }
        if (chunk.file !== MAIN_FILE) continue;
        const session = sessions.get(`${chunk.userId}/${chunk.sessionId}`);
        if (session === undefined) sessions.set(`${chunk.userId}/${chunk.sessionId}`, { chunk, messages: [message] });
        else session.messages.push(message);
      }
      if (sessions.size === 0) return;
      const cached = await Promise.all(
        [...sessions.values()].map(async ({ chunk }) =>
          cacheChunk(
            env.DB,
            chunk.userId,
            chunk.sessionId,
            await archivedBytes(env.TRANSCRIPTS, chunk.userId, chunk.sessionId, MAIN_FILE),
          ),
        ),
      );
      await env.DB.batch(cached);
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

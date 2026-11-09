import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessVerifier, type KeySource, localKeys } from "../src/access";
import { createApp } from "../src/app";
import { DEVICE_CODE_LIMITS, type DeviceCodeLimits, sha256Hex } from "../src/device";
import { MCP_PATH } from "../src/mcp";
import type { Embedder, Memory } from "../src/model";
import { DIMENSIONS, normalize } from "../src/rank";
import { putRecords, RECORDS_PREFIX } from "../src/records";
import { SHARE_EMAIL_PREFIX, SHARE_LINK_PREFIX } from "../src/shares";
import { compressedStretchName, legacyStretchName, stretchName } from "../src/transcript-plan";
import { archivedFiles } from "../src/transcripts";

const ISSUER = "https://recall-test.cloudflareaccess.com";
const ORIGIN = "https://recall.test";

// The dashboard's own Access application, which every other audience here is not.
export const DASHBOARD_AUDIENCE = "recall-test-aud";
export const ARTIFACT_HOSTNAME = "artifact.recall.test";
export const ARTIFACT_AUDIENCE = "recall-test-artifact-aud";

// The email share application's audience, which is not the artifact host's: an assertion minted by
// the host's own application must not open a share, and a test proves that by signing for the
// wrong one of these two.
export const ARTIFACT_SHARE_AUDIENCE = "recall-test-share-aud";

// The connector's own Access application, which is neither the dashboard's nor the artifact host's.
export const MCP_AUDIENCE = "recall-test-mcp-aud";
export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

// A word this embedder refuses, which is how a test stands a model call that keeps failing — a
// Workers AI 5xx, a text it will not take — in front of the indexer.
export const UNEMBEDDABLE = "zzsickzz";

// Embeds plain words only: tokens holding a digit are invisible to it, the way
// rare identifiers barely register with a real embedding model.
export const wordEmbedder: Embedder = {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      if (text.includes(UNEMBEDDABLE)) throw new Error("the embedder refused this text");
      const vector = new Array<number>(DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (/[0-9]/.test(word)) continue;
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
      }
      return normalize(vector);
    });
  },
};

export type Mode = "hybrid" | "vector" | "text";

export interface Hit {
  memory: Memory;
  score: number;
}

export interface PublishFile {
  path: string;
  body: string | Uint8Array;
}

// What a publish sends, with everything the CLI fills in by default already filled in, so a test
// names only the part it is about.
export interface PublishInput {
  type: string;
  title: string;
  description: string;
  read: string;
  write: string;
  files: PublishFile[];
  replace: boolean;
}

// What a host speaks to `/v2` with. It is its own handle rather than a second set of methods on
// the client above it, so a test naming `client.v2` is saying which surface it is about.
export interface V2Client {
  request(method: string, path: string, body?: unknown): Promise<Response>;
  sync(sessionId: string, fields?: Record<string, unknown>): Promise<Response>;
  usage(sessionId: string, fields?: Record<string, unknown>): Promise<Response>;
  /// One append of whole redacted JSONL lines, the record at index `i` carrying ordinal
  /// `from + i`. `closed` says whether a line break closes the last of them, which every file but
  /// a tool output a session stopped writing part way through ends on.
  records(sessionId: string, file: string, from: number, records: string[], closed?: boolean): Promise<Response>;
  session(target: string): Promise<Response>;
  files(sessionId: string): Promise<Response>;
  transcript(sessionId: string, file: string): Promise<Response>;
  /// The session over, which is where the chunk its last turns were still filling closes.
  end(sessionId: string): Promise<Response>;
  searchHistory(query: string, limit?: number): Promise<Response>;
  saveMemory(name: string, fields?: Record<string, unknown>): Promise<Response>;
  memory(name: string): Promise<Response>;
  /// The read that counts as one, which is a write and so a POST of its own.
  recallMemory(name: string): Promise<Response>;
  deleteMemory(name: string): Promise<Response>;
  memories(query?: string): Promise<Response>;
  searchMemories(fields?: Record<string, unknown>): Promise<Response>;
}

export interface Client {
  v2: V2Client;
  /// The account this client signs in as, which is what a test reading rows back keys on.
  userId: string;
  request(method: string, path: string, body?: unknown): Promise<Response>;
  save(name: string, fields: Partial<Pick<Memory, "description" | "type" | "body" | "tags">>): Promise<Memory>;
  publish(name: string, html: string | Uint8Array): Promise<Response>;
  publishArtifact(name: string, input: Partial<PublishInput>): Promise<Response>;
  get(name: string): Promise<Memory>;
  search(query: string, tags: string[] | "any", mode?: Mode): Promise<Hit[]>;
  sync(sessionId: string, fields?: Record<string, unknown>): Promise<Response>;
  usage(sessionId: string, fields?: Record<string, unknown>): Promise<Response>;
  /// One stretch of a file no secret was taken out of, so the span of the file it accounts for is
  /// its own length. Nothing writes the byte archive over the API any more, so this lands the
  /// object and the reach the archive is read against directly.
  archive(sessionId: string, file: string, from: number, body: string | Uint8Array): Promise<Response>;
  /// One stretch that accounts for a span of the file its own bytes do not run to, which is every
  /// stretch a secret was taken out of.
  archiveSpan(
    sessionId: string,
    file: string,
    from: number,
    through: number,
    body: string | Uint8Array,
  ): Promise<Response>;
  /// One stretch as every host sent one: the span of the file it accounts for, and the bytes
  /// gzipped.
  archiveGzip(
    sessionId: string,
    file: string,
    from: number,
    through: number,
    body: string | Uint8Array,
  ): Promise<Response>;
  /// One stretch as a host from before redaction wrote one: one offset, meaning a place in the
  /// archive and in the file at once.
  archiveLegacy(sessionId: string, file: string, offset: number, body: string | Uint8Array): Promise<Response>;
  transcript(sessionId: string): Promise<Response>;
  readTranscript(sessionId: string, file: string): Promise<Response>;
  /// One file read back by a reader that takes the gzip members the archive stores, which is every
  /// browser and the host's own client.
  readTranscriptGzip(sessionId: string, file: string): Promise<Response>;
  session(target: string): Promise<Response>;
  searchSessions(query: string, limit?: number): Promise<Response>;
}

const MEMORY_TYPE_OUT: Record<string, string> = {
  user: "User",
  feedback: "Feedback",
  project: "Project",
  reference: "Reference",
};

const MEMORY_TYPE_IN: Record<string, Memory["type"]> = {
  User: "user",
  Feedback: "feedback",
  Project: "project",
  Reference: "reference",
};

const SEARCH_MODE_OUT: Record<Mode, string> = { hybrid: "Hybrid", vector: "Vector", text: "Text" };

interface MemoryView {
  memoryId: string;
  memoryName: string;
  description: string;
  type: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  recallCount: number;
}

// What the account's own rows look like from outside. They live in that account's Durable Object
// now, so a test reading them reaches into the object rather than into D1.
const inTenant = <T>(userId: string, read: (sql: SqlStorage) => T): Promise<T> =>
  runInDurableObject(env.TENANT.get(env.TENANT.idFromName(userId)), (_instance, state) => read(state.storage.sql));

// One statement against one account's own store, for a test standing a state no route writes or
// reading one no route answers. The rows of every other account are in other objects entirely.
export const tenantRows = <T>(userId: string, query: string, ...binds: SqlStorageValue[]): Promise<T[]> =>
  // The row shape is the caller's assertion, the way `.all<Row>()` is on D1.
  inTenant(userId, (sql) => sql.exec<Record<string, SqlStorageValue>>(query, ...binds).toArray() as T[]);

// How far into the file the archive reaches, which the append that wrote the byte path kept
// beside the objects. A test laying a stretch down lays this with it, since every reader of the
// archive is weighed against it.
const reach = async (userId: string, sessionId: string, archived: number): Promise<void> => {
  await inTenant(userId, (sql) => {
    sql.exec(
      `INSERT INTO session_index (user_id, session_id, archived, bytes, chunks) VALUES (?, ?, ?, 0, 0)
        ON CONFLICT (user_id, session_id) DO UPDATE SET archived = MAX(session_index.archived, excluded.archived)`,
      userId,
      sessionId,
      archived,
    );
  });
};

// An instant a test names as the epoch milliseconds `/v1` took, in the offset-carrying form `/v2`
// takes. A number that is no instant is left alone, since what it is refused for is the point.
const dated = (fields: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const written = { ...fields };
  for (const key of keys) {
    const value = written[key];
    if (typeof value === "number" && value > 0) written[key] = new Date(value).toISOString();
  }
  return written;
};

const MAIN = "main";

const held = (body: string | Uint8Array): number =>
  typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;

const bytesOf = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

// One body as a host sends it and as a reader of the archive reads it back. The members are read
// with the same stream the browser inflates them with, so a test asserting on a transcript is
// asserting on the bytes a reader of the dashboard sees.
export const gzipped = async (body: string | Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(new Blob([bytesOf(body)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );

export const inflated = async (response: Response): Promise<string> => {
  const body = response.body;
  if (body === null) throw new Error("the response carries no body to inflate");
  return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
};

const SESSION_DOCUMENT: Record<string, unknown> = {
  host: "laptop",
  cwd: "/home/you/src/recall",
  repo: "repo:github.com/mvhenten/recall",
  branch: "feat/sessions-list",
  commit: "feat(sessions): list every host's sessions",
  startedAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_060_000,
  prompts: 3,
  focus: { first: "list every host's sessions", latest: "why is the worker test red" },
  mode: "interactive",
  permissionMode: "default",
  pid: 4242,
};

// The same session as SESSION_DOCUMENT, in the shapes `/v2` takes: a mode that names itself and
// instants that carry their offset.
const V2_SESSION_DOCUMENT: Record<string, unknown> = {
  ...SESSION_DOCUMENT,
  startedAt: new Date(1_700_000_000_000).toISOString(),
  lastActivityAt: new Date(1_700_000_060_000).toISOString(),
  mode: "Interactive",
};

const USAGE_DELTA: Record<string, unknown> = {
  seq: 1,
  host: "laptop",
  repo: "repo:github.com/mvhenten/recall",
  provider: "anthropic",
  account: "work",
  model: "claude-opus-4",
  prompts: 1,
  inputTokens: 120,
  outputTokens: 40,
  cacheWriteTokens: 900,
  cacheReadTokens: 8_000,
  at: 1_700_000_060_000,
};

const V2_USAGE_DELTA: Record<string, unknown> = {
  ...USAGE_DELTA,
  at: new Date(1_700_000_060_000).toISOString(),
  durable: false,
  files: [],
};

// The memory `Client.save` writes, in the vocabulary `/v2` takes: a type that names itself and no
// name in the body, since the path already carries it.
const V2_MEMORY_DOCUMENT = (name: string): Record<string, unknown> => ({
  description: `about ${name}`,
  type: "Project",
  body: `notes on ${name}`,
  tags: [],
});

const V2_SEARCH_DOCUMENT: Record<string, unknown> = {
  query: "notes",
  tags: [],
  limit: 10,
  minScore: 0.1,
  mode: "Hybrid",
};

export interface HarnessOptions {
  keys?: "up" | "down";
  deviceCodeLimits?: DeviceCodeLimits;
  artifacts?: "on" | "off";
  // Sharing is the one binding of the artifact host's group that is independently optional: a
  // deployment publishes artifacts and shares none by naming no share audience.
  sharing?: "on" | "off";
  mcpConnector?: "on" | "off";
  /// Stands in for the model a test wants to hold still — one that blocks inside a request is how
  /// two appends are put in flight at once.
  embedder?: Embedder;
}

export const harness = async ({
  keys = "up",
  deviceCodeLimits = DEVICE_CODE_LIMITS,
  artifacts = "on",
  sharing = "on",
  mcpConnector = "on",
  embedder = wordEmbedder,
}: HarnessOptions = {}) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { n, e } = await exportJWK(publicKey);
  if (!n || !e) throw new Error("the generated key has no RSA modulus");
  const unavailable: KeySource = {
    keys: () => Promise.reject(new Error("Access signing keys answered 503")),
    refresh: () => Promise.reject(new Error("Access signing keys answered 503")),
  };
  let clock = 1_700_000_000_000;
  const source = keys === "up" ? localKeys([{ kid: "test", kty: "RSA", n, e }]) : unavailable;
  // Which account a service token acts for is a row of the account store now, not a map the
  // Worker was built with. A test still names the pair outright; the write it queues is drained
  // before the next request goes in, so nothing a test does has to be awaited twice.
  let clientRows: Promise<unknown> = Promise.resolve();
  const serviceClients = {
    set(clientId: string, userId: string): void {
      clientRows = clientRows.then(() =>
        env.DB.prepare(
          "INSERT INTO mcp_clients (client_id, user_id) VALUES (?, ?) ON CONFLICT (client_id) DO UPDATE SET user_id = excluded.user_id",
        )
          .bind(clientId, userId)
          .run(),
      );
    },
  };
  const app = createApp({
    verify: accessVerifier(source, ISSUER, DASHBOARD_AUDIENCE),
    artifactHost:
      artifacts === "off"
        ? null
        : {
            hostname: ARTIFACT_HOSTNAME,
            verify: accessVerifier(source, ISSUER, ARTIFACT_AUDIENCE),
            bucket: env.ARTIFACTS,
            dashboard: `${ORIGIN}/dashboard`,
            sharing: sharing === "off" ? null : { verify: accessVerifier(source, ISSUER, ARTIFACT_SHARE_AUDIENCE) },
          },
    mcpHost: mcpConnector === "off" ? null : { verify: accessVerifier(source, ISSUER, MCP_AUDIENCE) },
    embedder,
    deviceCodeLimits,
    now: () => clock,
  });

  const signed = (claims: Record<string, unknown>, audience: string, expiresAt: string | number): Promise<string> =>
    new SignJWT({ ...claims, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setAudience([audience])
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(privateKey);

  const assertionFor = (
    email: string,
    audience = DASHBOARD_AUDIENCE,
    expiresAt: string | number = "5m",
  ): Promise<string> => signed({ email }, audience, expiresAt);

  // What Access mints for a service token: a common name derived from the client id, and no email.
  const serviceAssertionFor = (commonName: string, audience = MCP_AUDIENCE): Promise<string> =>
    signed({ common_name: commonName }, audience, "5m");

  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    await clientRows;
    return app.fetch(new Request(`${ORIGIN}${path}`, init), env);
  };

  const sendToArtifactHost = (path: string, assertion: string | null, init: RequestInit = {}): Promise<Response> =>
    app.fetch(
      new Request(`https://${ARTIFACT_HOSTNAME}${path}`, {
        ...init,
        headers: { ...init.headers, ...(assertion === null ? {} : { "cf-access-jwt-assertion": assertion }) },
      }),
      env,
    );

  // Both share lanes answer on the artifact hostname under one of two prefixes, and the guard is
  // what keeps a test from reaching the host's own addresses through this helper by mistake. The
  // link lane takes no assertion at all, which is the whole of its credential being the token.
  const sendToSharePrefix = (path: string, assertion: string | null, init: RequestInit = {}): Promise<Response> => {
    if (!path.startsWith(`${SHARE_LINK_PREFIX}/`) && !path.startsWith(`${SHARE_EMAIL_PREFIX}/`)) {
      throw new Error(`${path} sits under neither ${SHARE_LINK_PREFIX} nor ${SHARE_EMAIL_PREFIX}`);
    }
    return sendToArtifactHost(path, assertion, init);
  };

  const shareAssertionFor = (email: string, expiresAt: string | number = "5m"): Promise<string> =>
    assertionFor(email, ARTIFACT_SHARE_AUDIENCE, expiresAt);

  const requestDevice = (deviceName: string, clientIp: string): Promise<Response> =>
    send("/v2/device/code", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": clientIp },
      body: JSON.stringify({ device_name: deviceName }),
    });

  // The bucket is shared by every test in the run, so the harness remembers who it invited and
  // announces only what they wrote.
  const invited = new Set<string>();

  const invite = async (email: string, userId = `user-${crypto.randomUUID()}`): Promise<string> => {
    await env.DB.prepare("INSERT INTO principals (email, user_id) VALUES (?, ?)").bind(email, userId).run();
    invited.add(userId);
    return email;
  };

  const startDevice = async (deviceName = "laptop", clientIp = crypto.randomUUID()): Promise<DeviceStart> => {
    const response = await requestDevice(deviceName, clientIp);
    if (response.status !== 200) throw new Error(`device code: ${response.status} ${await response.text()}`);
    return response.json();
  };

  const poll = (deviceCode: string): Promise<Response> =>
    send("/v2/device/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }),
    });

  const openApproval = (userCode: string, assertion: string | null): Promise<Response> =>
    send(`/device?code=${encodeURIComponent(userCode)}`, {
      headers: assertion === null ? {} : { "cf-access-jwt-assertion": assertion },
    });

  const csrfOf = async (response: Response): Promise<string> => {
    const match = /name="csrf" value="([^"]+)"/.exec(await response.text());
    if (!match?.[1]) throw new Error(`the approval page shows no form: ${response.status}`);
    return match[1];
  };

  const decide = async (
    userCode: string,
    action: "approve" | "deny",
    assertion: string | null,
    csrf?: string,
  ): Promise<Response> => {
    const token = csrf ?? (await csrfOf(await openApproval(userCode, assertion)));
    return send("/device", {
      method: "POST",
      headers: {
        ...(assertion === null ? {} : { "cf-access-jwt-assertion": assertion }),
        origin: ORIGIN,
        cookie: `__Host-recall_csrf=${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ user_code: userCode, action, csrf: token }),
    });
  };

  const login = async (email: string, deviceName = "laptop"): Promise<string> => {
    const started = await startDevice(deviceName);
    const approved = await decide(started.user_code, "approve", await assertionFor(email));
    if (approved.status !== 200) throw new Error(`approve: ${approved.status} ${await approved.text()}`);
    clock += started.interval * 1000;
    const response = await poll(started.device_code);
    if (response.status !== 200) throw new Error(`token: ${response.status} ${await response.text()}`);
    const granted: { access_token: string } = await response.json();
    return granted.access_token;
  };

  const clientWithHeaders = (headers: Record<string, string>, userId = ""): Client => {
    const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
      send(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // The wire format a publish really takes: FormData, so the Request sets the boundary itself
    // and the Worker reads the same body a CLI sends.
    const publishArtifact = (name: string, input: Partial<PublishInput>): Promise<Response> => {
      const files = input.files ?? [{ path: "index.html", body: "<p>published</p>" }];
      const sized = files.map((file) => ({ ...file, blob: new Blob([file.body]) }));
      const form = new FormData();
      form.set(
        "manifest",
        JSON.stringify({
          type: input.type ?? "site",
          title: input.title ?? name,
          description: input.description ?? "",
          read: input.read ?? "private",
          write: input.write ?? "owner",
          files: sized.map((file) => ({ path: file.path, bytes: file.blob.size })),
        }),
      );
      for (const file of sized) form.append("file", file.blob, file.path);
      const replace = input.replace === true ? "?replace=true" : "";
      return send(`/v2/artifacts/${name}${replace}`, { method: "PUT", headers: { ...headers }, body: form });
    };
    const v2: V2Client = {
      request: (method, path, body) =>
        send(path, {
          method,
          headers: { ...headers, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      sync(sessionId, fields = {}) {
        return this.request("PUT", `/v2/sessions/${sessionId}`, { ...V2_SESSION_DOCUMENT, ...fields });
      },
      usage(sessionId, fields = {}) {
        return this.request("POST", `/v2/sessions/${sessionId}/usage`, { ...V2_USAGE_DELTA, ...fields });
      },
      records(sessionId, file, from, records, closed = true) {
        return this.request("POST", `/v2/sessions/${sessionId}/records`, { file, from, records, closed });
      },
      session(target) {
        return this.request("GET", `/v2/sessions/${encodeURIComponent(target)}`);
      },
      files(sessionId) {
        return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/files`);
      },
      transcript(sessionId, file) {
        const path = `/v2/sessions/${encodeURIComponent(sessionId)}/transcript?file=${encodeURIComponent(file)}`;
        return this.request("GET", path);
      },
      end(sessionId) {
        return this.request("DELETE", `/v2/sessions/${encodeURIComponent(sessionId)}`);
      },
      searchHistory(query, limit = 10) {
        return this.request("GET", `/v2/history?q=${encodeURIComponent(query)}&limit=${limit}`);
      },
      saveMemory(name, fields = {}) {
        return this.request("PUT", `/v2/memories/${name}`, { ...V2_MEMORY_DOCUMENT(name), ...fields });
      },
      memory(name) {
        return this.request("GET", `/v2/memories/${encodeURIComponent(name)}`);
      },
      recallMemory(name) {
        return this.request("POST", `/v2/memories/${encodeURIComponent(name)}/recall`);
      },
      deleteMemory(name) {
        return this.request("DELETE", `/v2/memories/${encodeURIComponent(name)}`);
      },
      memories(query = "") {
        return this.request("GET", `/v2/memories${query}`);
      },
      searchMemories(fields = {}) {
        return this.request("POST", "/v2/memories/search", { ...V2_SEARCH_DOCUMENT, ...fields });
      },
    };
    // Which account this client signs in as. A caller that named one is taken at its word; the
    // rest are read off the device row the bearer token belongs to, which is what the Worker does
    // with it on every request.
    const accountId = async (): Promise<string> => {
      if (userId !== "") return userId;
      const token = (headers.authorization ?? "").replace("Bearer ", "");
      const row = await env.DB.prepare("SELECT user_id FROM devices WHERE token_sha256 = ?")
        .bind(await sha256Hex(token))
        .first<{ user_id: string }>();
      if (row === null) throw new Error("this client signs in as no account");
      return row.user_id;
    };
    // What `/v2` answers about a memory, read back in the shape the store holds it in, which is
    // what a test asserting on a corpus reads. The two fields `/v2` does not carry are read off
    // the account's own row.
    const memoryOf = async (view: MemoryView): Promise<Memory> => {
      const account = await accountId();
      const [row] = await tenantRows<{ user_id: string; last_recalled_at: number }>(
        account,
        "SELECT user_id, last_recalled_at FROM memories WHERE memory_id = ?",
        view.memoryId,
      );
      return {
        memoryId: view.memoryId,
        userId: row?.user_id ?? account,
        name: view.memoryName,
        description: view.description,
        type: MEMORY_TYPE_IN[view.type] ?? "project",
        body: view.body,
        tags: view.tags,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        recallCount: view.recallCount,
        lastRecalledAt: row?.last_recalled_at ?? 0,
      };
    };
    // One stretch laid into the byte archive. The API that took these is gone and the archive they
    // are in is read-only, so a test of what reads it back lays the object and the reach down the
    // way the append that is gone did.
    const putArchived = async (
      sessionId: string,
      file: string,
      name: string,
      body: string | Uint8Array,
      gzip: boolean,
    ): Promise<Response> => {
      const account = await accountId();
      await env.TRANSCRIPTS.put(`${account}/${sessionId}/${file}/${name}`, body, {
        httpMetadata: { contentType: "application/x-ndjson", ...(gzip ? { contentEncoding: "gzip" } : {}) },
      });
      if (file === MAIN) {
        const held = (await archivedFiles(env.TRANSCRIPTS, account, sessionId)).find((one) => one.file === MAIN);
        await reach(account, sessionId, held?.bytes ?? 0);
      }
      return new Response(null, { status: 200 });
    };
    return {
      v2,
      userId,
      request,
      async save(name, fields) {
        const { type, ...rest } = fields;
        const response = await v2.saveMemory(name, {
          ...rest,
          ...(type === undefined ? {} : { type: MEMORY_TYPE_OUT[type] ?? type }),
        });
        if (response.status >= 300) throw new Error(`save ${name}: ${response.status} ${await response.text()}`);
        const saved: { memory: MemoryView } = await response.json();
        return memoryOf(saved.memory);
      },
      publish: (name, html) => publishArtifact(name, { files: [{ path: "index.html", body: html }] }),
      publishArtifact,
      async get(name) {
        const response = await v2.memory(name);
        if (response.status !== 200) throw new Error(`get ${name}: ${response.status} ${await response.text()}`);
        const found: { memory: MemoryView } = await response.json();
        return memoryOf(found.memory);
      },
      sync(sessionId, fields = {}) {
        return v2.sync(sessionId, dated(fields, ["startedAt", "lastActivityAt"]));
      },
      usage(sessionId, fields = {}) {
        return v2.usage(sessionId, dated(fields, ["at"]));
      },
      archive(sessionId, file, from, body) {
        return this.archiveSpan(sessionId, file, from, from + held(body), body);
      },
      archiveSpan(sessionId, file, from, through, body) {
        return putArchived(sessionId, file, stretchName(from, through), body, false);
      },
      async archiveGzip(sessionId, file, from, through, body) {
        const member = await gzipped(body);
        return putArchived(sessionId, file, compressedStretchName(from, through, held(body)), member, true);
      },
      archiveLegacy(sessionId, file, offset, body) {
        return putArchived(sessionId, file, legacyStretchName(offset), body, false);
      },
      transcript(sessionId) {
        return v2.files(sessionId);
      },
      readTranscript(sessionId, file) {
        return v2.transcript(sessionId, file);
      },
      readTranscriptGzip(sessionId, file) {
        return send(`/v2/sessions/${encodeURIComponent(sessionId)}/transcript?file=${encodeURIComponent(file)}`, {
          headers: { ...headers, "accept-encoding": "gzip, br" },
        });
      },
      session(target) {
        return v2.session(target);
      },
      searchSessions(query, limit = 10) {
        return v2.searchHistory(query, limit);
      },
      async search(query, tags, mode = "hybrid") {
        const response = await v2.searchMemories({
          query,
          tags: tags === "any" ? [] : tags,
          limit: 10,
          minScore: 0.1,
          mode: SEARCH_MODE_OUT[mode],
        });
        if (response.status !== 200) throw new Error(`search: ${response.status} ${await response.text()}`);
        const result: { hits: Array<{ memory: MemoryView; score: number }> } = await response.json();
        return Promise.all(result.hits.map(async (hit) => ({ memory: await memoryOf(hit.memory), score: hit.score })));
      },
    };
  };

  const clientWithToken = (token: string, userId = ""): Client =>
    clientWithHeaders({ authorization: `Bearer ${token}` }, userId);

  // One JSON-RPC message over the connector endpoint, with whichever Access credential the caller
  // wants the Worker to see.
  const rpc = (message: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> =>
    send(MCP_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });

  const connector = async (email: string) => {
    const headers = { "cf-access-jwt-assertion": await assertionFor(email, MCP_AUDIENCE) };
    let id = 0;
    const call = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
      id += 1;
      const response = await rpc({ id, method, ...(params === undefined ? {} : { params }) }, headers);
      if (response.status !== 200) throw new Error(`${method}: ${response.status} ${await response.text()}`);
      return response.json();
    };
    const tool = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const answered = await call("tools/call", { name, arguments: args });
      const result = answered.result as { content: Array<{ text: string }>; isError?: boolean };
      const [block] = result.content;
      if (result.isError === true) throw new Error(block?.text ?? "the tool failed with no text");
      return block?.text ?? "";
    };
    return {
      headers,
      call,
      tool,
      json: async (name: string, args?: Record<string, unknown>) => JSON.parse(await tool(name, args)),
    };
  };

  const user = async (label: string): Promise<Client> => {
    const userId = `user-${crypto.randomUUID()}`;
    const email = await invite(`${label}-${crypto.randomUUID()}@example.com`, userId);
    return clientWithToken(await login(email), userId);
  };

  return {
    user,
    invite,
    requestDevice,
    send,
    sendToArtifactHost,
    sendToSharePrefix,
    shareAssertionFor,
    rpc,
    connector,
    serviceAssertionFor,
    serviceClients,
    login,
    startDevice,
    poll,
    openApproval,
    csrfOf,
    decide,
    clientWithToken,
    clientWithHeaders,
    assertionFor,
    // The clock every handler reads, moved on. A device grant refuses a poll that comes back
    // inside its own interval, so a test driving one has to let the interval pass.
    advance: (ms: number): void => {
      clock += ms;
    },
    userIdFor: async (email: string): Promise<string> => {
      const row = await env.DB.prepare("SELECT user_id FROM principals WHERE email = ?")
        .bind(email)
        .first<{ user_id: string }>();
      if (row === null) throw new Error(`${email} is not invited`);
      return row.user_id;
    },
    // What the Worker before artifact types wrote: one object at the bare key, with no row naming
    // it. Nothing writes this layout any more, so a test of what it reads back has to lay it down.
    writeLegacyArtifact: async (userId: string, name: string, body: string): Promise<void> => {
      await env.ARTIFACTS.put(`${userId}/${name}`, body);
    },
    // A file the manifest names and storage has lost. No route writes this state, so a test of
    // what the player draws for it has to make it.
    dropArtifactFile: async (userId: string, name: string, rev: number, path: string): Promise<void> => {
      await env.ARTIFACTS.delete(`${userId}/${name}/${rev}/${path}`);
    },
    // One append stored where no endpoint would take it. The records endpoint accepts an append
    // only at the ordinal the file is waiting for, so a file with a run of records the archive
    // never got cannot be made through the API at all.
    storeRecords: (
      userId: string,
      sessionId: string,
      file: string,
      from: number,
      records: string[],
    ): Promise<boolean> => putRecords(env.TRANSCRIPTS, userId, sessionId, file, from, records, true),
    // A key under a session's record prefix this archive did not write, which is what a hand or a
    // half-finished migration leaves behind.
    strayRecord: (userId: string, sessionId: string, name: string): Promise<unknown> =>
      env.TRANSCRIPTS.put(`${RECORDS_PREFIX}/${userId}/${sessionId}/${name}`, "no record object"),
    indexMark: (userId: string, sessionId: string): Promise<Record<string, number> | null> =>
      inTenant(userId, (sql) =>
        sql
          .exec<Record<string, number>>(
            "SELECT archived, bytes, chunks FROM session_index WHERE user_id = ? AND session_id = ?",
            userId,
            sessionId,
          )
          .toArray(),
      ).then((rows) => rows[0] ?? null),
    chunks: (userId: string, sessionId: string): Promise<string[]> =>
      inTenant(userId, (sql) =>
        sql
          .exec<{ text: string }>(
            "SELECT text FROM session_chunks WHERE user_id = ? AND session_id = ? ORDER BY ordinal",
            userId,
            sessionId,
          )
          .toArray()
          .map((row) => row.text),
      ),
    tick: (ms: number) => {
      clock += ms;
      return clock;
    },
    now: () => clock,
  };
};

import { accessVerifier, cachedAccessKeys, type KeySource } from "./access";
import type { ArtifactHost, McpHost } from "./app";
import { createApp } from "./app";
import { DEVICE_CODE_LIMITS } from "./device";
import type { Mailbox } from "./mailbox";
import type { Embedder } from "./model";
import { DIMENSIONS, normalize } from "./rank";

export { Mailbox } from "./mailbox";

export interface Env {
  DB: D1Database;
  AI: Ai;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  TRANSCRIPTS: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  // The three arrive together, or not at all: a deployment that publishes no pages binds none.
  ARTIFACT_HOSTNAME?: string;
  ARTIFACT_ACCESS_AUD?: string;
  ARTIFACTS?: R2Bucket;
  // Both arrive together, or not at all: a deployment that serves no connector binds neither.
  MCP_ACCESS_AUD?: string;
  MCP_SERVICE_CLIENTS?: string;
}

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

const workersAiEmbedder = (ai: Ai): Embedder => ({
  async embed(text: string): Promise<Float32Array> {
    const output = await ai.run(EMBEDDING_MODEL, { text: [text] });
    const vector = "data" in output ? output.data?.[0] : undefined;
    if (!vector || vector.length !== DIMENSIONS)
      throw new Error(`${EMBEDDING_MODEL} returned no ${DIMENSIONS}-dimension embedding`);
    return normalize(vector);
  },
});

let app: ReturnType<typeof createApp> | undefined;

const artifactHost = (env: Env, keys: KeySource, issuer: string): ArtifactHost | null => {
  const { ARTIFACT_HOSTNAME: hostname, ARTIFACT_ACCESS_AUD: audience, ARTIFACTS: bucket } = env;
  if (!hostname || !audience || !bucket) return null;
  return { hostname, verify: accessVerifier(keys, issuer, audience), bucket };
};

// The service-token map is a JSON object of Access client id to user id. A deployment that writes
// one that is not names no clients rather than refusing every browser sign-in beside them.
const serviceClients = (raw: string): Map<string, string> => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP_SERVICE_CLIENTS must be a JSON object of Access client id to user id");
  }
  return new Map(Object.entries(parsed).map(([client, userId]) => [client, String(userId)]));
};

const mcpHost = (env: Env, keys: KeySource, issuer: string): McpHost | null => {
  const { MCP_ACCESS_AUD: audience, MCP_SERVICE_CLIENTS: clients } = env;
  if (!audience || clients === undefined) return null;
  return { verify: accessVerifier(keys, issuer, audience), serviceClients: serviceClients(clients) };
};

const appFor = (env: Env): ReturnType<typeof createApp> => {
  if (app) return app;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const keys = cachedAccessKeys(`${issuer}/cdn-cgi/access/certs`);
  app = createApp({
    verify: accessVerifier(keys, issuer, env.ACCESS_AUD),
    artifactHost: artifactHost(env, keys, issuer),
    mcpHost: mcpHost(env, keys, issuer),
    deviceCodeLimits: DEVICE_CODE_LIMITS,
    embedder: workersAiEmbedder(env.AI),
    now: Date.now,
  });
  return app;
};

export default {
  fetch(request, env) {
    return appFor(env).fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

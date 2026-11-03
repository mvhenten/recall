import { accessVerifier, cachedAccessKeys, type KeySource } from "./access";
import type { ArtifactHost } from "./app";
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
}

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

const workersAiEmbedder = (ai: Ai): Embedder => ({
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const output = await ai.run(EMBEDDING_MODEL, { text: texts });
    const vectors = "data" in output ? output.data : undefined;
    if (!vectors || vectors.length !== texts.length) {
      throw new Error(`${EMBEDDING_MODEL} answered ${texts.length} texts with ${vectors?.length ?? 0} embeddings`);
    }
    return vectors.map((vector) => {
      if (vector.length !== DIMENSIONS)
        throw new Error(`${EMBEDDING_MODEL} returned no ${DIMENSIONS}-dimension embedding`);
      return normalize(vector);
    });
  },
});

let app: ReturnType<typeof createApp> | undefined;

const artifactHost = (env: Env, keys: KeySource, issuer: string): ArtifactHost | null => {
  const { ARTIFACT_HOSTNAME: hostname, ARTIFACT_ACCESS_AUD: audience, ARTIFACTS: bucket } = env;
  if (!hostname || !audience || !bucket) return null;
  return { hostname, verify: accessVerifier(keys, issuer, audience), bucket };
};

const appFor = (env: Env): ReturnType<typeof createApp> => {
  if (app) return app;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const keys = cachedAccessKeys(`${issuer}/cdn-cgi/access/certs`);
  app = createApp({
    verify: accessVerifier(keys, issuer, env.ACCESS_AUD),
    artifactHost: artifactHost(env, keys, issuer),
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
  // Indexing a session's prose runs here and not on the archive's beat: a running session appends
  // every few seconds, and cutting a chunk at every one of those would leave the index a heap of
  // stubs. The queue is one partial index over `session_index`, which the append itself keeps
  // current, so a tick reads the sessions it takes on and no other row.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(appFor(env).index(env));
  },
} satisfies ExportedHandler<Env>;

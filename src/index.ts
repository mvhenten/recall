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
} satisfies ExportedHandler<Env>;

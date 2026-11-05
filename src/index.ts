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
  // The four arrive together, or not at all: a deployment that publishes no artifacts binds none.
  // The dashboard hostname is among them because every artifact page carries one link back to the
  // dashboard, which answers on a second host; a deployment that cannot name that host publishes
  // no artifacts rather than drawing a link to nowhere.
  ARTIFACT_HOSTNAME?: string;
  ARTIFACT_ACCESS_AUD?: string;
  DASHBOARD_HOSTNAME?: string;
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

// The four arrive together or not at all. A deployment that binds some of them meant to publish
// artifacts, and reading that back as "this deployment publishes no artifacts" is the same answer a
// deployment that never wanted the feature gets, so a half-bound one names what it is missing
// instead. A deployment upgraded before a deploy bound the dashboard host is exactly that case.
const artifactHost = (env: Env, keys: KeySource, issuer: string): ArtifactHost | null => {
  const {
    ARTIFACT_HOSTNAME: hostname,
    ARTIFACT_ACCESS_AUD: audience,
    DASHBOARD_HOSTNAME: dashboard,
    ARTIFACTS: bucket,
  } = env;
  const bindings = [
    ["ARTIFACT_HOSTNAME", hostname],
    ["ARTIFACT_ACCESS_AUD", audience],
    ["DASHBOARD_HOSTNAME", dashboard],
    ["ARTIFACTS", bucket],
  ] as const;
  const missing = bindings.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length === bindings.length) return null;
  if (!hostname || !audience || !dashboard || !bucket) {
    throw new Error(
      `this deployment publishes artifacts and binds no ${missing.join(", ")}; run npm run deploy to bind every one of them`,
    );
  }
  return {
    hostname,
    verify: accessVerifier(keys, issuer, audience),
    bucket,
    dashboard: `https://${dashboard}/dashboard`,
  };
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
  // Every stretch written to the archive arrives here as an R2 event notification, and everything
  // the service derives from a transcript is derived off it. There is no beat and nothing asks
  // what is due: the write that made the work is what schedules it. A session the consumer cannot
  // get through sends its own messages back for redelivery, so a transient failure costs a retry
  // rather than a transcript that is never indexed.
  async queue(batch, env) {
    await appFor(env).consume(env, batch.messages);
  },
} satisfies ExportedHandler<Env, unknown>;

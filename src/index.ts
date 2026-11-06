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
  // The fifth of the group, and the one that is independently optional: a deployment can publish
  // artifacts and share none. It is the email share application's audience, and binding it is what
  // turns both share modes on.
  ARTIFACT_SHARE_ACCESS_AUD?: string;
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
  const {
    ARTIFACT_HOSTNAME: hostname,
    ARTIFACT_ACCESS_AUD: audience,
    DASHBOARD_HOSTNAME: dashboard,
    ARTIFACTS: bucket,
    ARTIFACT_SHARE_ACCESS_AUD: shareAudience,
  } = env;
  if (!hostname || !audience || !dashboard || !bucket) return null;
  return {
    hostname,
    verify: accessVerifier(keys, issuer, audience),
    bucket,
    dashboard: `https://${dashboard}/dashboard`,
    sharing: shareAudience ? { verify: accessVerifier(keys, issuer, shareAudience) } : null,
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

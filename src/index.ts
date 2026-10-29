import { accessVerifier, cachedAccessKeys } from "./access";
import { createApp } from "./app";
import { DEVICE_CODE_LIMITS } from "./device";
import type { Embedder } from "./model";
import { DIMENSIONS, normalize } from "./rank";

export interface Env {
  DB: D1Database;
  AI: Ai;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
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

const appFor = (env: Env): ReturnType<typeof createApp> => {
  if (app) return app;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  app = createApp({
    verify: accessVerifier(cachedAccessKeys(`${issuer}/cdn-cgi/access/certs`), issuer, env.ACCESS_AUD),
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

import { accessVerifier, cachedAccessKeys } from "./access";
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
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

// One aud per Access application: the device approval page and the dashboard
// each have their own, so ACCESS_AUD holds them comma separated.
const audiences = (value: string): string[] =>
  value
    .split(",")
    .map((aud) => aud.trim())
    .filter((aud) => aud !== "");

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
    verify: accessVerifier(cachedAccessKeys(`${issuer}/cdn-cgi/access/certs`), issuer, audiences(env.ACCESS_AUD)),
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

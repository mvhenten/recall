import { createRemoteJWKSet } from "jose";
import { accessVerifier } from "./access";
import { createApp } from "./app";
import { vectorizeIndex, workersAiEmbedder } from "./cloudflare";

export interface Env {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: Vectorize;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

let app: ReturnType<typeof createApp> | undefined;

const appFor = (env: Env): ReturnType<typeof createApp> => {
  if (app) return app;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  app = createApp({
    verify: accessVerifier(createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), issuer, env.ACCESS_AUD),
    embedder: workersAiEmbedder(env.AI),
    index: vectorizeIndex(env.VECTORIZE),
    now: Date.now,
  });
  return app;
};

export default {
  fetch(request, env, ctx) {
    return appFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

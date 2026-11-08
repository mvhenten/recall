import { defineConfig } from "drizzle-kit";

// The account store's schema, which is D1. `migrations/` is deliberately split: drizzle-kit writes
// the table and column migrations here from `src/schema/account.ts`, and everything drizzle's
// schema cannot say — the FTS5 virtual tables and their triggers, the DESC index ordering every
// keyset page walks, the partial indexes and `WITHOUT ROWID` — is hand-written into a migration
// made with `--custom`. Wrangler applies them all, in one numbered sequence.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/account.ts",
  out: "./migrations",
});

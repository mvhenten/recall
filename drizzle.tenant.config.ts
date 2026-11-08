import { defineConfig } from "drizzle-kit";

// The tenant store's schema, which is one Durable Object's own SQLite. It is split the same way
// `drizzle.config.ts` says, and applied by `migrateDurableObject` on the first touch of an object
// rather than by drizzle's own migrator: that one keeps its ledger in a table of its own, and a
// tenant already on record would have its first migration run a second time.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/tenant.ts",
  out: "./migrations/tenant",
});

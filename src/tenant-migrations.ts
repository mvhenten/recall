import tenant0001 from "../migrations/tenant/0001_tenant.sql";
import tenant0002 from "../migrations/tenant/0002_artifacts.sql";
import tenant0003 from "../migrations/tenant/0003_memories.sql";
import tenant0004 from "../migrations/tenant/0004_memory_indexes.sql";
import tenant0005 from "../migrations/tenant/0005_peeks.sql";
import type { Migration } from "./durable-migrate";

// What `migrateDurableObject` applies, in order. A tenant migration runs from here and not from
// the journal drizzle-kit writes, so a file this list does not name is applied by nothing;
// `npm run migrations:tenant` fails when the two disagree.
export const TENANT_MIGRATIONS: readonly Migration[] = [
  { name: "0001_tenant", sql: tenant0001 },
  { name: "0002_artifacts", sql: tenant0002 },
  { name: "0003_memories", sql: tenant0003 },
  { name: "0004_memory_indexes", sql: tenant0004 },
  { name: "0005_peeks", sql: tenant0005 },
];

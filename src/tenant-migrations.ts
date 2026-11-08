import tenant0001 from "../migrations/tenant/0001_tenant.sql";
import tenant0002 from "../migrations/tenant/0002_artifacts.sql";
import type { Migration } from "./durable-migrate";

// What `migrateDurableObject` applies, in order. A tenant migration runs from here and not from
// the journal drizzle-kit writes, so a file this list does not name is applied by nothing;
// `npm run migrations:tenant` fails when the two disagree.
export const TENANT_MIGRATIONS: readonly Migration[] = [
  { name: "0001_tenant", sql: tenant0001 },
  { name: "0002_artifacts", sql: tenant0002 },
];

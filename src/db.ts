import type { ExtractTablesWithRelations } from "drizzle-orm";
import { type DrizzleD1Database, drizzle as drizzleD1 } from "drizzle-orm/d1";
import { type DrizzleSqliteDODatabase, drizzle as drizzleDurable } from "drizzle-orm/durable-sqlite";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import * as account from "./schema/account";
import * as tenant from "./schema/tenant";

export type AccountDb = DrizzleD1Database<typeof account>;

export type TenantDb = DrizzleSqliteDODatabase<typeof tenant>;

// What a tenant batch hands its statements. Every statement of one lands or none of them does,
// which is `transactionSync` underneath.
export type TenantTx = SQLiteTransaction<
  "sync",
  SqlStorageCursor<Record<string, SqlStorageValue>>,
  typeof tenant,
  ExtractTablesWithRelations<typeof tenant>
>;

export const accountStoreOf = (binding: D1Database): AccountDb => drizzleD1(binding, { schema: account });

export const tenantStoreOf = (storage: DurableObjectStorage): TenantDb => drizzleDurable(storage, { schema: tenant });

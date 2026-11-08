import type { ExtractTablesWithRelations } from "drizzle-orm";
import { type DrizzleD1Database, drizzle as drizzleD1 } from "drizzle-orm/d1";
import { type DrizzleSqliteDODatabase, drizzle as drizzleDurable } from "drizzle-orm/durable-sqlite";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import * as account from "./schema/account";
import * as tenant from "./schema/tenant";

// The two stores, and the two handles that reach them. They are branded because drizzle's own
// types do not keep them apart: one reads a Durable Object's SQLite and answers now, the other
// reads D1 and answers over the network, and a function returning a promise is assignable to one
// returning void — so without a brand an account handle would typecheck where a tenant one is
// asked for and the wrong store would be read.

declare const accountStore: unique symbol;
declare const tenantStore: unique symbol;

export type AccountDb = DrizzleD1Database<typeof account> & { readonly [accountStore]: true };

export type TenantDb = DrizzleSqliteDODatabase<typeof tenant> & { readonly [tenantStore]: true };

// What a tenant batch hands its statements. Every statement of one lands or none of them does,
// which is `transactionSync` underneath.
export type TenantTx = SQLiteTransaction<
  "sync",
  SqlStorageCursor<Record<string, SqlStorageValue>>,
  typeof tenant,
  ExtractTablesWithRelations<typeof tenant>
>;

export const accountStoreOf = (binding: D1Database): AccountDb =>
  drizzleD1(binding, { schema: account }) as unknown as AccountDb;

export const tenantStoreOf = (storage: DurableObjectStorage): TenantDb =>
  drizzleDurable(storage, { schema: tenant }) as unknown as TenantDb;

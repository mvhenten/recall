import tenant0001 from "../migrations/tenant/0001_tenant.sql";
import type { Migration } from "./durable-migrate";

export const TENANT_MIGRATIONS: readonly Migration[] = [{ name: "0001_tenant", sql: tenant0001 }];

import { DurableObject } from "cloudflare:workers";
import { createTenant, type TenantApi, type TenantCall, type TenantEnv } from "./app";
import type { Caller } from "./device";
import { migrateDurableObject } from "./durable-migrate";
import type { Env } from "./index";
import type { ToolCall, ToolResult } from "./mcp";
import { TENANT_MIGRATIONS } from "./tenant-migrations";
import { type SqlDb, tenantSql } from "./tenant-sql";

// One account's own rows, in one object addressed by its user id. The Worker proves who is asking
// and then calls in here; everything below the device token runs against this object's SQLite,
// which no other account can reach.
//
// It sits beside `Mailbox` rather than inside it. The bus holds a hibernating WebSocket per
// listening host in a single-threaded object, and a store read queued behind a socket event would
// be a listing waiting on somebody else's message.
export class Tenant extends DurableObject<Env> {
  private readonly db: SqlDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = tenantSql(ctx.storage);
    // A tenant comes into being empty, so the first touch lays the schema down and every touch
    // after reads one row to find there is nothing to do.
    void ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage.sql, TENANT_MIGRATIONS);
    });
  }

  api(request: Request, caller: Caller, call: TenantCall): Promise<Response> {
    return this.half(call).api(request, this.store(), caller);
  }

  dashboard(request: Request, userId: string, email: string, call: TenantCall): Promise<Response> {
    return this.half(call).dashboard(request, this.store(), userId, email);
  }

  tool(made: ToolCall, caller: Caller, call: TenantCall): Promise<ToolResult> {
    return this.half(call).tool(made, this.store(), caller);
  }

  index(userId: string, sessionId: string, call: TenantCall): Promise<boolean> {
    return this.half(call).index(this.store(), userId, sessionId);
  }

  private store(): TenantEnv {
    return {
      DB: this.db,
      ACCOUNT: this.env.DB,
      MAILBOX: this.env.MAILBOX,
      TRANSCRIPTS: this.env.TRANSCRIPTS,
    };
  }

  private half(call: TenantCall): TenantApi {
    const bucket = this.env.ARTIFACTS;
    return createTenant({
      embedder: { embed: (texts: string[]): Promise<Float32Array[]> => call.embed(texts) },
      artifacts: call.artifacts === null || bucket === undefined ? null : { ...call.artifacts, bucket },
      now: (): number => call.now,
    });
  }
}

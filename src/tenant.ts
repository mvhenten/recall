import { DurableObject } from "cloudflare:workers";
import { createTenant, type TenantApi, type TenantCall, type TenantEnv } from "./app";
import type { ArtifactListInput, ArtifactRecord } from "./artifacts";
import { accountStoreOf, type TenantDb, tenantStoreOf } from "./db";
import type { Caller } from "./device";
import { migrateDurableObject } from "./durable-migrate";
import type { Env } from "./index";
import type { ToolCall, ToolResult } from "./mcp";
import {
  type ArtifactCommit,
  type ArtifactCounts,
  type ArtifactMatches,
  type ArtifactPage,
  adoptArtifacts,
  artifactCounts,
  type Cursor,
  claimRevision,
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifactPage,
  replaceArtifact,
  searchArtifacts,
} from "./store";
import { TENANT_MIGRATIONS } from "./tenant-migrations";

// One account's own rows, in one object addressed by its user id. The Worker proves who is asking
// and then calls in here; everything below the device token runs against this object's SQLite,
// which no other account can reach.
//
// It sits beside `Mailbox` rather than inside it. The bus holds a hibernating WebSocket per
// listening host in a single-threaded object, and a store read queued behind a socket event would
// be a listing waiting on somebody else's message.
export class Tenant extends DurableObject<Env> {
  private readonly db: TenantDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = tenantStoreOf(ctx.storage);
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

  // The artifact rows, which the Worker reads rather than the object's own halves. The collection
  // streams a publish straight into R2 and serves an artifact's bytes back out of it, and routing
  // that through here would carry sixty-four megabytes Worker to object to storage for nothing;
  // what the Worker cannot hold is the rows, so those and nothing else cross here. Every one
  // names the account it is for, and an id that is not this object's matches no row of it.
  artifact(userId: string, name: string): Promise<ArtifactRecord | null> {
    return getArtifact(this.db, userId, name);
  }

  artifactPage(userId: string, input: ArtifactListInput, cursor: Cursor): Promise<ArtifactPage> {
    return listArtifactPage(this.db, userId, input, cursor);
  }

  artifactMatches(userId: string, type: string, match: string, limit: number): Promise<ArtifactMatches> {
    return searchArtifacts(this.db, userId, type, match, limit);
  }

  artifactTally(userId: string): Promise<ArtifactCounts> {
    return artifactCounts(this.db, userId);
  }

  claimArtifactRevision(userId: string, name: string): Promise<number> {
    return claimRevision(this.db, userId, name);
  }

  createArtifact(commit: ArtifactCommit): Promise<boolean> {
    return createArtifact(this.db, commit);
  }

  replaceArtifact(commit: ArtifactCommit, fromRev: number): Promise<boolean> {
    return replaceArtifact(this.db, commit, fromRev);
  }

  deleteArtifact(userId: string, name: string): Promise<void> {
    return deleteArtifact(this.db, userId, name);
  }

  // The one artifact call that reads storage, because the listing it walks is this account's own
  // prefix and what it writes is this object's rows.
  adoptArtifacts(userId: string): Promise<number> {
    const bucket = this.env.ARTIFACTS;
    if (bucket === undefined) throw new Error("this deployment binds no artifact bucket");
    return adoptArtifacts(this.db, bucket, userId);
  }

  private store(): TenantEnv {
    return {
      DB: this.db,
      ACCOUNT: accountStoreOf(this.env.DB),
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

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ARTIFACTS: R2Bucket;
    MAILBOX: DurableObjectNamespace<import("../src/mailbox").Mailbox>;
    TENANT: DurableObjectNamespace<import("../src/tenant").Tenant>;
    TRANSCRIPTS: R2Bucket;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

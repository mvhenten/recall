declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MAILBOX: DurableObjectNamespace<import("../src/mailbox").Mailbox>;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

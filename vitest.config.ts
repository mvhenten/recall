import { readFile } from "node:fs/promises";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";

// Wrangler bundles a `.sql` file as the text it holds through its Text module rule. Vite has no
// such rule, so the tenant migrations are loaded here the same way.
const sqlText = (): Plugin => ({
  name: "sql-text",
  enforce: "pre",
  async load(id: string): Promise<string | null> {
    if (!id.endsWith(".sql")) return null;
    return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
  },
});

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      sqlText(),
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});

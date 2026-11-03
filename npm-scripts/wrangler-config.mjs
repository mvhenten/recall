// The checked-in Worker config both the setup and the deploy start from. `wrangler.jsonc` carries
// comments and JSON.parse does not, so the one reader strips them and both callers get the same
// object out of the same file.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const readWranglerConfig = () =>
  JSON.parse(
    readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  );

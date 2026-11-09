-- Which account an Access service token acted for. The lane it served is gone: Access fronted
-- `/mcp` and exchanged a client id and secret for an assertion, and `/mcp` now answers the 401 a
-- web MCP client discovers its connect flow from, so no Access application covers it and nothing
-- exchanges a pair. `infra/main.tf` no longer mints the tokens, `src/store.ts` no longer reads the
-- table, and a connector authorizes itself through the OAuth flow in `src/oauth.ts` instead.
--
-- The rows are deployment config and not a corpus: each one mapped an Access client id to a user,
-- and both the ids and the mapping are gone with the tokens. There is nothing here a rollback
-- would want, so the table goes in the release that stops reading it.
--
-- Written by hand with `drizzle-kit generate --custom`, which is how `drizzle.config.ts` says a
-- statement drizzle's schema cannot express is written here, and is also why the guard in
-- `npm-scripts/generate-migrations.mjs` is untouched: it refuses a `DROP TABLE` drizzle-kit
-- generated, because that shape is a column rebuild wearing a drop. `--custom` copies the snapshot
-- beside the previous migration rather than reading the schema, so the table was taken out of the
-- copy by hand: the next generate has to diff from a schema that no longer claims it.

DROP TABLE mcp_clients;

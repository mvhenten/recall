-- The rows the account store held open while a rollback was still possible. Every table below
-- moved to each account's own Durable Object -- the sessions in `migrations/tenant/0001_tenant.sql`,
-- the artifacts in `0002_artifacts.sql`, the memories in `0003_memories.sql` -- and D1's copies
-- have been read by nothing since #138 took `/v1` and the copiers with it. `src/schema/account.ts`
-- stopped naming them then, so this is the drop `0023` said step E of #115 would carry.
--
-- Written by hand with `drizzle-kit generate --custom`, which is how `drizzle.config.ts` says a
-- statement drizzle's schema cannot express is written here. The guard in
-- `npm-scripts/generate-migrations.mjs` refuses a `DROP TABLE` drizzle-kit *generated*, because
-- that shape is a column rebuild wearing a drop and it takes the FTS5 triggers and the DESC
-- indexes with it in silence. Nothing below is generated and nothing below is a rebuild: the
-- snapshot beside this file already matched `account.ts` before the file was written, so the
-- guard is untouched and still fires on the case it was built for.
--
-- The triggers go first, so none outlives the table it writes into. A table's indexes and an FTS5
-- table's shadow tables go with the table itself, so neither is named here.

DROP TRIGGER memories_fts_insert;

DROP TRIGGER memories_fts_delete;

DROP TRIGGER memories_fts_update;

DROP TRIGGER artifacts_fts_insert;

DROP TRIGGER artifacts_fts_delete;

DROP TRIGGER artifacts_fts_update;

DROP TRIGGER session_chunks_fts_insert;

DROP TRIGGER session_chunks_fts_delete;

DROP TRIGGER session_history_fts_insert;

DROP TRIGGER session_history_fts_delete;

DROP TRIGGER session_history_fts_update;

DROP TABLE memories_fts;

DROP TABLE artifacts_fts;

DROP TABLE session_chunks_fts;

DROP TABLE session_history_fts;

DROP TABLE memory_tags;

DROP TABLE memories;

DROP TABLE artifact_revisions;

DROP TABLE artifacts;

DROP TABLE board_pickups;

DROP TABLE board_messages;

DROP TABLE labels;

DROP TABLE counted_files;

DROP TABLE usage_daily;

DROP TABLE usage_events;

DROP TABLE session_open_chunks;

DROP TABLE session_records;

DROP TABLE session_chunks;

DROP TABLE session_index;

DROP TABLE session_history;

DROP TABLE sessions;

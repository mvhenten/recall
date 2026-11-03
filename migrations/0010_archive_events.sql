-- The cron's queue is gone: a storage event brings the indexer to the session it moved, so
-- nothing asks which sessions are due.
DROP INDEX session_index_due;

-- `indexed_at` answered that query alone and nothing reads it now. It is NOT NULL with no
-- default, so an insert that stopped naming it would fail; the table is rebuilt with a default
-- instead, which lets this release's Worker leave the column out while the Worker still serving
-- the deploy window goes on naming it. Dropping the column is then a migration on its own,
-- against a column no deployed code touches.
CREATE TABLE session_index_rebuilt (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  archived INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, session_id)
);

INSERT INTO session_index_rebuilt (user_id, session_id, archived, bytes, chunks, indexed_at)
SELECT user_id, session_id, archived, bytes, chunks, indexed_at FROM session_index;

DROP TABLE session_index;

ALTER TABLE session_index_rebuilt RENAME TO session_index;

-- The full-text index, told when a chunk goes. `session_chunks_fts` is an external-content table,
-- so a row deleted from `session_chunks` leaves its terms behind under a rowid that no longer
-- names it — and `chunk_seq` is the table's own rowid, which SQLite hands out again once the
-- highest rows are gone. The next chunk to take that number would then be found by the words of
-- the one it replaced.
--
-- Nothing deleted a chunk until a replay could take a session off the byte path, which drops every
-- chunk that path wrote and indexes the records in their place.
CREATE TRIGGER session_chunks_fts_delete AFTER DELETE ON session_chunks BEGIN
  INSERT INTO session_chunks_fts (session_chunks_fts, rowid, text) VALUES ('delete', old.chunk_seq, old.text);
END;

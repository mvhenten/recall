-- The record path's mark, which is the other way a session's transcript reaches the index. The
-- byte path keys an object by where its stretch sits in the file and the consumer reads the
-- archive back; a record append carries whole JSONL lines and indexes them in the request, so what
-- it has to remember is how many lines of a file it has taken and nothing about bytes at all.
--
-- One row per file of a session. A session holding any row here is on the record mark, which is
-- what `App.consume` reads to leave it alone: the two paths index the same prose, so a session on
-- both would write every chunk twice.
CREATE TABLE session_records (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  next_ordinal INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, file)
) WITHOUT ROWID;

-- The chunk a file's last append left half-built, carried to the next one. Chunk boundaries fall
-- where the conversation turns rather than where a batch ended, so the pieces of an unclosed chunk
-- wait here instead of being closed early: the same records produce the same chunks whether a host
-- sent them in one call or in thirty.
--
-- `pieces` is the JSON array the chunker held, not the text they join to. Joining and splitting
-- again would lose where the piece boundaries were, and the chunker weighs its next piece against
-- those.
CREATE TABLE session_open_chunks (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('user', 'model')),
  pieces TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, file, speaker)
) WITHOUT ROWID;

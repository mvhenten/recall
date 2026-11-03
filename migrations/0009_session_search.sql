-- The name Claude Code gives a session, which is what its owner calls it. The harness writes it
-- into the transcript as an `agent-name` entry, so it is read off the archive rather than reported
-- by a host, and a session archived before this existed gets one on its first indexing pass.
ALTER TABLE sessions ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE session_history ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';

CREATE INDEX session_history_by_agent_name ON session_history (user_id, agent_name);

-- The indexer's queue and its mark, one row per session. `archived` is how far the archive holds
-- the session's own transcript, moved by the append that writes it; `bytes` is how far the index
-- has read of that. A session with the second behind the first is due, and that is the whole of
-- the queue: the partial index below answers it off this table alone, so a pass with nothing due
-- reads no row at all rather than walking every file of every session.
CREATE TABLE session_index (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  archived INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX session_index_due ON session_index (indexed_at) WHERE bytes < archived;

-- The sessions already archived when this landed. Their appends are long over, so nothing else
-- would ever put them in the queue.
INSERT INTO session_index (user_id, session_id, archived, bytes, chunks, indexed_at)
SELECT user_id, session_id, bytes, 0, 0, 0 FROM transcript_files WHERE file = 'main';

-- One stretch of what a session said: the user's prompts and the model's prose, each chunked on
-- its own and neither carrying tool calls, tool results or a delegated turn. `ordinal` only ever
-- climbs, so a session indexed again after it was resumed appends rather than rewriting.
CREATE TABLE session_chunks (
  chunk_seq INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('user', 'model')),
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (user_id, session_id, ordinal)
);

CREATE INDEX session_chunks_by_user ON session_chunks (user_id);

CREATE VIRTUAL TABLE session_chunks_fts USING fts5 (
  text,
  content = 'session_chunks',
  content_rowid = 'chunk_seq',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER session_chunks_fts_insert AFTER INSERT ON session_chunks BEGIN
  INSERT INTO session_chunks_fts (rowid, text) VALUES (new.chunk_seq, new.text);
END;

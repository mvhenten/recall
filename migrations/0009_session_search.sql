-- The name Claude Code gives a session, which is what its owner calls it. The harness writes it
-- into the transcript as an `agent-name` entry, so it is read off the archive rather than reported
-- by a host, and a session archived before this existed gets one on its first indexing pass.
ALTER TABLE sessions ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE session_history ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';

CREATE INDEX session_history_by_agent_name ON session_history (user_id, agent_name);

-- How far into a session's own transcript the index has read, and the session's place in the
-- first pass of a search. `embedding` is the mean of the session's chunk vectors: a search scores
-- every session against it to pick the handful worth reading chunks of, which is what keeps a
-- search off every chunk the account holds.
CREATE TABLE session_index (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX session_index_by_pass ON session_index (indexed_at);

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

CREATE VIRTUAL TABLE session_chunks_fts USING fts5 (
  text,
  content = 'session_chunks',
  content_rowid = 'chunk_seq',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER session_chunks_fts_insert AFTER INSERT ON session_chunks BEGIN
  INSERT INTO session_chunks_fts (rowid, text) VALUES (new.chunk_seq, new.text);
END;

CREATE TRIGGER session_chunks_fts_delete AFTER DELETE ON session_chunks BEGIN
  INSERT INTO session_chunks_fts (session_chunks_fts, rowid, text) VALUES ('delete', old.chunk_seq, old.text);
END;

-- The tenant's own schema, which is the account's sessions, its prose index, its usage, its labels
-- and its board. Every table here was a D1 table keyed by `user_id`, and it keeps that column: one
-- object holds one account, so the column is redundant and dropping it would rewrite every query
-- for nothing. D1 keeps the rows a request reads before it knows which tenant it is for.

CREATE TABLE sessions (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  cwd TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_subject TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  prompts INTEGER NOT NULL,
  focus_first TEXT NOT NULL,
  focus_latest TEXT NOT NULL,
  mode TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  pid INTEGER NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX sessions_by_user_activity ON sessions (user_id, last_activity_at DESC, session_id);

CREATE TABLE session_history (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  host TEXT NOT NULL,
  cwd TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_subject TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  prompts INTEGER NOT NULL,
  focus_first TEXT NOT NULL,
  focus_latest TEXT NOT NULL,
  mode TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX session_history_by_agent_name ON session_history (user_id, agent_name);

CREATE INDEX session_history_by_activity
  ON session_history (user_id, last_activity_at DESC, session_id DESC);

-- History's search index. It stores its own copy of the text rather than pointing at the rows:
-- `session_history` is keyed by (user_id, session_id) and carries no INTEGER PRIMARY KEY for
-- `content_rowid` to name.
CREATE VIRTUAL TABLE session_history_fts USING fts5 (
  session_id UNINDEXED,
  user_id UNINDEXED,
  focus_first,
  focus_latest,
  commit_subject,
  agent_name,
  tokenize = 'porter unicode61'
);

-- The history write is an INSERT OR REPLACE, and SQLite fires a delete trigger for the row a
-- REPLACE displaced only where recursive triggers are on. So the insert clears the session's row
-- itself: one session keeps one row here however many times it syncs.
CREATE TRIGGER session_history_fts_insert AFTER INSERT ON session_history BEGIN
  DELETE FROM session_history_fts WHERE user_id = new.user_id AND session_id = new.session_id;
  INSERT INTO session_history_fts (session_id, user_id, focus_first, focus_latest, commit_subject, agent_name)
  VALUES (new.session_id, new.user_id, new.focus_first, new.focus_latest, new.commit_subject, new.agent_name);
END;

CREATE TRIGGER session_history_fts_delete AFTER DELETE ON session_history BEGIN
  DELETE FROM session_history_fts WHERE user_id = old.user_id AND session_id = old.session_id;
END;

CREATE TRIGGER session_history_fts_update
AFTER UPDATE OF focus_first, focus_latest, commit_subject, agent_name ON session_history BEGIN
  DELETE FROM session_history_fts WHERE user_id = old.user_id AND session_id = old.session_id;
  INSERT INTO session_history_fts (session_id, user_id, focus_first, focus_latest, commit_subject, agent_name)
  VALUES (new.session_id, new.user_id, new.focus_first, new.focus_latest, new.commit_subject, new.agent_name);
END;

-- The byte path's mark, one row per session. `archived` is how far the archive holds the session's
-- own transcript; `bytes` is how far the index has read of that.
CREATE TABLE session_index (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  archived INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

-- One stretch of what a session said: the user's prompts and the model's prose, each chunked on
-- its own. `ordinal` only ever climbs, so a session indexed again after it was resumed appends
-- rather than rewriting.
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

-- `session_chunks_fts` is an external-content table, so a row deleted from `session_chunks` leaves
-- its terms behind under a rowid that no longer names it, and `chunk_seq` is handed out again once
-- the highest rows are gone.
CREATE TRIGGER session_chunks_fts_delete AFTER DELETE ON session_chunks BEGIN
  INSERT INTO session_chunks_fts (session_chunks_fts, rowid, text) VALUES ('delete', old.chunk_seq, old.text);
END;

-- The record path's mark, one row per file of a session. A session holding any row for `main` is on
-- the record mark, which is what the byte path's consumer reads to leave it alone.
CREATE TABLE session_records (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  next_ordinal INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, file)
) WITHOUT ROWID;

-- The chunk a file's last append left half-built, carried to the next one. `pieces` is the JSON
-- array the chunker held, not the text they join to.
CREATE TABLE session_open_chunks (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('user', 'model')),
  pieces TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, file, speaker)
) WITHOUT ROWID;

CREATE TABLE usage_events (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  model TEXT NOT NULL,
  prompts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  durable INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, session_id, seq)
);

CREATE INDEX usage_events_by_user_recorded ON usage_events (user_id, recorded_at);

CREATE TABLE usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  host TEXT NOT NULL,
  repo TEXT NOT NULL,
  account TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, host, repo, account, provider, model)
);

CREATE TABLE labels (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);

-- Which of a session's transcript files have had their tokens counted, whoever counted them.
CREATE TABLE counted_files (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, file)
);

-- The board, which is the bus's opposite. `scope` and `target` are the whole address, in the
-- vocabulary `recall send` already resolves.
CREATE TABLE board_messages (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('fleet', 'host', 'session')),
  target TEXT NOT NULL CHECK (scope <> 'fleet' OR target = user_id),
  from_device_id TEXT NOT NULL,
  from_host TEXT NOT NULL,
  from_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

-- The pickup, which is the acknowledgement. The primary key is the whole of the single-taker
-- guarantee: two sessions booting together both insert and only one writes a row.
CREATE TABLE board_pickups (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  host TEXT NOT NULL,
  picked_up_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
) WITHOUT ROWID;

CREATE INDEX board_by_address ON board_messages (user_id, scope, target, created_at, message_id);

CREATE INDEX board_by_posted ON board_messages (user_id, created_at DESC, message_id DESC);

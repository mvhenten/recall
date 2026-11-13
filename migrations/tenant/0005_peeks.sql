-- Every peek one session has been asked for. The request is written here before anything
-- summarises it, so the asker has a row to read back while it waits, and the digest lands on that
-- same row rather than on a second one. A row still holding an empty digest is a peek nothing has
-- answered. The history is trimmed where a peek is written and swept by nothing: no read in this
-- service makes a pass of its own.
CREATE TABLE session_peeks (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  peek_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, peek_id)
) WITHOUT ROWID;

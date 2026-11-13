-- Every peek one session has been asked for. The request is written here before anything
-- summarises it, so the asker has a row to read back while it waits, and the digest lands on that
-- same row rather than on a second one. The history is trimmed where a peek is written and swept by
-- nothing: no read in this service makes a pass of its own.
CREATE TABLE session_peeks (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  peek_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
  digest TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, peek_id)
) WITHOUT ROWID;

-- Newest first, which is the order a history is read in and the order the trim walks to find what
-- falls off the end. The peek id settles two peeks asked for in the same millisecond, so both walk
-- a total order.
CREATE INDEX session_peeks_by_session
  ON session_peeks (user_id, session_id, requested_at DESC, peek_id DESC);

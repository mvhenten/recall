-- The first index that orders the query the history tab already runs. Without it SQLite reads the
-- account's whole history and sorts it, which is the scan the newest-first page costs today.
CREATE INDEX session_history_by_activity
  ON session_history (user_id, last_activity_at DESC, session_id DESC);

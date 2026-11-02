CREATE INDEX session_history_recent ON session_history (user_id, last_activity_at DESC, session_id DESC);

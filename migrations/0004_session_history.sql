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
  PRIMARY KEY (user_id, session_id)
);

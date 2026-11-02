CREATE TABLE sessions (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  host TEXT NOT NULL,
  cwd TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_subject TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  prompts INTEGER NOT NULL,
  focus_first TEXT NOT NULL,
  focus_latest TEXT NOT NULL,
  mode TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  pid INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX sessions_by_user_activity ON sessions (user_id, last_activity_at DESC, session_id);

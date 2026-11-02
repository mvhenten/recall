CREATE TABLE transcript_files (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, file)
);

ALTER TABLE usage_events ADD COLUMN durable INTEGER NOT NULL DEFAULT 0;

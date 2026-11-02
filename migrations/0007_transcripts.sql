CREATE TABLE transcript_files (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, file)
);

-- Which of a session's transcript files have had their tokens counted, whoever counted them.
-- usage_events is swept at two weeks and says nothing about which file a delta read, so a host
-- reading its transcripts back long after has nothing else to ask.
CREATE TABLE counted_files (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, file)
);

ALTER TABLE usage_events ADD COLUMN durable INTEGER NOT NULL DEFAULT 0;

CREATE TABLE labels (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);

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

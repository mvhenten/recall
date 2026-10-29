CREATE TABLE principals (
  client_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  recall_count INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX memories_by_user_created ON memories (user_id, created_at DESC, memory_id DESC);

CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories (memory_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);

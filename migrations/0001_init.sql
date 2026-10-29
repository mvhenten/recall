CREATE TABLE principals (
  client_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE memories (
  memory_seq INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  body TEXT NOT NULL,
  embedding BLOB NOT NULL,
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

CREATE VIRTUAL TABLE memories_fts USING fts5 (
  name,
  description,
  body,
  content = 'memories',
  content_rowid = 'memory_seq',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, name, description, body) VALUES (new.memory_seq, new.name, new.description, new.body);
END;

CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, name, description, body)
  VALUES ('delete', old.memory_seq, old.name, old.description, old.body);
END;

CREATE TRIGGER memories_fts_update AFTER UPDATE OF name, description, body ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, name, description, body)
  VALUES ('delete', old.memory_seq, old.name, old.description, old.body);
  INSERT INTO memories_fts (rowid, name, description, body) VALUES (new.memory_seq, new.name, new.description, new.body);
END;

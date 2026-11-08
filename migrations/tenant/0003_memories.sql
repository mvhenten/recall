-- What this account remembers, as `migrations/0001_init.sql` and `migrations/0014_memory_recall_index.sql`
-- left it in D1, column for column. The corpus is the only store recall cannot rebuild: a
-- transcript is still on its host and a published artifact's bytes are still in R2, and a memory
-- is here and nowhere else.
--
-- `memory_seq` is `memories_fts`'s `content_rowid`. The copy out of D1 writes it as it stands
-- rather than letting SQLite hand out a new one, because bm25 scores two rows of one query alike
-- and leaves the rowid to settle them: a re-numbered corpus answers the same query in another
-- order and nothing fails anywhere.
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

CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories (memory_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);

-- The two orders a listing pages by, newest and most recalled. The name breaks the tie on the
-- second so the keyset cursor walks a total order.
CREATE INDEX memories_by_user_created ON memories (user_id, created_at DESC, memory_id DESC);

CREATE INDEX memories_by_recall_count ON memories (user_id, recall_count DESC, name);

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

-- `memories_fts` is an external-content table, so a row deleted from `memories` leaves its terms
-- behind under a rowid that no longer names it.
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, name, description, body)
  VALUES ('delete', old.memory_seq, old.name, old.description, old.body);
END;

CREATE TRIGGER memories_fts_update AFTER UPDATE OF name, description, body ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, name, description, body)
  VALUES ('delete', old.memory_seq, old.name, old.description, old.body);
  INSERT INTO memories_fts (rowid, name, description, body) VALUES (new.memory_seq, new.name, new.description, new.body);
END;

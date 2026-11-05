-- What the account has published, one row per artifact. The bytes live in R2 under
-- `<user id>/<name>/<rev>/<path>`, and `rev` is what makes a publish atomic: the new revision's
-- files are written under a prefix no reader can reach, and the row moving forward is the publish.
-- Revision 0 names the pre-container layout, where the bytes sit at the bare `<user id>/<name>`.
--
-- `files` is read whole by the one page that renders the artifact and written whole by every
-- publish, and no query filters, orders or joins on a file, so the list is a JSON array here
-- rather than a second table; `file_count` and `bytes` are denormalised because one page of the
-- listing is one read.
CREATE TABLE artifacts (
  artifact_seq INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rev INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('site', 'document', 'audio')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  read_perm TEXT NOT NULL CHECK (read_perm IN ('private', 'account')),
  write_perm TEXT NOT NULL CHECK (write_perm IN ('owner', 'account')),
  entry_path TEXT NOT NULL,
  files TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_writer_user_id TEXT NOT NULL,
  UNIQUE (user_id, name)
);

-- Which revision the next publish of a name owns. A publish claims one here before a byte lands,
-- so two publishes racing under one name stream into prefixes of their own and neither can write
-- into the revision the other is committing. The counter never goes back: a name unpublished and
-- published again claims a revision no earlier writer can still be streaming into. A row exists
-- for every name that has ever been published, which is why the claim is an upsert and not an
-- update — a first publish has no artifact row to count from.
CREATE TABLE artifact_revisions (
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rev_next INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
) WITHOUT ROWID;

CREATE INDEX artifacts_by_updated ON artifacts (user_id, updated_at DESC, name);
CREATE INDEX artifacts_by_bytes ON artifacts (user_id, bytes DESC, name);

-- Resolving a name on the artifact hostname that the reader does not own. The hostname has no user
-- segment in its address space, so an account-readable name is looked up across the deployment.
CREATE INDEX artifacts_account_readable ON artifacts (name) WHERE read_perm = 'account';

CREATE VIRTUAL TABLE artifacts_fts USING fts5 (
  name,
  title,
  description,
  content = 'artifacts',
  content_rowid = 'artifact_seq',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts (rowid, name, title, description)
  VALUES (new.artifact_seq, new.name, new.title, new.description);
END;

CREATE TRIGGER artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts (artifacts_fts, rowid, name, title, description)
  VALUES ('delete', old.artifact_seq, old.name, old.title, old.description);
END;

CREATE TRIGGER artifacts_fts_update AFTER UPDATE OF name, title, description ON artifacts BEGIN
  INSERT INTO artifacts_fts (artifacts_fts, rowid, name, title, description)
  VALUES ('delete', old.artifact_seq, old.name, old.title, old.description);
  INSERT INTO artifacts_fts (rowid, name, title, description)
  VALUES (new.artifact_seq, new.name, new.title, new.description);
END;

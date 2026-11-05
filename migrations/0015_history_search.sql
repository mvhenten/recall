-- History's search index. It stores its own copy of the text rather than pointing at the rows:
-- `session_history` is keyed by (user_id, session_id) and carries no INTEGER PRIMARY KEY for
-- `content_rowid` to name, and SQLite cannot add one with ALTER TABLE.
--
-- Triggers keep it rather than Worker code, so the history write does not change and the index
-- stays right whoever writes the table. The rows already on record are backfilled once below,
-- which is why the search covers everything from its first request.
CREATE VIRTUAL TABLE session_history_fts USING fts5 (
  session_id UNINDEXED,
  user_id UNINDEXED,
  focus_first,
  focus_latest,
  commit_subject,
  agent_name,
  tokenize = 'porter unicode61'
);

-- The history write is an INSERT OR REPLACE, and SQLite fires a delete trigger for the row a
-- REPLACE displaced only where recursive triggers are on. So the insert clears the session's row
-- itself: one session keeps one row here however many times it syncs. Every clause names the whole
-- key, `(user_id, session_id)`, which is what the table is keyed by, so one account's write never
-- clears another account's row.
CREATE TRIGGER session_history_fts_insert AFTER INSERT ON session_history BEGIN
  DELETE FROM session_history_fts WHERE user_id = new.user_id AND session_id = new.session_id;
  INSERT INTO session_history_fts (session_id, user_id, focus_first, focus_latest, commit_subject, agent_name)
  VALUES (new.session_id, new.user_id, new.focus_first, new.focus_latest, new.commit_subject, new.agent_name);
END;

CREATE TRIGGER session_history_fts_delete AFTER DELETE ON session_history BEGIN
  DELETE FROM session_history_fts WHERE user_id = old.user_id AND session_id = old.session_id;
END;

CREATE TRIGGER session_history_fts_update
AFTER UPDATE OF focus_first, focus_latest, commit_subject, agent_name ON session_history BEGIN
  DELETE FROM session_history_fts WHERE user_id = old.user_id AND session_id = old.session_id;
  INSERT INTO session_history_fts (session_id, user_id, focus_first, focus_latest, commit_subject, agent_name)
  VALUES (new.session_id, new.user_id, new.focus_first, new.focus_latest, new.commit_subject, new.agent_name);
END;

INSERT INTO session_history_fts (session_id, user_id, focus_first, focus_latest, commit_subject, agent_name)
SELECT session_id, user_id, focus_first, focus_latest, commit_subject, agent_name FROM session_history;

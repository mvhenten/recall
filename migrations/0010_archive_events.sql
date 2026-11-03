-- The indexer had a queue of its own: a partial index over the sessions whose archive had run
-- past what the index read, ordered by the pass that last took each on, and walked by a cron
-- tick. The storage event that writes a stretch now carries the index work with it, so there is
-- nothing left to ask and nothing left to order.
DROP INDEX session_index_due;

ALTER TABLE session_index DROP COLUMN indexed_at;

-- `transcript_files` is left where it is and nothing reads or writes it from here. The migration
-- runs against the deployment already serving, which still claims a row there on every append, so
-- dropping the table in this release would answer those calls 500 until the new Worker is live.
-- The drop follows in its own release, once nothing deployed can reach it.

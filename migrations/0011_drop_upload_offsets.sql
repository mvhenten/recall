-- The schema `0010` left standing for the length of its own deploy window. The Worker that
-- named either of these is gone, so both drops are bare.
DROP TABLE transcript_files;

ALTER TABLE session_index DROP COLUMN indexed_at;

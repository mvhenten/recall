-- One grant of read access to one artifact. A link share holds its token's SHA-256 in `subject` and
-- an email share holds one lower-cased address there; `mode` is what gives the column its meaning,
-- and two columns with one of them always empty is what that avoids.
--
-- Every column is mandatory and none holds a sentinel: `last_used_at` equals `created_at` on a
-- share nobody has opened and `uses` reads zero, so "never opened" is a count rather than an
-- absent field. A share is keyed to the artifact's owner and its name, which a republish leaves
-- alone and an unpublish takes with it.
--
-- Liveness is a predicate on every read — `expires_at > ?` — and never a state a row is moved
-- into, because moving it would need something to notice it was due. Nothing in this feature asks
-- storage what is due: an expired row is invisible everywhere and is deleted only by a read of its
-- own address, a revoke, a create for the same subject, or the unpublish of its artifact.
CREATE TABLE artifact_shares (
  share_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('link', 'email')),
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  uses INTEGER NOT NULL
) WITHOUT ROWID;

-- Resolving a link share by its token's hash, which is the whole of that lane's credential.
CREATE UNIQUE INDEX artifact_shares_by_token ON artifact_shares (subject) WHERE mode = 'link';

-- One link share per artifact, refused here rather than in a check the Worker can race.
CREATE UNIQUE INDEX artifact_shares_one_link ON artifact_shares (user_id, name) WHERE mode = 'link';

-- One row per (artifact, subject), which is the conflict target the create upserts onto: sharing
-- the same address twice moves the expiry rather than writing a second row.
CREATE UNIQUE INDEX artifact_shares_by_subject ON artifact_shares (user_id, name, mode, subject);

-- One artifact's shares, and the counts the owner's bar and the Artifacts row print. `'link'`
-- sorts after `'email'`, so `ORDER BY mode DESC, created_at` puts the link row first and the index
-- supplies the order.
CREATE INDEX artifact_shares_by_artifact ON artifact_shares (user_id, name, mode DESC, created_at);

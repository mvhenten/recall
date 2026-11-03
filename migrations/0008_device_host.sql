ALTER TABLE devices ADD COLUMN host TEXT NOT NULL DEFAULT '';

-- A login is named for the machine it was made from, suffixed when the account already holds that
-- name, so a machine signing in twice takes core-box and then core-box-2 under the one host
-- core-box. Stripping that suffix is what recovers the host, and it is read off the devices table
-- alone: a login writes the name it asked for while a session writes node's own hostname, so a
-- backfill reading sessions could name a host the live path never writes.
UPDATE devices SET host = COALESCE(
  (SELECT base.name FROM devices base
     WHERE base.user_id = devices.user_id AND base.name <> devices.name
       AND devices.name GLOB base.name || '-[0-9]*'),
  name
);

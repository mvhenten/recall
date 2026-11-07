-- The name of the login a session runs under, kept on the session itself. `session_history`
-- already carries it; `sessions` read it off `devices` with a join, and a listing or a sync is the
-- hottest path there is. The tenant's sessions and the account's devices are about to live in two
-- stores, where that join would be a read across them on every call.
ALTER TABLE sessions ADD COLUMN device_name TEXT NOT NULL DEFAULT '';

UPDATE sessions
SET device_name = COALESCE(
  (SELECT d.name FROM devices d WHERE d.user_id = sessions.user_id AND d.device_id = sessions.device_id), '');

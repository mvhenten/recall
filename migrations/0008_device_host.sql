ALTER TABLE devices ADD COLUMN host TEXT NOT NULL DEFAULT '';

-- A device's name is suffixed when the account already holds that name, so the second login from
-- one machine is named core-box-2 while everything keyed on the raw host still says core-box. The
-- sessions a device has run carry that raw host, newest first, and a device that has run none
-- falls back to the name it was given.
UPDATE devices SET host = COALESCE(
  (SELECT history.host FROM session_history history
    WHERE history.user_id = devices.user_id AND history.device_id = devices.device_id AND history.host <> ''
    ORDER BY history.last_activity_at DESC LIMIT 1),
  (SELECT live.host FROM sessions live
    WHERE live.user_id = devices.user_id AND live.device_id = devices.device_id AND live.host <> ''
    ORDER BY live.last_activity_at DESC LIMIT 1),
  name
);

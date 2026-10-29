DROP TABLE principals;

CREATE TABLE principals (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE device_codes (
  device_code_sha256 TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  interval_s INTEGER NOT NULL,
  last_polled_at INTEGER NOT NULL
);

CREATE INDEX device_codes_by_expiry ON device_codes (expires_at);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX devices_by_user ON devices (user_id, created_at);

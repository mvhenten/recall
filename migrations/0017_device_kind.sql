-- A host signs in with a device token and runs sessions; a connector answers for one Access
-- identity and runs none. Everything that lists, addresses or revokes a machine reads hosts alone,
-- so a connector is a device without ever reading as one of the user's machines.
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'host';

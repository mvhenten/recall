-- Which account a name on the artifact hostname belongs to. The hostname has no user segment, so
-- the address space of names is the deployment's and not an account's: this row is the claim on
-- one of them, and resolving a name is this one read followed by that account's own object.
--
-- The claim is what the second publish of an account-readable name is refused by. It replaces a
-- read of every account's rows ordered by user id, which was a cross-tenant read and a tie-break
-- nobody was told about. What the name holds is in the tenant object; nothing but the claim is
-- here.
CREATE TABLE artifact_names (
  name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  read_perm TEXT NOT NULL CHECK (read_perm IN ('private', 'account'))
) WITHOUT ROWID;

-- Which account an Access service token acts for. It was a JSON object in the Worker's env, which
-- made adding a tenant to the connector a config edit and a redeploy rather than a write.
CREATE TABLE mcp_clients (
  client_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
) WITHOUT ROWID;

-- `artifacts`, `artifact_revisions` and `artifacts_fts` stay where they are and are read by
-- nothing from here on: the rows are left in place so that a rollback reads them, and the tables
-- go in a step of their own once the tenant objects have held the live traffic.

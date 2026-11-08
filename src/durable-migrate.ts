// The schema of a Durable Object's own SQLite, laid down the first time anything touches it. A
// tenant comes into being empty, so the first request pays for the whole of it and every request
// after reads one row to find there is nothing to do.
//
// Creating schema on first touch is the only write a request path may make here. Nothing rewrites
// rows.

export interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS_TABLE = "__migrations";

const applied = (sql: SqlStorage): Set<string> => {
  const [table] = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATIONS_TABLE)
    .toArray();
  if (table === undefined) return new Set();
  return new Set(
    sql
      .exec<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`)
      .toArray()
      .map((row) => row.name),
  );
};

export const migrateDurableObject = (sql: SqlStorage, migrations: readonly Migration[]): void => {
  const latest = migrations.at(-1);
  if (latest === undefined) return;
  const done = applied(sql);
  if (done.has(latest.name)) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    sql.exec(migration.sql);
    sql.exec(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`, migration.name, Date.now());
  }
};

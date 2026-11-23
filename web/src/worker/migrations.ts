// Versioned schema migrations for the HymnBoard Durable Object's SQLite
// storage. Each instance migrates itself the first time it starts after a
// deploy, so a future instance per church needs nothing extra.
//
// To change the schema, append a step; never edit or reorder a released one.
// Step N takes the database from version N - 1 to version N. Keep steps
// additive (new tables and nullable columns, no renames, drops or type
// changes), so that rolling back to an older build still works on the newer
// database. (Steps written during development were squashed into step 1
// before the first production deploy; the staging database was deleted.)

export const MIGRATIONS: readonly string[] = [
  // 1: the first release.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE screens (
    id INTEGER PRIMARY KEY,
    etag TEXT NOT NULL,
    buffer BLOB NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    saved_state_writes INTEGER,
    last_seen TEXT,
    last_updated_at TEXT,
    booted_at TEXT,
    firmware_version TEXT,
    ota_status TEXT,
    ota_version TEXT,
    ota_at TEXT,
    etag_stuck_at TEXT
  );
  -- The last screen each board downloaded, and how many times in a row.
  CREATE TABLE served_screens (
    device_id TEXT NOT NULL,
    screen_id INTEGER NOT NULL,
    etag TEXT NOT NULL,
    downloads INTEGER NOT NULL,
    PRIMARY KEY (device_id, screen_id)
  );
  CREATE TABLE firmware (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    image BLOB NOT NULL
  );
  `,
];

/**
 * Brings the database up to the latest version, one transaction per step, so
 * a failed step leaves it at the last version that finished. Returns the
 * version it ends at.
 */
export function migrate(
  storage: DurableObjectStorage,
  migrations: readonly string[] = MIGRATIONS,
): number {
  const { sql } = storage;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    )
  `);
  const current = schemaVersion(sql);
  if (current > migrations.length) {
    // An older build running against a newer database (a rollback). Steps
    // only add, so carry on rather than refuse to start.
    console.warn(`Schema version ${current} is newer than this build's ${migrations.length}`);
    return current;
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    storage.transactionSync(() => {
      sql.exec(migrations[version - 1]!);
      sql.exec("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)", version);
    });
  }
  return migrations.length;
}

export function schemaVersion(sql: SqlStorage): number {
  const row = sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0];
  return row?.version ?? 0;
}

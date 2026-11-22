// Versioned schema migrations for the HymnBoard Durable Object's SQLite
// storage. Each instance migrates itself the first time it starts after a
// deploy, so a future instance per church needs nothing extra.
//
// To change the schema, append a step; never edit or reorder a released one.
// Step N takes the database from version N - 1 to version N. Keep steps
// additive (new tables and nullable columns, no renames, drops or type
// changes), so that rolling back to an older build still works on the newer
// database.

/** A step is SQL, or a function for a change that has to look first. */
export type Migration = string | ((sql: SqlStorage) => void);

export const MIGRATIONS: readonly Migration[] = [
  // 1: the first release. IF NOT EXISTS lets a database from before
  // versioning (only the hymnboard-test staging app has one) be adopted.
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS screens (
    id INTEGER PRIMARY KEY,
    etag TEXT NOT NULL,
    buffer BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    saved_state_writes INTEGER,
    last_seen TEXT,
    last_updated_at TEXT,
    booted_at TEXT,
    firmware_version TEXT,
    ota_status TEXT,
    ota_version TEXT,
    ota_at TEXT
  );
  CREATE TABLE IF NOT EXISTS firmware (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    image BLOB NOT NULL
  );
  `,
  // 2: boards that don't keep their ETag. A database from before versioning
  // may already have the column.
  (sql) => {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS served_screens (
        device_id TEXT NOT NULL,
        screen_id INTEGER NOT NULL,
        etag TEXT NOT NULL,
        downloads INTEGER NOT NULL,
        PRIMARY KEY (device_id, screen_id)
      )
    `);
    if (!hasColumn(sql, "devices", "etag_stuck_at")) {
      sql.exec("ALTER TABLE devices ADD COLUMN etag_stuck_at TEXT");
    }
  },
  // 3: a database from before versioning declared saved_state_writes TEXT,
  // which stores the numbers as strings. Only that database is rebuilt.
  (sql) => {
    const column = sql
      .exec<{ name: string; type: string }>("PRAGMA table_info(devices)")
      .toArray()
      .find((row) => row.name === "saved_state_writes");
    if (column?.type !== "TEXT") {
      return;
    }
    sql.exec(`
      CREATE TABLE devices_rebuilt (
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
      INSERT INTO devices_rebuilt
        SELECT id,
          CASE
            WHEN saved_state_writes GLOB '[0-9]*' AND saved_state_writes NOT GLOB '*[^0-9]*'
              THEN CAST(saved_state_writes AS INTEGER)
          END,
          last_seen, last_updated_at, booted_at, firmware_version,
          ota_status, ota_version, ota_at, etag_stuck_at
        FROM devices;
      DROP TABLE devices;
      ALTER TABLE devices_rebuilt RENAME TO devices;
    `);
  },
];

/**
 * Brings the database up to the latest version, one transaction per step, so
 * a failed step leaves it at the last version that finished. Returns the
 * version it ends at.
 */
export function migrate(
  storage: DurableObjectStorage,
  migrations: readonly Migration[] = MIGRATIONS,
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
    const step = migrations[version - 1]!;
    storage.transactionSync(() => {
      if (typeof step === "string") {
        sql.exec(step);
      } else {
        step(sql);
      }
      sql.exec("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)", version);
    });
  }
  return migrations.length;
}

export function schemaVersion(sql: SqlStorage): number {
  const row = sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0];
  return row?.version ?? 0;
}

function hasColumn(sql: SqlStorage, table: string, column: string): boolean {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .some((row) => row.name === column);
}

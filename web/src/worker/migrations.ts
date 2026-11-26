// Versioned schema migrations for the Durable Objects' SQLite storage: the
// HymnBoard's (MIGRATIONS) and the Accounts' (ACCOUNT_MIGRATIONS). Each
// instance migrates itself the first time it starts after a deploy (see
// migrateOnStart), so a future HymnBoard per church needs nothing extra.
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
  // 2: boards on a WebSocket. When the board's socket last opened and closed,
  // and what its panels show (a JSON array of three etags, from "shown").
  `
  ALTER TABLE devices ADD COLUMN connected_at TEXT;
  ALTER TABLE devices ADD COLUMN disconnected_at TEXT;
  ALTER TABLE devices ADD COLUMN shown_etags TEXT;
  `,
];

// The Accounts object's tables are Better Auth's, with the admin and API key
// plugins, as its own migration generator writes them for SQLite (names are
// Better Auth's, so they're quoted camelCase). A Better Auth upgrade or a new
// plugin that adds fields needs a step here; compare with
// `getMigrations(...).compileMigrations()` from better-auth/db/migration.
export const ACCOUNT_MIGRATIONS: readonly string[] = [
  // 1: the first release, users signing in with an email and password.
  `
  CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL,
    "image" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "role" TEXT,
    "banned" INTEGER,
    "banReason" TEXT,
    "banExpires" DATE
  );
  CREATE TABLE "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATE NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "impersonatedBy" TEXT
  );
  CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATE,
    "refreshTokenExpiresAt" DATE,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  );
  CREATE TABLE "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATE NOT NULL,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  );
  CREATE TABLE "apikey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "name" TEXT,
    "start" TEXT,
    "referenceId" TEXT NOT NULL,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" DATE,
    "enabled" INTEGER,
    "rateLimitEnabled" INTEGER,
    "rateLimitTimeWindow" INTEGER,
    "rateLimitMax" INTEGER,
    "requestCount" INTEGER,
    "remaining" INTEGER,
    "lastRequest" DATE,
    "expiresAt" DATE,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT
  );
  CREATE INDEX "session_userId_idx" ON "session" ("userId");
  CREATE INDEX "account_userId_idx" ON "account" ("userId");
  CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
  CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");
  CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");
  CREATE INDEX "apikey_key_idx" ON "apikey" ("key");
  `,
];

/**
 * Migrates a Durable Object's storage before it handles its first request.
 * Call it from the constructor.
 */
export function migrateOnStart(ctx: DurableObjectState, migrations: readonly string[]) {
  void ctx.blockConcurrencyWhile(() => {
    try {
      migrate(ctx.storage, migrations);
      return Promise.resolve();
    } catch (error) {
      // Otherwise only the reset of the object shows up, not the SQL error.
      console.error("Schema migration failed:", error);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

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

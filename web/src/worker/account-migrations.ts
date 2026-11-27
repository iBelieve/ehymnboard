// Versioned schema migrations for the accounts database (D1, the DB binding),
// the same way as the HymnBoard object's (migrations.ts): append a step,
// never edit or reorder a released one, keep steps additive. Each step is a
// list of statements, run as one D1 batch, which is one transaction. The
// Worker brings the database up to date the first time an isolate needs it
// (see accounts.ts), so a deploy needs no migration command of its own.
//
// The tables are Better Auth's, with the admin and API key plugins and
// rate limits kept in the database, as its own generator writes them for
// SQLite (the names are Better Auth's, so they're quoted camelCase). A Better
// Auth upgrade or a new plugin that adds fields needs a step here; compare
// with `getMigrations(...).compileMigrations()` from better-auth/db/migration.

export const ACCOUNT_MIGRATIONS: readonly (readonly string[])[] = [
  // 1: the first release, users signing in with an email and password.
  [
    `CREATE TABLE "user" (
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
    )`,
    `CREATE TABLE "session" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "expiresAt" DATE NOT NULL,
      "token" TEXT NOT NULL UNIQUE,
      "createdAt" DATE NOT NULL,
      "updatedAt" DATE NOT NULL,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
      "impersonatedBy" TEXT
    )`,
    `CREATE TABLE "account" (
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
    )`,
    `CREATE TABLE "verification" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "identifier" TEXT NOT NULL,
      "value" TEXT NOT NULL,
      "expiresAt" DATE NOT NULL,
      "createdAt" DATE NOT NULL,
      "updatedAt" DATE NOT NULL
    )`,
    `CREATE TABLE "apikey" (
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
    )`,
    `CREATE TABLE "rateLimit" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "key" TEXT NOT NULL UNIQUE,
      "count" INTEGER NOT NULL,
      "lastRequest" BIGINT NOT NULL
    )`,
    // Ours: a row while the first account's setup runs (and after), so two
    // setups at once can't both make an admin (see createFirstAccount).
    `CREATE TABLE "setup" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1), "startedAt" INTEGER NOT NULL)`,
    `CREATE INDEX "session_userId_idx" ON "session" ("userId")`,
    `CREATE INDEX "account_userId_idx" ON "account" ("userId")`,
    `CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier")`,
    `CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId")`,
    `CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId")`,
    `CREATE INDEX "apikey_key_idx" ON "apikey" ("key")`,
  ],
];

/**
 * Brings the database up to the latest version, one batch (transaction) per
 * step. Several isolates may start at once: a step another one applied first
 * fails here (its tables exist) and is skipped. Returns the version it ends at.
 */
export async function migrateDatabase(
  db: D1Database,
  migrations: readonly (readonly string[])[] = ACCOUNT_MIGRATIONS,
): Promise<number> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS "schema_version" (
        "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
        "version" INTEGER NOT NULL
      )`,
    )
    .run();
  let current = await databaseVersion(db);
  if (current > migrations.length) {
    // An older build on a newer database (a rollback): steps only add.
    console.warn(
      `Accounts schema version ${current} is newer than this build's ${migrations.length}`,
    );
    return current;
  }
  while (current < migrations.length) {
    const next = current + 1;
    try {
      await db.batch([
        ...migrations[current]!.map((statement) => db.prepare(statement)),
        db
          .prepare(
            `INSERT INTO "schema_version" ("id", "version") VALUES (1, ?)
             ON CONFLICT ("id") DO UPDATE SET "version" = excluded."version"`,
          )
          .bind(next),
      ]);
      current = next;
    } catch (error) {
      const now = await databaseVersion(db);
      if (now < next) {
        console.error(`Accounts schema migration ${next} failed:`, error);
        throw error;
      }
      current = now;
    }
  }
  return current;
}

export async function databaseVersion(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT "version" FROM "schema_version"`).first<number>("version")) ?? 0;
}

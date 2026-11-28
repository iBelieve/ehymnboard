import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { expect, test } from "vitest";
import {
  ACCOUNT_MIGRATIONS,
  databaseVersion,
  migrateDatabase,
} from "../src/worker/account-migrations";
import { authOptions } from "../src/worker/accounts";

test("brings a new database up to date, once, even from several isolates at once", async () => {
  expect(await Promise.all([migrateDatabase(env.DB), migrateDatabase(env.DB)])).toEqual([
    ACCOUNT_MIGRATIONS.length,
    ACCOUNT_MIGRATIONS.length,
  ]);
  expect(await migrateDatabase(env.DB)).toBe(ACCOUNT_MIGRATIONS.length);
  expect(await databaseVersion(env.DB)).toBe(ACCOUNT_MIGRATIONS.length);
});

test("leaves a newer database alone", async () => {
  await migrateDatabase(env.DB);
  expect(await migrateDatabase(env.DB, ACCOUNT_MIGRATIONS.slice(0, -1))).toBe(
    ACCOUNT_MIGRATIONS.length,
  );
});

test("has every table, column and index Better Auth wants", async () => {
  await migrateDatabase(env.DB);
  const options = await authOptions(env.DB, "a test secret of at least 32 characters");
  const { toBeCreated, toBeAdded, toBeAddedIndexes, schemaProblems } = await getMigrations(options);
  expect({ toBeCreated, toBeAdded, toBeAddedIndexes, schemaProblems }).toEqual({
    toBeCreated: [],
    toBeAdded: [],
    toBeAddedIndexes: [],
    schemaProblems: [],
  });
});

test("a failed step stops there, to be tried again", async () => {
  const steps = [...ACCOUNT_MIGRATIONS, [`CREATE TABLE "broken" (`]];
  await expect(migrateDatabase(env.DB, steps)).rejects.toThrow();
  expect(await databaseVersion(env.DB)).toBe(ACCOUNT_MIGRATIONS.length);
});

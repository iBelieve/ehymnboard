import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { MIGRATIONS, migrate, schemaVersion } from "../src/worker/migrations";

const LATEST = MIGRATIONS.length;
let instances = 0;

/** Runs callback in a new HymnBoard instance with its storage emptied. */
function withEmptyStorage(callback: (storage: DurableObjectStorage) => void) {
  const stub = env.HYMN_BOARD.getByName(`migrations-${++instances}`);
  return runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .toArray();
    for (const { name } of tables) {
      sql.exec(`DROP TABLE ${name}`);
    }
    callback(state.storage);
  });
}

function columns(sql: SqlStorage, table: string) {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .map((row) => row.name);
}

test("a new instance starts at the latest version", async () => {
  const stub = env.HYMN_BOARD.getByName(`migrations-${++instances}`);
  await runInDurableObject(stub, (_instance, state) => {
    expect(schemaVersion(state.storage.sql)).toBe(LATEST);
    expect(columns(state.storage.sql, "devices")).toContain("etag_stuck_at");
    expect(columns(state.storage.sql, "served_screens")).toContain("downloads");
  });
});

test("migrates an empty database to the latest version", async () => {
  await withEmptyStorage((storage) => {
    expect(migrate(storage)).toBe(LATEST);
    expect(schemaVersion(storage.sql)).toBe(LATEST);
  });
});

test("upgrades an older version and keeps its data", async () => {
  const next = [...MIGRATIONS, "ALTER TABLE devices ADD COLUMN extra TEXT"];
  await withEmptyStorage((storage) => {
    expect(migrate(storage)).toBe(LATEST);
    storage.sql.exec("INSERT INTO devices (id, last_seen) VALUES ('LEFT', '2026-11-22')");

    expect(migrate(storage, next)).toBe(LATEST + 1);
    expect(storage.sql.exec("SELECT * FROM devices").toArray()).toEqual([
      expect.objectContaining({ id: "LEFT", last_seen: "2026-11-22", extra: null }),
    ]);
  });
});

test("running again changes nothing", async () => {
  await withEmptyStorage((storage) => {
    migrate(storage);
    expect(migrate(storage)).toBe(LATEST);
    expect(storage.sql.exec("SELECT id, version FROM schema_version").toArray()).toEqual([
      { id: 1, version: LATEST },
    ]);
  });
});

test("a failing step leaves the last version that finished", async () => {
  const broken = [
    ...MIGRATIONS,
    "CREATE TABLE half_done (id INTEGER); INSERT INTO no_such_table VALUES (1);",
  ];
  await withEmptyStorage((storage) => {
    expect(() => migrate(storage, broken)).toThrow(/no_such_table/);
    expect(schemaVersion(storage.sql)).toBe(LATEST);
    expect(columns(storage.sql, "half_done")).toEqual([]);
  });
});

test("leaves a newer database alone", async () => {
  await withEmptyStorage((storage) => {
    migrate(storage);
    storage.sql.exec("UPDATE schema_version SET version = ?", LATEST + 1);
    expect(migrate(storage)).toBe(LATEST + 1);
  });
});

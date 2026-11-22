import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { MIGRATIONS, migrate, schemaVersion, type Migration } from "../src/worker/migrations";

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
  await withEmptyStorage((storage) => {
    expect(migrate(storage, MIGRATIONS.slice(0, 1))).toBe(1);
    storage.sql.exec("INSERT INTO devices (id, last_seen) VALUES ('LEFT', '2026-11-22')");
    expect(columns(storage.sql, "devices")).not.toContain("etag_stuck_at");

    expect(migrate(storage)).toBe(LATEST);
    expect(storage.sql.exec("SELECT * FROM devices").toArray()).toEqual([
      expect.objectContaining({ id: "LEFT", last_seen: "2026-11-22", etag_stuck_at: null }),
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

test("adopts a database from before versioning", async () => {
  for (const stuckColumn of [false, true]) {
    await withEmptyStorage((storage) => {
      migrate(storage, MIGRATIONS.slice(0, 1));
      storage.sql.exec("DROP TABLE schema_version");
      if (stuckColumn) {
        storage.sql.exec("ALTER TABLE devices ADD COLUMN etag_stuck_at TEXT");
      }
      storage.sql.exec("INSERT INTO settings (key, value) VALUES ('lines', '[]')");

      expect(migrate(storage)).toBe(LATEST);
      expect(columns(storage.sql, "devices")).toContain("etag_stuck_at");
      expect(storage.sql.exec("SELECT value FROM settings").toArray()).toEqual([{ value: "[]" }]);
    });
  }
});

test("converts a pre-versioning saved_state_writes TEXT column to INTEGER", async () => {
  await withEmptyStorage((storage) => {
    // The first release's devices table.
    storage.sql.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, saved_state_writes TEXT, last_seen TEXT,
        last_updated_at TEXT, booted_at TEXT, firmware_version TEXT,
        ota_status TEXT, ota_version TEXT, ota_at TEXT
      );
      INSERT INTO devices (id, saved_state_writes, last_seen)
        VALUES ('LEFT', '42', '2026-11-22'), ('RIGHT', 'lots', NULL);
    `);

    expect(migrate(storage)).toBe(LATEST);
    const devices = storage.sql.exec("SELECT * FROM devices ORDER BY id").toArray();
    expect(devices).toEqual([
      expect.objectContaining({ id: "LEFT", saved_state_writes: 42, last_seen: "2026-11-22" }),
      expect.objectContaining({ id: "RIGHT", saved_state_writes: null }),
    ]);
    storage.sql.exec("UPDATE devices SET saved_state_writes = ? WHERE id = 'RIGHT'", 7);
    expect(
      storage.sql
        .exec("SELECT typeof(saved_state_writes) AS t FROM devices WHERE id = 'RIGHT'")
        .one(),
    ).toEqual({ t: "integer" });
  });
});

test("a failing step leaves the last version that finished", async () => {
  const broken: Migration[] = [
    MIGRATIONS[0]!,
    "CREATE TABLE half_done (id INTEGER); INSERT INTO no_such_table VALUES (1);",
  ];
  await withEmptyStorage((storage) => {
    expect(() => migrate(storage, broken)).toThrow(/no_such_table/);
    expect(schemaVersion(storage.sql)).toBe(1);
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

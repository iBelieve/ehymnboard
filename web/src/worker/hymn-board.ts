import { DurableObject } from "cloudflare:workers";
import { getFont } from "../shared/font";
import { renderScreen } from "../shared/render";
import { EMPTY_LINES, isLines, linesForScreen, SCREEN_COUNT, type Lines } from "../shared/screen";
import type { Device, DeviceStatusParams, FirmwareInfo } from "../shared/api";

// Column names are interpolated into SQL, so only these are accepted.
const DEVICE_FIELDS = new Set([
  "saved_state_writes",
  "last_seen",
  "last_updated_at",
  "booted_at",
  "firmware_version",
  "ota_status",
  "ota_version",
  "ota_at",
]);

type ScreenRow = { id: number; etag: string; buffer: ArrayBuffer };
type FirmwareRow = FirmwareInfo & { image: ArrayBuffer };

export type ImageResult =
  { status: 304; etag: string } | { status: 200; etag: string; buffer: ArrayBuffer };

/**
 * The state behind one set of hymn boards: the six lines, the three rendered
 * screens, what each device last reported, and the OTA firmware image. Both
 * physical boards share this one instance, so every update goes through a
 * single place (and later, a single WebSocket hub).
 */
export class HymnBoard extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
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
        saved_state_writes TEXT,
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
    `);
  }

  getLines(): Lines {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'lines'")
      .toArray()[0];
    const lines: unknown = row ? JSON.parse(row.value) : undefined;
    return isLines(lines) ? lines : [...EMPTY_LINES];
  }

  /** Renders and stores all three screens, then saves the lines. */
  async setLines(lines: Lines): Promise<void> {
    const font = getFont();
    for (let id = 1; id <= SCREEN_COUNT; id++) {
      const [line1, line2] = linesForScreen(lines, id);
      await this.storeScreen(id, renderScreen(font, line1, line2));
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('lines', ?)",
      JSON.stringify(lines),
    );
  }

  async getScreen(id: number): Promise<{ etag: string; buffer: ArrayBuffer }> {
    const row = this.sql
      .exec<ScreenRow>("SELECT id, etag, buffer FROM screens WHERE id = ?", id)
      .toArray()[0];
    if (row) {
      return row;
    }
    // Never rendered (a fresh install): render it from the saved lines.
    const [line1, line2] = linesForScreen(this.getLines(), id);
    return this.storeScreen(id, renderScreen(getFont(), line1, line2));
  }

  getScreenEtags(): { id: number; etag: string }[] {
    return this.sql
      .exec<{ id: number; etag: string }>("SELECT id, etag FROM screens ORDER BY id")
      .toArray();
  }

  /**
   * A device polling for a screen. Answers 304 when its etag is current, and
   * records that the device was seen either way.
   */
  async fetchImage(
    id: number,
    etag: string | undefined,
    status: DeviceStatusParams,
  ): Promise<ImageResult> {
    const screen = await this.getScreen(id);
    const now = new Date().toISOString();
    const updated = etag !== screen.etag;

    if (status.device_id) {
      this.updateDevice(status.device_id, {
        saved_state_writes: status.saved_state_writes,
        last_seen: now,
        last_updated_at: updated ? now : undefined,
      });
    }

    return updated
      ? { status: 200, etag: screen.etag, buffer: screen.buffer }
      : { status: 304, etag: screen.etag };
  }

  updateDevice(id: string, fields: Partial<Omit<Device, "id">>): void {
    // Only overwrite the fields that were given, like the Flask server did.
    const entries = Object.entries(fields).filter(
      (entry): entry is [string, string] =>
        DEVICE_FIELDS.has(entry[0]) && typeof entry[1] === "string",
    );
    this.sql.exec("INSERT OR IGNORE INTO devices (id) VALUES (?)", id);
    if (entries.length > 0) {
      this.sql.exec(
        `UPDATE devices SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
        ...entries.map(([, value]) => value),
        id,
      );
    }
  }

  getDevices(): Device[] {
    return this.sql.exec<Device>("SELECT * FROM devices").toArray();
  }

  getFirmwareInfo(): FirmwareInfo | null {
    return (
      this.sql
        .exec<FirmwareInfo>("SELECT version, size, sha256, uploaded_at FROM firmware WHERE id = 1")
        .toArray()[0] ?? null
    );
  }

  getFirmwareImage(): FirmwareRow | null {
    return this.sql.exec<FirmwareRow>("SELECT * FROM firmware WHERE id = 1").toArray()[0] ?? null;
  }

  async saveFirmware(version: string, image: ArrayBuffer): Promise<FirmwareInfo> {
    const digest = await crypto.subtle.digest("SHA-256", image);
    const info: FirmwareInfo = {
      version,
      size: image.byteLength,
      sha256: toHex(digest),
      uploaded_at: new Date().toISOString(),
    };
    this.sql.exec(
      `INSERT OR REPLACE INTO firmware (id, version, size, sha256, uploaded_at, image)
       VALUES (1, ?, ?, ?, ?, ?)`,
      info.version,
      info.size,
      info.sha256,
      info.uploaded_at,
      image,
    );
    return info;
  }

  private async storeScreen(id: number, bytes: Uint8Array) {
    const buffer = bytes.slice().buffer;
    // SHA-1 because the device stores a 40-character etag.
    const etag = toHex(await crypto.subtle.digest("SHA-1", buffer));
    this.sql.exec(
      "INSERT OR REPLACE INTO screens (id, etag, buffer) VALUES (?, ?, ?)",
      id,
      etag,
      buffer,
    );
    return { etag, buffer };
  }
}

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

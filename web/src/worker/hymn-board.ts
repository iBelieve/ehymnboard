import { DurableObject } from "cloudflare:workers";
import { getFont } from "../shared/font";
import { renderScreen } from "../shared/render";
import { EMPTY_LINES, isLines, linesForScreen, SCREEN_COUNT, type Lines } from "../shared/screen";
import type { Device, DeviceStatusParams, FirmwareInfo } from "../shared/api";
import { migrate } from "./migrations";

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

// A board that keeps downloading the same image never kept its ETag (say, a
// header it can't parse), so it redraws every poll. Flag it after this many
// identical downloads in a row; one or two can be a cut-off download or a
// reset of the board's saved state.
export const STUCK_ETAG_DOWNLOADS = 3;

type StoredScreen = { etag: string; buffer: ArrayBuffer };
type ScreenRow = StoredScreen & { id: number };
type FirmwareRow = FirmwareInfo & { image: ArrayBuffer };

export type ImageResult =
  | { status: 304; etag: string }
  | {
      status: 200;
      etag: string;
      buffer: ArrayBuffer;
      /** True only on the download that newly flags the board as stuck. */
      etagStuck: boolean;
    };

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
    // Each instance migrates itself before it handles its first request.
    void ctx.blockConcurrencyWhile(() => {
      try {
        migrate(ctx.storage);
        return Promise.resolve();
      } catch (error) {
        // Otherwise only the reset of the object shows up, not the SQL error.
        console.error("Schema migration failed:", error);
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  getLines(): Lines {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'lines'")
      .toArray()[0];
    const lines: unknown = row ? JSON.parse(row.value) : undefined;
    return isLines(lines) ? lines : [...EMPTY_LINES];
  }

  /**
   * Renders all three screens, then stores them and the lines in one
   * transaction, so a board never sees a mix of old and new screens.
   */
  async setLines(lines: Lines): Promise<void> {
    const font = getFont();
    const screens = await Promise.all(
      Array.from({ length: SCREEN_COUNT }, (_, i) =>
        hashScreen(renderScreen(font, ...linesForScreen(lines, i + 1))),
      ),
    );
    this.ctx.storage.transactionSync(() => {
      screens.forEach((screen, i) => this.writeScreen(i + 1, screen));
      this.sql.exec(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('lines', ?)",
        JSON.stringify(lines),
      );
    });
  }

  async getScreen(id: number): Promise<StoredScreen> {
    const row = this.sql
      .exec<ScreenRow>("SELECT id, etag, buffer FROM screens WHERE id = ?", id)
      .toArray()[0];
    if (row) {
      return row;
    }
    // Never rendered (a fresh install): render it from the saved lines.
    const [line1, line2] = linesForScreen(this.getLines(), id);
    const screen = await hashScreen(renderScreen(getFont(), line1, line2));
    this.writeScreen(id, screen);
    return screen;
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

    let etagStuck = false;
    if (status.device_id) {
      this.updateDevice(status.device_id, {
        saved_state_writes: status.saved_state_writes,
        last_seen: now,
        last_updated_at: updated ? now : undefined,
      });
      etagStuck = this.trackDownload(status.device_id, id, updated ? screen.etag : undefined, now);
    }

    return updated
      ? { status: 200, etag: screen.etag, buffer: screen.buffer, etagStuck }
      : { status: 304, etag: screen.etag };
  }

  /**
   * Counts identical downloads of a screen by a board (servedEtag is undefined
   * for a 304). Returns true when this download newly flags the board as not
   * keeping its ETag. A stuck screen stays stuck through new images until the
   * board answers it with a 304, and the flag clears once none of its screens
   * are stuck.
   */
  private trackDownload(
    deviceId: string,
    screenId: number,
    servedEtag: string | undefined,
    now: string,
  ): boolean {
    if (servedEtag === undefined) {
      this.sql.exec(
        "DELETE FROM served_screens WHERE device_id = ? AND screen_id = ?",
        deviceId,
        screenId,
      );
      const stillStuck = this.sql
        .exec(
          "SELECT 1 FROM served_screens WHERE device_id = ? AND downloads >= ?",
          deviceId,
          STUCK_ETAG_DOWNLOADS,
        )
        .toArray();
      if (stillStuck.length === 0) {
        this.sql.exec("UPDATE devices SET etag_stuck_at = NULL WHERE id = ?", deviceId);
      }
      return false;
    }

    const previous = this.sql
      .exec<{ etag: string; downloads: number }>(
        "SELECT etag, downloads FROM served_screens WHERE device_id = ? AND screen_id = ?",
        deviceId,
        screenId,
      )
      .toArray()[0];
    let downloads = 1;
    if (previous?.etag === servedEtag) {
      downloads = previous.downloads + 1;
    } else if (previous && previous.downloads >= STUCK_ETAG_DOWNLOADS) {
      downloads = STUCK_ETAG_DOWNLOADS;
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO served_screens (device_id, screen_id, etag, downloads) VALUES (?, ?, ?, ?)",
      deviceId,
      screenId,
      servedEtag,
      downloads,
    );
    if (downloads < STUCK_ETAG_DOWNLOADS) {
      return false;
    }
    const update = this.sql.exec(
      "UPDATE devices SET etag_stuck_at = ? WHERE id = ? AND etag_stuck_at IS NULL",
      now,
      deviceId,
    );
    update.toArray();
    return update.rowsWritten > 0;
  }

  updateDevice(id: string, fields: Partial<Omit<Device, "id">>): void {
    // Only overwrite the fields that were given, like the Flask server did.
    const entries = Object.entries(fields).filter(
      (entry): entry is [string, string | number] =>
        DEVICE_FIELDS.has(entry[0]) &&
        (typeof entry[1] === "string" || typeof entry[1] === "number"),
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

  private writeScreen(id: number, { etag, buffer }: StoredScreen): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO screens (id, etag, buffer) VALUES (?, ?, ?)",
      id,
      etag,
      buffer,
    );
  }
}

async function hashScreen(bytes: Uint8Array): Promise<StoredScreen> {
  const buffer = bytes.slice().buffer;
  // SHA-1 because the device stores a 40-character etag.
  return { etag: toHex(await crypto.subtle.digest("SHA-1", buffer)), buffer };
}

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

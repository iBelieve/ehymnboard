import { DurableObject } from "cloudflare:workers";
import { getFont } from "../shared/font";
import { renderScreen } from "../shared/render";
import { EMPTY_LINES, isLines, linesForScreen, SCREEN_COUNT, type Lines } from "../shared/screen";
import type { Device, DeviceStatusParams, FirmwareInfo } from "../shared/api";
import { getDeviceName, healthchecksOn, pingHealthcheck } from "./devices";
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
  "connected_at",
  "shown_etags",
]);

// The board protocol over the WebSocket (see device/src/board_messages.h):
// the server sends "state 1 <etag1> <etag2> <etag3> <firmware or ->" when the
// socket opens and whenever any of it changes; the board sends "ping" every
// 30 s (answered with "pong" by the runtime, without waking this object) and
// "shown <etag1> <etag2> <etag3>" once its panels match a state.
const STATE_VERSION = 1;
const PING = "ping";
const PONG = "pong";
const NO_FIRMWARE = "-";
/** Close code for a socket that a newer one from the same board replaced. */
export const CLOSE_REPLACED = 4000;
/** Close code for a socket that stopped pinging. */
export const CLOSE_SILENT = 4001;

/**
 * A board pings every 30 s, so a socket silent this long is dead (the board
 * gives up on it after 40 s without a pong). Up to here, it counts as live.
 */
export const SOCKET_SILENT_MS = 90_000;
/** How often the alarm pings healthchecks.io for each live board. */
export const HEALTH_INTERVAL_MS = 10 * 60_000;

/** What each socket remembers through hibernation. */
type SocketAttachment = { deviceId: string; connectedAt: number };

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
    // Answered by the runtime, so a board's pings never wake this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
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
    await this.broadcastState();
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

  /**
   * Every board the server has heard from, with whether its socket is live.
   * A live board's last ping counts as seeing it.
   */
  getDevices(): (Device & { live: boolean })[] {
    const seen = new Map<string, number>();
    for (const ws of this.openSockets()) {
      const attachment = attachmentOf(ws);
      const at = this.lastHeardFrom(ws);
      if (attachment && at !== undefined && Date.now() - at < SOCKET_SILENT_MS) {
        seen.set(attachment.deviceId, Math.max(at, seen.get(attachment.deviceId) ?? 0));
      }
    }
    return this.sql
      .exec<Device>("SELECT * FROM devices")
      .toArray()
      .map((device) => {
        const pinged = seen.get(device.id);
        const stored = device.last_seen ? Date.parse(device.last_seen) : 0;
        const lastSeen =
          pinged !== undefined && pinged > stored
            ? new Date(pinged).toISOString()
            : device.last_seen;
        return { ...device, last_seen: lastSeen, live: pinged !== undefined };
      });
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
    await this.broadcastState();
    return info;
  }

  // -------------------------------------------------------------------------
  // Board WebSockets (the Hibernation API: the object can be evicted between
  // messages while the sockets stay open)
  // -------------------------------------------------------------------------

  /**
   * A board's upgrade request, already checked by the Worker (a known
   * device_id and an Upgrade header). Accepts the socket, closes any older
   * one from the same board, and sends the board its state.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get("device_id") ?? "";
    const firmwareVersion = url.searchParams.get("firmware_version") ?? undefined;
    const writes = url.searchParams.get("saved_state_writes");
    const now = Date.now();

    for (const old of this.openSockets(deviceId)) {
      closeQuietly(old, CLOSE_REPLACED, "replaced by a newer socket");
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({ deviceId, connectedAt: now } satisfies SocketAttachment);

    const at = new Date(now).toISOString();
    this.updateDevice(deviceId, {
      last_seen: at,
      connected_at: at,
      firmware_version: firmwareVersion,
      saved_state_writes: writes !== null && /^\d+$/.test(writes) ? Number(writes) : undefined,
    });
    console.log(`Device socket connected: ${getDeviceName(deviceId)} (${deviceId})`);
    this.ctx.waitUntil(this.ping(deviceId, "", "Socket connected"));

    server.send(await this.stateMessage());
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + HEALTH_INTERVAL_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The state message every board gets: its screens and the firmware to run. */
  async stateMessage(): Promise<string> {
    const screens = await Promise.all(
      Array.from({ length: SCREEN_COUNT }, (_, i) => this.getScreen(i + 1)),
    );
    const firmware = this.getFirmwareInfo()?.version ?? NO_FIRMWARE;
    return ["state", STATE_VERSION, ...screens.map((screen) => screen.etag), firmware].join(" ");
  }

  /** Sends the current state to every board's socket. */
  async broadcastState(): Promise<void> {
    const sockets = this.openSockets();
    if (sockets.length === 0) {
      return;
    }
    const message = await this.stateMessage();
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Closing; the board gets the state when it reconnects
      }
    }
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const attachment = attachmentOf(ws);
    if (!attachment || typeof message !== "string") {
      return;
    }
    const at = new Date().toISOString();
    // Normally answered by the auto-response; here only if it raced the setup
    if (message === PING) {
      ws.send(PONG);
      this.updateDevice(attachment.deviceId, { last_seen: at });
      return;
    }
    const shown = /^shown ([0-9A-Za-z-]+) ([0-9A-Za-z-]+) ([0-9A-Za-z-]+)$/.exec(message);
    if (shown) {
      this.updateDevice(attachment.deviceId, {
        last_seen: at,
        shown_etags: JSON.stringify(shown.slice(1, 4)),
      });
      return;
    }
    console.log(`Ignoring message from ${attachment.deviceId}: ${message.slice(0, 80)}`);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // Complete the closing handshake (a no-op if the runtime already did)
    closeQuietly(ws, code, reason);
    this.socketGone(ws, `code ${code}${reason ? `, ${reason}` : ""}`);
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    this.socketGone(ws, `error ${String(error)}`);
  }

  /**
   * Every 10 minutes while any board is connected: pings healthchecks.io for
   * each live board (the board itself no longer does), and closes sockets
   * that stopped pinging.
   */
  override async alarm(): Promise<void> {
    const live = new Set<string>();
    for (const ws of this.openSockets()) {
      const attachment = attachmentOf(ws);
      const at = this.lastHeardFrom(ws);
      if (!attachment || at === undefined || Date.now() - at >= SOCKET_SILENT_MS) {
        closeQuietly(ws, CLOSE_SILENT, "no ping");
        continue;
      }
      live.add(attachment.deviceId);
    }
    const at = new Date().toISOString();
    for (const deviceId of live) {
      this.updateDevice(deviceId, { last_seen: at });
    }
    await Promise.all([...live].map((id) => this.ping(id, "", "Socket live")));
    if (this.openSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + HEALTH_INTERVAL_MS);
    }
  }

  /** Pings the board's healthchecks.io check, when HEALTHCHECKS=on. */
  private async ping(...args: Parameters<typeof pingHealthcheck>): Promise<void> {
    if (healthchecksOn(this.env)) {
      await pingHealthcheck(...args);
    }
  }

  /**
   * The sockets still open. One the server closed (replaced, or silent)
   * stays listed until its board answers the close, which a board that's
   * gone never does, so it doesn't count.
   */
  private openSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** When the board on this socket was last heard from (ms since the epoch). */
  private lastHeardFrom(ws: WebSocket): number | undefined {
    const attachment = attachmentOf(ws);
    if (!attachment) {
      return undefined;
    }
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(pinged, attachment.connectedAt);
  }

  private socketGone(ws: WebSocket, why: string): void {
    const attachment = attachmentOf(ws);
    if (!attachment) {
      return;
    }
    const { deviceId } = attachment;
    const name = getDeviceName(deviceId);
    console.log(`Device socket closed (${why}): ${name} (${deviceId})`);
    if (this.openSockets(deviceId).some((other) => other !== ws)) {
      // A newer socket replaced it: the board never went away
      return;
    }
    const at = new Date().toISOString();
    this.sql.exec("UPDATE devices SET disconnected_at = ? WHERE id = ?", at, deviceId);
    this.ctx.waitUntil(this.ping(deviceId, "/log", `Socket closed (${why})`));
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

function attachmentOf(ws: WebSocket): SocketAttachment | undefined {
  const attachment: unknown = ws.deserializeAttachment();
  if (
    typeof attachment === "object" &&
    attachment !== null &&
    "deviceId" in attachment &&
    "connectedAt" in attachment &&
    typeof attachment.deviceId === "string" &&
    typeof attachment.connectedAt === "number"
  ) {
    return { deviceId: attachment.deviceId, connectedAt: attachment.connectedAt };
  }
  return undefined;
}

/** Closes a socket, ignoring one that's already closed or a code it can't send. */
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  const sendable = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);
  try {
    if (sendable) {
      ws.close(code, reason);
    } else {
      ws.close();
    }
  } catch {
    // Already closed
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

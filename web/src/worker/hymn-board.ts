import { DurableObject } from "cloudflare:workers";
import { getFont } from "../shared/font";
import { renderScreen } from "../shared/render";
import { EMPTY_LINES, isLines, linesForScreen, SCREEN_COUNT, type Lines } from "../shared/screen";
import type {
  BoardHealth,
  Device,
  DeviceStatusParams,
  FirmwareInfo,
  HealthSample,
  ResetInfo,
  SocketDrop,
} from "../shared/api";
import { getDeviceName, healthchecksOn, pingHealthcheck } from "./devices";
import {
  connectColumns,
  describeDrop,
  healthColumns,
  parseDiagMessage,
  parseDrop,
} from "./diagnostics";
import { migrate } from "./migrations";
import { REDRAW_HOUR, redrawDue, redrawTimeZone } from "./redraw";

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
  "rssi",
  "uptime_s",
  "uptime_at",
  "last_drop",
  "last_reset",
  "health",
  "health_at",
]);

/** A devices row: Device, with its diagnostics as the JSON they're stored as. */
export type DeviceRow = Omit<Device, "last_drop" | "last_reset" | "health"> & {
  last_drop: string | null;
  last_reset: string | null;
  health: string | null;
};

/** How long the hourly health reports are kept. */
export const HEALTH_HISTORY_DAYS = 30;
/** How long "Refresh now" waits for a board's answer. */
const DIAG_TIMEOUT_MS = 10_000;

// The board protocol over the WebSocket (see device/src/board_messages.h):
// the server sends "state 1 <etag1> <etag2> <etag3> <firmware or ->" when the
// socket opens and whenever any of it changes; the board sends "ping" every
// 30 s (answered with "pong" by the runtime, without waking this object) and
// "shown <etag1> <etag2> <etag3>" with what its panels show, after a state
// it already shows and after each update (even one some screens failed).
// Once a night the server sends "redraw" (see redraw.ts): the board downloads
// every screen again, with its ETag and `redraw=1` (so it gets the image even
// if it's current), and redraws it with a full refresh. Boards from before
// it ignore it, as they do any message they don't know.
//
// For the admin's "Refresh now", the server sends "diag" and the board
// answers "diag uptime=... rssi=..." (see diagnostics.ts).
const STATE_VERSION = 1;
const PING = "ping";
const PONG = "pong";
const REDRAW = "redraw";
const NO_FIRMWARE = "-";
/** Close code for a socket that a newer one from the same board replaced. */
export const CLOSE_REPLACED = 4000;
/** Close code for a socket that stopped pinging. */
export const CLOSE_SILENT = 4001;
/** Close code for a socket from before a deploy (see closeOutdatedSockets). */
export const CLOSE_OUTDATED = 4002;

/**
 * A board pings every 30 s, so a socket silent this long is dead (the board
 * gives up on it after 40 s without a pong). Up to here, it counts as live.
 */
export const SOCKET_SILENT_MS = 90_000;
/** How often the alarm pings healthchecks.io for each live board. */
export const HEALTH_INTERVAL_MS = 10 * 60_000;

/**
 * What each socket remembers through hibernation: `version` is the deploy
 * that accepted it (unset before 2026-11-24), `colo` the Cloudflare data
 * center the board's connection came in through (see coloOf()), `timeZone`
 * the time zone Cloudflare places the board's IP address in (see
 * timeZoneOf(); it sets the hour of the nightly redraw), and `gone` is set
 * once the socket's close is dealt with, so it's dealt with once.
 */
type SocketAttachment = {
  deviceId: string;
  connectedAt: number;
  version?: string;
  colo?: string;
  timeZone?: string;
  gone?: boolean;
};

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
      /** The board asked for the image it shows, to redraw it (see REDRAW). */
      redraw: boolean;
    };

/**
 * The state behind one set of hymn boards: the six lines, the three rendered
 * screens, what each device last reported, and the OTA firmware image. Both
 * physical boards share this one instance, so every update goes through a
 * single place (and later, a single WebSocket hub).
 */
export class HymnBoard extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /**
   * Who is waiting for each board's answer to "diag". Only in memory: the
   * request waiting keeps this instance alive until the answer comes.
   */
  private readonly diagWaiters = new Map<string, (() => void)[]>();

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
   * A device polling for a screen. Answers 304 when its etag is current,
   * unless it's redrawing the screen (`redraw`), and records that the device
   * was seen either way.
   */
  async fetchImage(
    id: number,
    etag: string | undefined,
    status: DeviceStatusParams,
    redraw = false,
  ): Promise<ImageResult> {
    const screen = await this.getScreen(id);
    const now = new Date().toISOString();
    const updated = etag !== screen.etag;
    // The image the board has, sent again to redraw: nothing new, and it
    // kept its ETag
    const redrawn = redraw && !updated;

    let etagStuck = false;
    if (status.device_id) {
      this.updateDevice(status.device_id, {
        saved_state_writes: status.saved_state_writes,
        last_seen: now,
        last_updated_at: updated ? now : undefined,
      });
      etagStuck = this.trackDownload(status.device_id, id, updated ? screen.etag : undefined, now);
    }

    return updated || redrawn
      ? { status: 200, etag: screen.etag, buffer: screen.buffer, etagStuck, redraw: redrawn }
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

  updateDevice(id: string, fields: Partial<Omit<DeviceRow, "id">>): void {
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
    // While the admin is open it asks every 10 seconds, so after a deploy the
    // old sockets go soon; with nobody there, the alarm closes them
    this.closeOutdatedSockets();
    const seen = new Map<string, number>();
    for (const ws of this.openSockets()) {
      const attachment = attachmentOf(ws);
      const at = this.lastHeardFrom(ws);
      if (attachment && at !== undefined && Date.now() - at < SOCKET_SILENT_MS) {
        seen.set(attachment.deviceId, Math.max(at, seen.get(attachment.deviceId) ?? 0));
      }
    }
    return this.sql
      .exec<DeviceRow>("SELECT * FROM devices")
      .toArray()
      .map((row) => {
        const device = deviceFromRow(row);
        const pinged = seen.get(device.id);
        const stored = device.last_seen ? Date.parse(device.last_seen) : 0;
        const lastSeen =
          pinged !== undefined && pinged > stored
            ? new Date(pinged).toISOString()
            : device.last_seen;
        return { ...device, last_seen: lastSeen, live: pinged !== undefined };
      });
  }

  /**
   * A board's hourly report (its /firmware/latest): the latest values on its
   * row, in the same UPDATE as its firmware version, and one row of history.
   */
  recordHealth(
    id: string,
    firmwareVersion: string | undefined,
    query: Record<string, string>,
  ): void {
    const at = new Date().toISOString();
    const columns = healthColumns((key) => query[key], at);
    this.updateDevice(id, { firmware_version: firmwareVersion, ...columns });
    if (columns.health !== undefined) {
      this.sql.exec(
        "INSERT OR REPLACE INTO device_health (device_id, at, rssi, uptime_s, health) VALUES (?, ?, ?, ?, ?)",
        id,
        at,
        columns.rssi ?? null,
        columns.uptime_s ?? null,
        columns.health,
      );
    }
  }

  /** A board's hourly reports from the last `days` days, oldest first. */
  getHealthHistory(id: string, days = 7): HealthSample[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.sql
      .exec<{ at: string; rssi: number | null; uptime_s: number | null; health: string }>(
        "SELECT at, rssi, uptime_s, health FROM device_health WHERE device_id = ? AND at >= ? ORDER BY at",
        id,
        since,
      )
      .toArray()
      .map((row) => ({
        at: row.at,
        rssi: row.rssi,
        uptime_s: row.uptime_s,
        heap_min: parseJson<BoardHealth>(row.health)?.heap_min ?? null,
      }));
  }

  /**
   * The admin's "Refresh now": asks the board for its health over its socket
   * and waits for the answer, which webSocketMessage() stores. "offline" if
   * the board has no socket, "timeout" if it didn't answer (firmware from
   * before diagnostics never does).
   */
  async requestDiagnostics(
    id: string,
    timeoutMs = DIAG_TIMEOUT_MS,
  ): Promise<"ok" | "offline" | "timeout"> {
    // A socket from before a deploy would have its answer dropped (see
    // webSocketMessage()), so it goes first and the board reconnects
    this.closeOutdatedSockets();
    const [socket] = this.openSockets(id);
    if (!socket) {
      return "offline";
    }
    let wake!: () => void;
    const answered = new Promise<"ok">((resolve) => {
      wake = () => resolve("ok");
    });
    this.diagWaiters.set(id, [...(this.diagWaiters.get(id) ?? []), wake]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      socket.send("diag");
      return await Promise.race([answered, timeout]);
    } catch {
      return "offline";
    } finally {
      clearTimeout(timer);
      const left = (this.diagWaiters.get(id) ?? []).filter((waiter) => waiter !== wake);
      if (left.length > 0) {
        this.diagWaiters.set(id, left);
      } else {
        this.diagWaiters.delete(id);
      }
    }
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
    const colo = coloOf(request);
    const name = getDeviceName(deviceId);

    for (const old of this.openSockets(deviceId)) {
      // Still open here means the board's old connection died without the
      // server hearing of it: say how long ago it opened (up to now, so that
      // includes the board noticing and reconnecting), where it came in, and
      // when its last ping got here
      console.log(`Device socket replaced: ${name} (${deviceId}), ${this.describe(old, now)}`);
      closeQuietly(old, CLOSE_REPLACED, "replaced by a newer socket");
    }
    // After the board's own, which is replaced, not a disconnect, whatever its deploy
    this.closeOutdatedSockets();

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({
      deviceId,
      connectedAt: now,
      version: this.env.CF_VERSION_METADATA.id,
      colo,
      timeZone: timeZoneOf(request),
    } satisfies SocketAttachment);

    const at = new Date(now).toISOString();
    const params = (key: string) => url.searchParams.get(key);
    this.updateDevice(deviceId, {
      last_seen: at,
      connected_at: at,
      firmware_version: firmwareVersion,
      saved_state_writes: writes !== null && /^\d+$/.test(writes) ? Number(writes) : undefined,
      ...connectColumns(params, at),
    });
    // The board's side of why its last socket ended, beside the server's
    // (logged when that socket closed or was replaced)
    const drop = parseDrop(params);
    const why = drop ? `: ${describeDrop(drop)}` : "";
    console.log(`Device socket connected: ${name} (${deviceId}) via ${colo ?? "?"}${why}`);
    this.ctx.waitUntil(this.ping(deviceId, "", `Socket connected${why}`));

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
    this.closeOutdatedSockets();
    // One the server closed (outdated, replaced or silent) gets no answer, and
    // a reply would throw: its board is reconnecting
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
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
    const shown = /^shown ([0-9A-Za-z._-]+) ([0-9A-Za-z._-]+) ([0-9A-Za-z._-]+)$/.exec(message);
    if (shown) {
      this.updateDevice(attachment.deviceId, {
        last_seen: at,
        shown_etags: JSON.stringify(shown.slice(1, 4)),
      });
      return;
    }
    const diag = message.length <= 512 ? parseDiagMessage(message) : null;
    if (diag) {
      // Only asked for by "Refresh now", so not part of the hourly history
      this.updateDevice(attachment.deviceId, { last_seen: at, ...healthColumns(diag, at) });
      for (const wake of this.diagWaiters.get(attachment.deviceId) ?? []) {
        wake();
      }
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
   * each live board (the board itself no longer does), closes sockets that
   * stopped pinging, and asks each board due its nightly redraw for it.
   */
  override async alarm(): Promise<void> {
    // First, as these sockets' ping times would fool the check below
    this.closeOutdatedSockets();
    const live = new Set<string>();
    for (const ws of this.openSockets()) {
      const attachment = attachmentOf(ws);
      const at = this.lastHeardFrom(ws);
      if (!attachment || at === undefined || Date.now() - at >= SOCKET_SILENT_MS) {
        closeQuietly(ws, CLOSE_SILENT, "no ping");
        // A board that's gone never answers the close, so don't wait for it
        this.socketGone(ws, "no ping");
        continue;
      }
      live.add(attachment.deviceId);
      this.redrawIfDue(ws, attachment);
    }
    const at = new Date().toISOString();
    for (const deviceId of live) {
      this.updateDevice(deviceId, { last_seen: at });
    }
    this.pruneHealthHistory();
    await Promise.all([...live].map((id) => this.ping(id, "", "Socket live")));
    if (this.openSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + HEALTH_INTERVAL_MS);
    }
  }

  /**
   * Asks the board on a live socket to redraw its panels, if it's the redraw
   * window where it is and it hasn't been asked in this one already. When it
   * was last asked is kept per board, as a board can reconnect meanwhile.
   */
  private redrawIfDue(ws: WebSocket, { deviceId, timeZone }: SocketAttachment): void {
    const key = `redraw_at:${deviceId}`;
    const last = this.ctx.storage.kv.get<number>(key);
    const now = Date.now();
    if (!redrawDue(now, timeZone, last)) {
      return;
    }
    try {
      ws.send(REDRAW);
    } catch {
      // Closing; the next alarm in the redraw window asks again
      return;
    }
    this.ctx.storage.kv.put(key, now);
    // The time zone it was due in: Chicago if its own is missing or unknown here
    const zone = redrawTimeZone(timeZone);
    const unknown = zone === timeZone ? "" : `, as ${timeZone ?? "its own"} isn't known`;
    console.log(
      `Asked ${getDeviceName(deviceId)} (${deviceId}) to redraw its panels (after ${REDRAW_HOUR} AM ${zone}${unknown})`,
    );
  }

  /**
   * Closes the boards' sockets that an earlier deploy accepted, so they
   * reconnect to this one. Sockets stay open across a deploy,
   * but the runtime stops updating their auto-response timestamps (pings
   * are still answered): seen 2026-11-24, when the alarm took both boards'
   * live sockets for silent. Called from each event that could read those
   * timestamps, so a deploy's old sockets go at the first one after it:
   * the admin's next look, a board connecting or sending `shown`, or at the
   * latest the alarm, within 10 minutes (board pings don't wake the object,
   * as the auto-response answers them). Until then the old sockets still
   * get the state. A board reconnects within seconds.
   */
  private closeOutdatedSockets(): void {
    const version = this.env.CF_VERSION_METADATA.id;
    const outdated = this.openSockets().filter((ws) => attachmentOf(ws)?.version !== version);
    for (const ws of outdated) {
      closeQuietly(ws, CLOSE_OUTDATED, "server updated");
      this.socketGone(ws, "server updated");
    }
  }

  /** Drops hourly health reports older than HEALTH_HISTORY_DAYS. */
  private pruneHealthHistory(): void {
    const before = new Date(Date.now() - HEALTH_HISTORY_DAYS * 86_400_000).toISOString();
    this.sql.exec("DELETE FROM device_health WHERE at < ?", before);
  }

  /** Pings the board's healthchecks.io check, when HEALTHCHECKS=on. */
  private async ping(...args: Parameters<typeof pingHealthcheck>): Promise<void> {
    if (healthchecksOn(this.env)) {
      await pingHealthcheck(...args);
    }
  }

  /**
   * The sockets still open. One the server closed (replaced, silent or outdated)
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

  /**
   * How long the socket has been up, the data center it came in through, and
   * how long ago its last ping got here (as the runtime recorded it), for the
   * logs: "up 634 s via LHR, last ping 32 s ago". A socket from an earlier
   * deploy has no trustworthy ping time (see closeOutdatedSockets()).
   */
  private describe(ws: WebSocket, now: number): string {
    const attachment = attachmentOf(ws);
    if (!attachment) {
      return "unknown socket";
    }
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
    const ping =
      attachment.version !== this.env.CF_VERSION_METADATA.id
        ? "from an earlier deploy"
        : pinged === undefined
          ? "no ping yet"
          : `last ping ${seconds(now - pinged)} s ago`;
    return `up ${seconds(now - attachment.connectedAt)} s via ${attachment.colo ?? "?"}, ${ping}`;
  }

  private socketGone(ws: WebSocket, why: string): void {
    const attachment = attachmentOf(ws);
    if (!attachment || attachment.gone) {
      return;
    }
    try {
      ws.serializeAttachment({ ...attachment, gone: true } satisfies SocketAttachment);
    } catch {
      // Already closed: no other event can come for it
    }
    const { deviceId } = attachment;
    const name = getDeviceName(deviceId);
    console.log(
      `Device socket closed (${why}): ${name} (${deviceId}), ${this.describe(ws, Date.now())}`,
    );
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

/** A devices row as the API returns it, its diagnostics parsed. */
function deviceFromRow(row: DeviceRow): Device {
  return {
    ...row,
    last_drop: parseJson<SocketDrop>(row.last_drop),
    last_reset: parseJson<ResetInfo>(row.last_reset),
    health: parseJson<BoardHealth>(row.health),
  };
}

/** JSON this object wrote itself (so of the type it wrote), or null. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller says which type it stored
function parseJson<T>(text: string | null): T | null {
  if (text === null) {
    return null;
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by this object, from T
    return JSON.parse(text) as T;
  } catch {
    return null;
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
    return {
      deviceId: attachment.deviceId,
      connectedAt: attachment.connectedAt,
      version:
        "version" in attachment && typeof attachment.version === "string"
          ? attachment.version
          : undefined,
      colo:
        "colo" in attachment && typeof attachment.colo === "string" ? attachment.colo : undefined,
      timeZone:
        "timeZone" in attachment && typeof attachment.timeZone === "string"
          ? attachment.timeZone
          : undefined,
      gone: "gone" in attachment && attachment.gone === true,
    };
  }
  return undefined;
}

/** Milliseconds as whole seconds, for the logs. */
function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

/** The Cloudflare data center a request came in through, from `request.cf`. */
export function coloOf(request: Request): string | undefined {
  return cfString(request, "colo");
}

/**
 * The time zone Cloudflare places a request's IP address in, from
 * `request.cf` (an IANA name such as "America/Chicago").
 */
export function timeZoneOf(request: Request): string | undefined {
  return cfString(request, "timezone");
}

function cfString(request: Request, key: "colo" | "timezone"): string | undefined {
  const cf: unknown = request.cf;
  if (typeof cf !== "object" || cf === null) {
    return undefined;
  }
  const value: unknown = Object.entries(cf).find(([name]) => name === key)?.[1];
  return typeof value === "string" && value !== "" ? value : undefined;
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

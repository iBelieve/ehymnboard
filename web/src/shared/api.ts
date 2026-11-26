// Types shared by the Worker's JSON API and the React admin.

import type { Lines } from "./screen";

/** What the server knows about a board, from its last few requests. */
export type Device = {
  id: string;
  saved_state_writes: number | null;
  last_seen: string | null;
  last_updated_at: string | null;
  booted_at: string | null;
  firmware_version: string | null;
  ota_status: string | null;
  ota_version: string | null;
  ota_at: string | null;
  /** When the board was flagged for re-downloading a screen it already has. */
  etag_stuck_at: string | null;
  /** When the board's WebSocket last opened, and last closed. */
  connected_at: string | null;
  disconnected_at: string | null;
  /** What the board said its panels show: a JSON array of three etags. */
  shown_etags: string | null;
  /** Its WiFi signal (dBm) and uptime (s) when it last said, at uptime_at. */
  rssi: number | null;
  uptime_s: number | null;
  uptime_at: string | null;
  /** What it said about its last socket on connecting, why it last reset, and its last health report. */
  last_drop: SocketDrop | null;
  last_reset: ResetInfo | null;
  health: BoardHealth | null;
  health_at: string | null;
};

/**
 * Why a board's last live socket ended, from the board's side (see
 * device/src/diagnostics.h for the reasons), and the attempts that failed
 * before the one that worked.
 */
export type SocketDrop = {
  /** pong_timeout, server_close, tcp_error, server_dropped, ... */
  reason: string | null;
  /** The close code, lwIP error or HTTP status that goes with it */
  detail: number | null;
  /** How long that socket had been live */
  up_s: number | null;
  fails: number | null;
  fail: string | null;
  fail_detail: number | null;
  /** When the board connected and said so */
  at: string;
};

/** Why a board last reset, from its /device_booted. */
export type ResetInfo = {
  /** power_on, watchdog, hang, crash, no_socket, panel_busy, ... */
  reason: string;
  /** What it was doing, when it recorded the reason itself */
  phase: string | null;
  /** A crash's PC, a stuck panel's screen, ... */
  detail: number | null;
  /** A crash's LR */
  extra: number | null;
  /** How long it had been up */
  uptime_s: number | null;
  /** When it booted and said so */
  at: string;
};

/** Heap and counters since boot, from a board's hourly report or "Refresh now". */
export type BoardHealth = {
  heap_free: number | null;
  heap_min: number | null;
  /** Live sockets that ended */
  drops: number | null;
  connect_fails: number | null;
  pong_timeouts: number | null;
  image_fails: number | null;
  wifi_drops: number | null;
  /** Allocations TLS didn't get */
  tls_oom: number | null;
};

/** One hourly report, for the Details panel's charts. */
export type HealthSample = {
  at: string;
  rssi: number | null;
  uptime_s: number | null;
  heap_min: number | null;
};

/** What the admin shows for a board: its row, plus whether its socket is up now. */
export type DeviceWithName = Device & { name: string; live: boolean };

/** Query parameters every device request carries. */
export type DeviceStatusParams = {
  device_id?: string;
  saved_state_writes?: number;
};

export type FirmwareInfo = {
  version: string;
  size: number;
  sha256: string;
  uploaded_at: string;
};

export type BoardState = {
  lines: Lines;
  screens: { id: number; etag: string }[];
  devices: DeviceWithName[];
  firmware: FirmwareInfo | null;
};

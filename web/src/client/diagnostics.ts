// Words for what a board says about its health (see src/worker/diagnostics.ts
// and device/src/diagnostics.h for the reasons it can give).

import type { DeviceWithName, ResetInfo, SocketDrop } from "../shared/api";

const RESET_REASONS: Record<string, string> = {
  unknown: "Unknown",
  power_on: "Power on",
  run_pin: "Reset button",
  debugger: "Debugger",
  watchdog: "Watchdog (something kept interrupts off)",
  hang: "Hang (the main loop stopped for 60 s)",
  crash: "Crash",
  no_socket: "No connection for 3 minutes",
  downloads_failing: "Image downloads failing for 3 minutes",
  panel_busy: "Panel stuck busy",
  flash_save_failed: "Saving to flash failed",
  ota_install: "Installing an update",
  ota_unhealthy: "New firmware couldn't reach the server",
};

const PHASES: Record<string, string> = {
  starting: "starting up",
  wifi: "joining WiFi",
  boot_report: "reporting its boot",
  running: "running",
  image_download: "downloading an image",
  panel: "drawing a panel",
  flash_save: "saving to flash",
  ota_check: "checking for an update",
  ota_download: "downloading an update",
};

const SOCKET_ENDS: Record<string, string> = {
  dns: "DNS lookup failed",
  no_memory: "out of memory",
  connect_error: "couldn't connect",
  tcp_error: "connection error",
  write_failed: "write failed",
  handshake: "server refused the upgrade",
  server_close: "server closed it",
  server_dropped: "server dropped the connection",
  protocol_error: "protocol error",
  closed: "closed by the board",
  connect_timeout: "no state within 30 s",
  pong_timeout: "no answer to a ping",
};

/** "3 d 4 h", "2 h 5 m", "45 s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} m`;
  return `${s} s`;
}

/** Signal strength in words: WiFi's usual bands. */
export function signal(rssi: number): string {
  const quality =
    rssi >= -60 ? "strong" : rssi >= -70 ? "good" : rssi >= -80 ? "weak" : "very weak";
  return `${rssi} dBm (${quality})`;
}

/** Kilobytes, for the heap. */
export function kilobytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Uptime now: what the board last said, plus the time since while it's
 * still connected (a board that went away may have rebooted).
 */
export function uptimeNow(
  device: Pick<DeviceWithName, "uptime_s" | "uptime_at" | "live">,
  now: Date,
): number | null {
  if (device.uptime_s === null || !device.uptime_at) return null;
  const since = device.live ? (now.getTime() - Date.parse(device.uptime_at)) / 1000 : 0;
  return device.uptime_s + Math.max(0, since);
}

function hex(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}

/** "Crash while drawing a panel, after 3 h 0 m, at 0x10001234 (from 0x10005678)". */
export function describeReset(reset: ResetInfo): string {
  let text = RESET_REASONS[reset.reason] ?? reset.reason;
  if (reset.phase) text += ` while ${PHASES[reset.phase] ?? reset.phase}`;
  if (reset.uptime_s !== null) text += `, after ${duration(reset.uptime_s)}`;
  if (reset.reason === "crash" && reset.detail !== null) {
    text += `, at ${hex(reset.detail)}`;
    if (reset.extra !== null) text += ` (from ${hex(reset.extra)})`;
  } else if (reset.reason === "panel_busy" && reset.detail !== null) {
    text += `: screen ${reset.detail}`;
  } else if (reset.detail !== null) {
    text += ` (${reset.detail})`;
  }
  return text;
}

function socketEnd(reason: string, detail: number | null): string {
  const words = SOCKET_ENDS[reason] ?? reason;
  return detail ? `${words} (${detail})` : words;
}

/** "No answer to a ping after 2 h 5 m; 3 failed attempts before connecting, the last: server refused the upgrade (503)". */
export function describeDrop(drop: SocketDrop): string {
  const parts: string[] = [];
  if (drop.reason) {
    const ended = socketEnd(drop.reason, drop.detail);
    parts.push(
      ended.charAt(0).toUpperCase() +
        ended.slice(1) +
        (drop.up_s !== null ? ` after ${duration(drop.up_s)}` : ""),
    );
  }
  if (drop.fail) {
    const attempts =
      drop.fails === 1 ? "1 failed attempt" : `${drop.fails ?? "Some"} failed attempts`;
    parts.push(
      `${attempts} before connecting, the last: ${socketEnd(drop.fail, drop.fail_detail)}`,
    );
  }
  return parts.join("; ");
}

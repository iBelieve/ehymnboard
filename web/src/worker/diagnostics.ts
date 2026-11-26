// What a board says about its own health (see device/src/diagnostics.h). It
// rides on requests the board makes anyway, as optional query parameters, so
// it costs no extra requests or Durable Object wakes, and older firmware
// just leaves them out:
//
//   /ws, every connect        uptime, rssi, and why the last live socket ended
//                             (drop, drop_detail, drop_up) and what failed
//                             since (fails, fail, fail_detail)
//   /device_booted            uptime, rssi, why it reset (reset, reset_phase,
//                             reset_detail, reset_extra, reset_uptime)
//   /firmware/latest, hourly  uptime, rssi, heap and counters since boot
//   "diag ..." on the socket  the same as hourly, when the admin asks
//
// Every value is checked here, as anyone can send these.

import type { BoardHealth, ResetInfo, SocketDrop } from "../shared/api";

/** Looks up one parameter, as `URLSearchParams.get` or Hono's `c.req.query` do. */
export type Params = (name: string) => string | null | undefined;

const NAME = /^[a-z_]{1,32}$/;
const INTEGER = /^-?\d{1,10}$/;

/** A reason or phase name, or null. */
function name(params: Params, key: string): string | null {
  const value = params(key);
  return value && NAME.test(value) ? value : null;
}

/** A whole number from -2^31 to 2^32 (the board's int32_t and uint32_t), or null. */
function integer(params: Params, key: string): number | null {
  const value = params(key);
  if (!value || !INTEGER.test(value)) {
    return null;
  }
  const n = Number(value);
  return n >= -(2 ** 31) && n < 2 ** 32 ? n : null;
}

/** Signal and uptime, which every report has. */
export function parseLink(params: Params): { rssi: number | null; uptime_s: number | null } {
  const rssi = integer(params, "rssi");
  return {
    // dBm: 0 would mean the chip didn't say
    rssi: rssi !== null && rssi < 0 && rssi >= -127 ? rssi : null,
    uptime_s: integer(params, "uptime"),
  };
}

/** Why the board's last socket ended, and what failed since; null if it didn't say. */
export function parseDrop(params: Params): Omit<SocketDrop, "at"> | null {
  const drop = {
    reason: name(params, "drop"),
    detail: integer(params, "drop_detail"),
    up_s: integer(params, "drop_up"),
    fails: integer(params, "fails"),
    fail: name(params, "fail"),
    fail_detail: integer(params, "fail_detail"),
  };
  return drop.reason !== null || drop.fail !== null ? drop : null;
}

/** Why the board reset; null if it didn't say (older firmware). */
export function parseReset(params: Params): Omit<ResetInfo, "at"> | null {
  const reason = name(params, "reset");
  if (reason === null) {
    return null;
  }
  return {
    reason,
    phase: name(params, "reset_phase"),
    detail: integer(params, "reset_detail"),
    extra: integer(params, "reset_extra"),
    uptime_s: integer(params, "reset_uptime"),
  };
}

/** The heap and counters from an hourly or on-request report; null without them. */
export function parseHealth(params: Params): BoardHealth | null {
  const health: BoardHealth = {
    heap_free: integer(params, "heap_free"),
    heap_min: integer(params, "heap_min"),
    drops: integer(params, "drops"),
    connect_fails: integer(params, "connect_fails"),
    pong_timeouts: integer(params, "pong_timeouts"),
    image_fails: integer(params, "image_fails"),
    wifi_drops: integer(params, "wifi_drops"),
    tls_oom: integer(params, "tls_oom"),
  };
  return Object.values(health).some((value) => value !== null) ? health : null;
}

/** The board's answer to "diag": "diag uptime=1 rssi=-60 heap_free=..." as Params. */
export function parseDiagMessage(message: string): Params | null {
  if (!message.startsWith("diag ")) {
    return null;
  }
  const params = new Map<string, string>();
  for (const pair of message.slice(5).split(" ")) {
    const equals = pair.indexOf("=");
    if (equals > 0) {
      params.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  }
  return (key) => params.get(key);
}

/** A short description for the logs and healthchecks.io: "pong_timeout (0) after 1234 s". */
export function describeDrop(drop: Omit<SocketDrop, "at">): string {
  const parts: string[] = [];
  if (drop.reason !== null) {
    parts.push(
      `last socket ended: ${drop.reason}${drop.detail ? ` (${drop.detail})` : ""}` +
        (drop.up_s !== null ? ` after ${drop.up_s} s` : ""),
    );
  }
  if (drop.fail !== null) {
    const attempts = drop.fails === 1 ? "1 failed attempt" : `${drop.fails ?? "?"} failed attempts`;
    parts.push(
      `${attempts}, the last ${drop.fail}${drop.fail_detail ? ` (${drop.fail_detail})` : ""}`,
    );
  }
  return parts.join("; ");
}

/** "crash while panel after 3600 s at 0x10001234" and the like. */
export function describeReset(reset: Omit<ResetInfo, "at">): string {
  let text = reset.reason;
  if (reset.phase !== null) {
    text += ` while ${reset.phase}`;
  }
  if (reset.uptime_s !== null) {
    text += ` after ${reset.uptime_s} s`;
  }
  if (reset.reason === "crash" && reset.detail !== null) {
    text += ` at ${hex(reset.detail)}`;
    if (reset.extra !== null) {
      text += ` from ${hex(reset.extra)}`;
    }
  } else if (reset.detail !== null) {
    text += ` (${reset.detail})`;
  }
  return text;
}

function hex(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}

/** The devices row's diagnostics columns a report sets (see migration 3). */
export type DiagnosticColumns = {
  rssi?: number;
  uptime_s?: number;
  uptime_at?: string;
  last_drop?: string;
  last_reset?: string;
  health?: string;
  health_at?: string;
};

/** Signal and uptime, when the report has them. */
export function linkColumns(params: Params, at: string): DiagnosticColumns {
  const { rssi, uptime_s } = parseLink(params);
  if (uptime_s === null) {
    return {};
  }
  return { uptime_s, uptime_at: at, ...(rssi !== null && { rssi }) };
}

/** A connect's columns: signal, uptime and why the last socket ended. */
export function connectColumns(params: Params, at: string): DiagnosticColumns {
  const drop = parseDrop(params);
  return {
    ...linkColumns(params, at),
    ...(drop && { last_drop: JSON.stringify({ ...drop, at } satisfies SocketDrop) }),
  };
}

/** A boot's columns: signal, uptime and why the board reset. */
export function bootColumns(params: Params, at: string): DiagnosticColumns {
  const reset = parseReset(params);
  return {
    ...linkColumns(params, at),
    ...(reset && { last_reset: JSON.stringify({ ...reset, at } satisfies ResetInfo) }),
  };
}

/** A health report's columns: signal, uptime, heap and counters. */
export function healthColumns(params: Params, at: string): DiagnosticColumns {
  const health = parseHealth(params);
  return {
    ...linkColumns(params, at),
    ...(health && { health: JSON.stringify(health), health_at: at }),
  };
}

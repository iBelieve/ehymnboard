import { describe, expect, test } from "vitest";
import {
  describeDrop as dropInWords,
  describeReset as resetInWords,
  duration,
  signal,
  uptimeNow,
} from "../src/client/diagnostics";
import {
  bootColumns,
  connectColumns,
  describeDrop,
  describeReset,
  healthColumns,
  parseDiagMessage,
  parseDrop,
  parseHealth,
  parseLink,
  parseReset,
} from "../src/worker/diagnostics";

/** Params from a query string, as the board sends them. */
function query(qs: string) {
  const params = new URLSearchParams(qs);
  return (key: string) => params.get(key);
}

const AT = "2026-11-26T12:00:00.000Z";

describe("what boards send", () => {
  test("a connect after a dropped socket", () => {
    const params = query(
      "device_id=X&uptime=7200&rssi=-61&drop=pong_timeout&drop_detail=0&drop_up=3600&fails=2&fail=handshake&fail_detail=503",
    );
    expect(parseLink(params)).toEqual({ rssi: -61, uptime_s: 7200 });
    const drop = parseDrop(params);
    expect(drop).toEqual({
      reason: "pong_timeout",
      detail: 0,
      up_s: 3600,
      fails: 2,
      fail: "handshake",
      fail_detail: 503,
    });
    expect(describeDrop(drop!)).toBe(
      "last socket ended: pong_timeout after 3600 s; 2 failed attempts, the last handshake (503)",
    );
    expect(describeDrop({ ...drop!, fails: 1 })).toBe(
      "last socket ended: pong_timeout after 3600 s; 1 failed attempt, the last handshake (503)",
    );
    expect(connectColumns(params, AT)).toEqual({
      rssi: -61,
      uptime_s: 7200,
      uptime_at: AT,
      last_drop: JSON.stringify({ ...drop, at: AT }),
    });
  });

  test("older firmware says nothing, and nothing is stored", () => {
    const params = query("device_id=X&saved_state_writes=4&watchdog_caused_reboot=0");
    expect(parseDrop(params)).toBeNull();
    expect(parseReset(params)).toBeNull();
    expect(parseHealth(params)).toBeNull();
    expect(connectColumns(params, AT)).toEqual({});
    expect(bootColumns(params, AT)).toEqual({});
    expect(healthColumns(params, AT)).toEqual({});
  });

  test("a crash", () => {
    const params = query(
      "reset=crash&reset_phase=panel&reset_detail=268440116&reset_extra=268457593&reset_uptime=3600&uptime=4&rssi=-70",
    );
    const reset = parseReset(params);
    expect(reset).toEqual({
      reason: "crash",
      phase: "panel",
      detail: 268440116,
      extra: 268457593,
      uptime_s: 3600,
    });
    expect(describeReset(reset!)).toBe(
      "crash while panel after 3600 s at 0x10001234 from 0x10005679",
    );
    expect(describeReset({ ...reset!, reason: "panel_busy", detail: 2, extra: null })).toBe(
      "panel_busy while panel after 3600 s (2)",
    );
    expect(
      describeReset({ reason: "power_on", phase: null, detail: null, extra: null, uptime_s: null }),
    ).toBe("power_on");
    // A failed flash save's pico-sdk error, which the board sends signed
    expect(
      parseReset(query("reset=flash_save_failed&reset_phase=flash_save&reset_detail=-1")),
    ).toMatchObject({ reason: "flash_save_failed", detail: -1 });
    expect(JSON.parse(bootColumns(params, AT).last_reset!)).toEqual({ ...reset, at: AT });
  });

  test("the hourly health report and the answer to diag carry the same fields", () => {
    const fields =
      "uptime=86400 rssi=-55 heap_free=120000 heap_min=40000 drops=3 connect_fails=4 pong_timeouts=1 image_fails=2 wifi_drops=1 tls_oom=0";
    const fromQuery = healthColumns(query(fields.replaceAll(" ", "&")), AT);
    const diag = parseDiagMessage(`diag ${fields}`);
    expect(diag).not.toBeNull();
    expect(healthColumns(diag!, AT)).toEqual(fromQuery);
    expect(JSON.parse(fromQuery.health!)).toEqual({
      heap_free: 120000,
      heap_min: 40000,
      drops: 3,
      connect_fails: 4,
      pong_timeouts: 1,
      image_fails: 2,
      wifi_drops: 1,
      tls_oom: 0,
    });
    expect(fromQuery.health_at).toBe(AT);
    expect(parseDiagMessage("diagnose")).toBeNull();
    expect(parseDiagMessage("shown a b c")).toBeNull();
  });

  test("values that aren't what the board sends are dropped", () => {
    const params = query(
      "uptime=-&rssi=0&drop=Not%20A%20Name&fail=x&fails=1e3&reset=crash&reset_detail=99999999999&reset_phase=" +
        "a".repeat(33),
    );
    expect(parseLink(params)).toEqual({ rssi: null, uptime_s: null });
    expect(parseDrop(params)).toEqual({
      reason: null,
      detail: null,
      up_s: null,
      fails: null,
      fail: "x",
      fail_detail: null,
    });
    expect(parseReset(params)).toEqual({
      reason: "crash",
      phase: null,
      detail: null,
      extra: null,
      uptime_s: null,
    });
    expect(parseLink(query("rssi=-128&uptime=4294967296"))).toEqual({ rssi: null, uptime_s: null });
    expect(parseLink(query("rssi=-127&uptime=4294967295"))).toEqual({
      rssi: -127,
      uptime_s: 4294967295,
    });
  });
});

describe("the admin's words for them", () => {
  test("durations and signal", () => {
    expect(duration(45)).toBe("45 s");
    expect(duration(300)).toBe("5 m");
    expect(duration(7500)).toBe("2 h 5 m");
    expect(duration(3 * 86_400 + 4 * 3600)).toBe("3 d 4 h");
    expect(signal(-55)).toBe("-55 dBm (strong)");
    expect(signal(-65)).toBe("-65 dBm (good)");
    expect(signal(-75)).toBe("-75 dBm (weak)");
    expect(signal(-85)).toBe("-85 dBm (very weak)");
  });

  test("resets", () => {
    const at = AT;
    expect(
      resetInWords({
        reason: "crash",
        phase: "panel",
        detail: 0x10001234,
        extra: 0x10005679,
        uptime_s: 10_800,
        at,
      }),
    ).toBe("Crash while drawing a panel, after 3 h 0 m, at 0x10001234 (from 0x10005679)");
    expect(
      resetInWords({
        reason: "panel_busy",
        phase: "panel",
        detail: 2,
        extra: null,
        uptime_s: 40,
        at,
      }),
    ).toBe("Panel stuck busy while drawing a panel, after 40 s: screen 2");
    expect(
      resetInWords({
        reason: "flash_save_failed",
        phase: "flash_save",
        detail: 5,
        extra: null,
        uptime_s: null,
        at,
      }),
    ).toBe("Saving to flash failed while saving to flash (5)");
    expect(
      resetInWords({
        reason: "power_on",
        phase: null,
        detail: null,
        extra: null,
        uptime_s: null,
        at,
      }),
    ).toBe("Power on");
    // A reason from newer firmware is shown as it came
    expect(
      resetInWords({
        reason: "brownout",
        phase: "lunch",
        detail: null,
        extra: null,
        uptime_s: null,
        at,
      }),
    ).toBe("brownout while lunch");
  });

  test("socket drops", () => {
    const drop = {
      reason: "pong_timeout",
      detail: 0,
      up_s: 7500,
      fails: null,
      fail: null,
      fail_detail: null,
      at: AT,
    };
    expect(dropInWords(drop)).toBe("No answer to a ping after 2 h 5 m");
    expect(
      dropInWords({
        ...drop,
        reason: "server_close",
        detail: 4002,
        fails: 1,
        fail: "tcp_error",
        fail_detail: -14,
      }),
    ).toBe(
      "Server closed it (4002) after 2 h 5 m; 1 failed attempt before connecting, the last: connection error (-14)",
    );
    expect(dropInWords({ ...drop, reason: null, up_s: null, fails: 3, fail: "dns" })).toBe(
      "3 failed attempts before connecting, the last: DNS lookup failed",
    );
  });

  test("uptime counts on while the board is connected", () => {
    const device = { uptime_s: 100, uptime_at: AT, live: true };
    const later = new Date(Date.parse(AT) + 60_000);
    expect(uptimeNow(device, later)).toBe(160);
    expect(uptimeNow({ ...device, live: false }, later)).toBe(100);
    expect(uptimeNow({ ...device, uptime_s: null }, later)).toBeNull();
  });
});

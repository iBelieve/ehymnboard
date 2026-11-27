import { describe, expect, test } from "vitest";
import { REDRAW_HOUR, REDRAW_SPACING_MS, localHour, redrawDue } from "../src/worker/redraw";

// 2026-11-29 09:30 UTC: 03:30 in Chicago (UTC-6 in winter)
const SUNDAY = Date.UTC(2026, 10, 29, 9, 30);
const HOUR = 60 * 60_000;

describe("localHour", () => {
  test("is the hour in the time zone", () => {
    expect(localHour(SUNDAY, "America/Chicago")).toBe(3);
    expect(localHour(SUNDAY, "Europe/London")).toBe(9);
    expect(localHour(SUNDAY, "Asia/Kolkata")).toBe(15);
  });

  test("counts midnight as 0, not 24", () => {
    expect(localHour(Date.UTC(2026, 10, 29, 0, 5), "UTC")).toBe(0);
  });

  test("follows daylight saving time", () => {
    // 09:30 UTC is 04:30 in Chicago in summer (UTC-5)
    expect(localHour(Date.UTC(2026, 6, 5, 9, 30), "America/Chicago")).toBe(4);
  });

  test("takes an unknown or missing time zone as UTC", () => {
    expect(localHour(SUNDAY, "Not/AZone")).toBe(9);
    expect(localHour(SUNDAY, undefined)).toBe(9);
  });
});

describe("redrawDue", () => {
  test("only in the redraw hour", () => {
    expect(REDRAW_HOUR).toBe(3);
    expect(redrawDue(SUNDAY, "America/Chicago", undefined)).toBe(true);
    expect(redrawDue(SUNDAY - HOUR, "America/Chicago", undefined)).toBe(false);
    expect(redrawDue(SUNDAY + HOUR, "America/Chicago", undefined)).toBe(false);
    expect(redrawDue(SUNDAY, "Europe/London", undefined)).toBe(false);
  });

  test("once a night", () => {
    // Asked 10 minutes ago, by the last alarm: not again
    expect(redrawDue(SUNDAY, "America/Chicago", SUNDAY - 10 * 60_000)).toBe(false);
    expect(redrawDue(SUNDAY, "America/Chicago", SUNDAY - REDRAW_SPACING_MS + 1)).toBe(false);
    // Asked the night before: again
    expect(redrawDue(SUNDAY, "America/Chicago", SUNDAY - 24 * HOUR)).toBe(true);
    expect(redrawDue(SUNDAY, "America/Chicago", SUNDAY - REDRAW_SPACING_MS)).toBe(true);
  });
});

import { describe, expect, test } from "vitest";
import {
  REDRAW_HOUR,
  REDRAW_SPACING_MS,
  REDRAW_WINDOW_HOURS,
  localHour,
  redrawDue,
} from "../src/worker/redraw";

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

  test("is undefined for an unknown or missing time zone", () => {
    expect(localHour(SUNDAY, "Not/AZone")).toBeUndefined();
    expect(localHour(SUNDAY, undefined)).toBeUndefined();
  });
});

describe("redrawDue", () => {
  test("only from 3 AM to 5 AM", () => {
    expect([REDRAW_HOUR, REDRAW_WINDOW_HOURS]).toEqual([3, 2]);
    expect(redrawDue(SUNDAY, "America/Chicago", undefined)).toBe(true);
    expect(redrawDue(SUNDAY + HOUR, "America/Chicago", undefined)).toBe(true);
    // 02:30 and 05:30
    expect(redrawDue(SUNDAY - HOUR, "America/Chicago", undefined)).toBe(false);
    expect(redrawDue(SUNDAY + 2 * HOUR, "America/Chicago", undefined)).toBe(false);
    expect(redrawDue(SUNDAY, "Europe/London", undefined)).toBe(false);
  });

  test("never where the time zone isn't known", () => {
    // 03:30 UTC: 9:30 PM in Chicago
    const night = Date.UTC(2026, 10, 29, 3, 30);
    expect(redrawDue(night, "UTC", undefined)).toBe(true);
    expect(redrawDue(night, undefined, undefined)).toBe(false);
    expect(redrawDue(night, "Not/AZone", undefined)).toBe(false);
  });

  test("on a night the clocks skip 3 AM", () => {
    // 2027-03-28 in Helsinki: 03:00 becomes 04:00 at 01:00 UTC, so 01:30 UTC is 04:30
    const night = Date.UTC(2027, 2, 28, 1, 30);
    expect(localHour(night - HOUR, "Europe/Helsinki")).toBe(2);
    expect(localHour(night, "Europe/Helsinki")).toBe(4);
    expect(redrawDue(night, "Europe/Helsinki", undefined)).toBe(true);
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

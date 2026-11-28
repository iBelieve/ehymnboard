import { afterEach, describe, expect, test, vi } from "vitest";
import { PARTIAL_REFRESH_FLAG, partialRefreshFor } from "../src/worker/flags";

const LEFT = "E6614103E71F8D26";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("partialRefreshFor", () => {
  test("asks Flagship with the board's ID and name, defaulting to off", async () => {
    const getBooleanValue = vi.fn(() => Promise.resolve(true));
    expect(await partialRefreshFor({ getBooleanValue }, LEFT)).toBe(true);
    expect(getBooleanValue).toHaveBeenCalledWith(PARTIAL_REFRESH_FLAG, false, {
      targetingKey: LEFT,
      deviceId: LEFT,
      board: "Left Hymn Board",
    });
  });

  test("is off if Flagship can't be asked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getBooleanValue = vi.fn(() => Promise.reject(new Error("unreachable")));
    expect(await partialRefreshFor({ getBooleanValue }, LEFT)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});

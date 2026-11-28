import { afterEach, describe, expect, test, vi } from "vitest";
import { PARTIAL_REFRESH_FLAG, partialRefreshFor } from "../src/worker/flags";

const LEFT = "E6614103E71F8D26";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The binding's answer: `value`, with `errorCode` if it couldn't evaluate the flag. */
function answering(value: boolean, errorCode?: string) {
  return vi.fn(() =>
    Promise.resolve({ flagKey: PARTIAL_REFRESH_FLAG, value, errorCode, errorMessage: errorCode }),
  );
}

describe("partialRefreshFor", () => {
  test("asks Flagship with the board's ID and name, defaulting to off", async () => {
    const getBooleanDetails = answering(true);
    expect(await partialRefreshFor({ getBooleanDetails }, LEFT)).toBe(true);
    expect(getBooleanDetails).toHaveBeenCalledWith(PARTIAL_REFRESH_FLAG, false, {
      targetingKey: LEFT,
      deviceId: LEFT,
      board: "Left Hymn Board",
    });
  });

  test("is off, quietly, if the flag isn't in the app", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getBooleanDetails = answering(false, "FLAG_NOT_FOUND");
    expect(await partialRefreshFor({ getBooleanDetails }, LEFT)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test("doesn't know if Flagship couldn't evaluate the flag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getBooleanDetails = answering(false, "GENERAL");
    expect(await partialRefreshFor({ getBooleanDetails }, LEFT)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  test("doesn't know if Flagship can't be asked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getBooleanDetails = vi.fn(() => Promise.reject(new Error("unreachable")));
    expect(await partialRefreshFor({ getBooleanDetails }, LEFT)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

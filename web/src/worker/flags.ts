// Feature flags, from Cloudflare Flagship: the FLAGS binding is the app
// "hymnboard" (Compute > Flagship in the dashboard), so a flag is turned on
// for a board, some boards or all of them there, and off again, without a
// deploy or a firmware release. A flag that can't be evaluated is off.
// Locally (`pnpm dev`, the tests, the e2e tests' server) the binding is
// Wrangler's own store, empty until a flag is made in it, so every flag is off.

import { getDeviceName } from "./devices";

/**
 * Boards update their panels with a partial refresh, which doesn't flash,
 * instead of a full one (the state message's "partial" option). The flag's
 * rules can match a board's `deviceId` (also its `targetingKey`, for
 * percentage rollouts) or `board`, its name.
 */
export const PARTIAL_REFRESH_FLAG = "partial-refresh";

/** Whether Flagship lets this board update its panels partially. */
export async function partialRefreshFor(
  flags: Pick<Flagship, "getBooleanValue">,
  deviceId: string,
): Promise<boolean> {
  try {
    return await flags.getBooleanValue(PARTIAL_REFRESH_FLAG, false, {
      targetingKey: deviceId,
      deviceId,
      board: getDeviceName(deviceId),
    });
  } catch (error) {
    console.warn(`Flagship: couldn't evaluate ${PARTIAL_REFRESH_FLAG} for ${deviceId}:`, error);
    return false;
  }
}

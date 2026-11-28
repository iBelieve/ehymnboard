// Feature flags, from Cloudflare Flagship: the FLAGS binding is the app
// "hymnboard" (Compute > Flagship in the dashboard), so a flag is turned on
// for a board, some boards or all of them there, and off again, without a
// deploy or a firmware release. A flag that isn't there is off; one that
// can't be evaluated (Flagship unreachable) is unknown, and its caller keeps
// what it last had. Locally (`pnpm dev`, the tests, the e2e tests' server)
// the binding is Wrangler's own store, empty until a flag is made in it, so
// every flag is off.

import { getDeviceName } from "./devices";

/**
 * Boards update their panels with a partial refresh, which doesn't flash,
 * instead of a full one (the state message's "partial" option). The flag's
 * rules can match a board's `deviceId` (also its `targetingKey`, for
 * percentage rollouts) or `board`, its name.
 */
export const PARTIAL_REFRESH_FLAG = "partial-refresh";

/** Flagship's answer for a flag that isn't in the app, which is off. */
const FLAG_NOT_FOUND = "FLAG_NOT_FOUND";

/**
 * Whether Flagship lets this board update its panels partially, or
 * `undefined` if it couldn't say: the binding answers the default, with an
 * error code, when it can't evaluate a flag, and that mustn't read as the
 * flag turning off (a board would flash its next update for nothing).
 */
export async function partialRefreshFor(
  flags: Pick<Flagship, "getBooleanDetails">,
  deviceId: string,
): Promise<boolean | undefined> {
  try {
    const details = await flags.getBooleanDetails(PARTIAL_REFRESH_FLAG, false, {
      targetingKey: deviceId,
      deviceId,
      board: getDeviceName(deviceId),
    });
    if (details.errorCode === undefined || details.errorCode === FLAG_NOT_FOUND) {
      return details.value;
    }
    console.warn(
      `Flagship: couldn't evaluate ${PARTIAL_REFRESH_FLAG} for ${deviceId}: ${details.errorCode} ${details.errorMessage ?? ""}`,
    );
  } catch (error) {
    console.warn(`Flagship: couldn't evaluate ${PARTIAL_REFRESH_FLAG} for ${deviceId}:`, error);
  }
  return undefined;
}

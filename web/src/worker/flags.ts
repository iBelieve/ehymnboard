// Feature flags, from Cloudflare Flagship: the FLAGS binding is the app
// "hymnboard" (Compute > Flagship in the dashboard), so a flag is turned on
// for a board, some boards or all of them there, and off again, without a
// deploy or a firmware release. A flag that isn't there is off; one that
// can't be evaluated (Flagship unreachable, or slower than FLAG_TIMEOUT_MS)
// is unknown, and its caller keeps what it last had. Locally (`pnpm dev`, the
// tests, the e2e tests' server) the binding is Wrangler's own store, empty
// until a flag is made in it, so every flag is off unless a test makes it
// (the Worker tests through its admin API; the e2e tests' server makes
// partial-refresh on for every board).

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
 * How long a flag's evaluation may take before it counts as unknown. Every
 * state a board gets (and so the admin's Apply, and a board's connect, which
 * gives up after 30 s) waits on it, so a slow or stuck Flagship mustn't hold
 * them up.
 */
export const FLAG_TIMEOUT_MS = 2_000;

/**
 * Whether Flagship lets this board update its panels partially, or
 * `undefined` if it couldn't say: the binding answers the default, with an
 * error code, when it can't evaluate a flag, and that mustn't read as the
 * flag turning off (a board would flash its next update for nothing). Nor
 * may an answer that doesn't come within FLAG_TIMEOUT_MS.
 */
export async function partialRefreshFor(
  flags: Pick<Flagship, "getBooleanDetails">,
  deviceId: string,
): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const details = await Promise.race([
      flags.getBooleanDetails(PARTIAL_REFRESH_FLAG, false, {
        targetingKey: deviceId,
        deviceId,
        board: getDeviceName(deviceId),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer within ${FLAG_TIMEOUT_MS} ms`));
        }, FLAG_TIMEOUT_MS);
      }),
    ]);
    if (details.errorCode === undefined || details.errorCode === FLAG_NOT_FOUND) {
      return details.value;
    }
    console.warn(
      `Flagship: couldn't evaluate ${PARTIAL_REFRESH_FLAG} for ${deviceId}: ${details.errorCode} ${details.errorMessage ?? ""}`,
    );
  } catch (error) {
    console.warn(`Flagship: couldn't evaluate ${PARTIAL_REFRESH_FLAG} for ${deviceId}:`, error);
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}

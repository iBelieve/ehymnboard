// The boards this server knows by name, in display order.
export const DEVICE_NAMES: Record<string, string> = {
  E6614103E71F8D26: "Left Hymn Board",
  E661A4D41787452B: "Right Hymn Board",
};

// healthchecks.io check for each board.
const HEALTHCHECKS_PING_URLS: Record<string, string> = {
  E6614103E71F8D26: "https://hc-ping.com/a717c5f0-8a83-45f9-92a7-c79a21a437b4",
  E661A4D41787452B: "https://hc-ping.com/6c7ef2cb-71b8-492e-9e11-4ddfacf29d0c",
};

export function getDeviceName(deviceId: string | undefined): string {
  if (!deviceId) {
    return "unknown";
  }
  return DEVICE_NAMES[deviceId] ?? deviceId;
}

/** Known boards in their listed order; unknown ones first, like before. */
export function deviceSortIndex(deviceId: string): number {
  return Object.keys(DEVICE_NAMES).indexOf(deviceId);
}

/**
 * Pings the board's healthchecks.io check. path is "" (success), "/log" or
 * "/failure". Failures are logged, never thrown.
 */
// Like the Flask server: don't let a slow healthchecks.io hold a request open.
const HEALTHCHECK_TIMEOUT_MS = 10_000;

/**
 * Whether this server is the one the boards' healthchecks.io checks belong
 * to: HEALTHCHECKS=on in the production Worker (wrangler.jsonc) and the
 * self-hosted image, never in previews or `pnpm dev` (vite.config.ts). The
 * Worker tests turn it on too, with fetch stubbed.
 */
export function healthchecksOn(env: { HEALTHCHECKS?: string }): boolean {
  return env.HEALTHCHECKS === "on";
}

export async function pingHealthcheck(
  deviceId: string | undefined,
  path: "" | "/log" | "/failure",
  data: string,
): Promise<void> {
  const url = deviceId ? HEALTHCHECKS_PING_URLS[deviceId] : undefined;
  if (!url) {
    console.log(`Warning: No healthcheck URL found for ${deviceId}`);
    return;
  }
  try {
    await fetch(url + path, {
      method: "POST",
      body: data,
      signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
    });
  } catch {
    console.log(`Warning: Healthcheck ping failed for ${deviceId}`);
  }
}

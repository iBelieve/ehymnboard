import { vi } from "vitest";

/** A healthchecks.io ping the Worker sent. */
export interface Ping {
  url: string;
  body: string;
}

/**
 * Stubs fetch (healthcheck pings are the only outbound requests) and
 * returns the list each ping is added to. Empty it with `length = 0`.
 */
export function recordPings(): Ping[] {
  const pings: Ping[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    pings.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return Promise.resolve(new Response(null, { status: 200 }));
  });
  return pings;
}

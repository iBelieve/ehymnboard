import { exports } from "cloudflare:workers";

export const BASE = "https://hymnboard.sonrise.io";
export const ADMIN = {
  name: "Admin",
  email: "admin@example.com",
  password: "correct horse battery",
};

/** A JSON POST from the admin page (same origin, as a browser sends it). */
export function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { Origin: BASE, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

let addresses = 0;

/**
 * Signs in, returning the session cookie as request headers. Each sign-in
 * comes from its own address, as Cloudflare reports it, so that Better
 * Auth's limit on sign-ins per address doesn't trip.
 */
export async function signIn(email: string, password: string): Promise<Record<string, string>> {
  const ip = `192.0.2.${++addresses}`;
  const res = await post(
    "/api/auth/sign-in/email",
    { email, password },
    { "CF-Connecting-IP": ip },
  );
  if (!res.ok) {
    throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
  }
  const cookie = res.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  return { Cookie: cookie };
}

let admin: Promise<Record<string, string>> | undefined;

/**
 * The first account, an admin, created through the setup the admin page
 * offers, and signed in. Once per test file (each has its own storage).
 */
export function signInAsAdmin(): Promise<Record<string, string>> {
  admin ??= (async () => {
    const res = await post("/api/setup", { setupPassword: "setup-secret", ...ADMIN });
    if (res.status !== 201 && res.status !== 409) {
      throw new Error(`Setup failed: ${res.status} ${await res.text()}`);
    }
    return signIn(ADMIN.email, ADMIN.password);
  })();
  return admin;
}

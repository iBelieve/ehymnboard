import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { ADMIN, BASE, post, signIn, signInAsAdmin } from "./signIn";

function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(`${BASE}${path}`, { headers }));
}

function upload(headers: Record<string, string>) {
  const form = new FormData();
  form.set("version", "v7");
  form.set("image", new File([new Uint8Array(512)], "fw.bin"));
  return exports.default.fetch(
    new Request(`${BASE}/firmware`, { method: "POST", headers, body: form }),
  );
}

let users = 0;

/** A new account with the "user" role, made by the admin, and signed in. */
async function signInAsUser() {
  const email = `user${++users}@example.com`;
  const password = "another good password";
  const res = await post(
    "/api/auth/admin/create-user",
    { name: "Organist", email, password, role: "user" },
    await signInAsAdmin(),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return signIn(email, password);
}

test("setup creates the first account, an admin, then refuses another", async () => {
  expect(await (await get("/api/setup")).json()).toEqual({ needed: true });
  expect((await post("/api/setup", { ...ADMIN, setupPassword: "wrong" })).status).toBe(403);
  expect((await post("/api/setup", { ...ADMIN })).status).toBe(403);
  // An account Better Auth refuses is a 400, and setup stays open.
  const refused = { ...ADMIN, setupPassword: "setup-secret" };
  expect((await post("/api/setup", { ...refused, email: "admin@localhost" })).status).toBe(400);
  expect((await post("/api/setup", { ...refused, password: "short" })).status).toBe(400);
  expect(await (await get("/api/setup")).json()).toEqual({ needed: true });

  const headers = await signInAsAdmin();
  expect(await (await get("/api/setup")).json()).toEqual({ needed: false });
  const session = await (await get("/api/auth/get-session", headers)).json();
  expect(session).toMatchObject({ user: { email: ADMIN.email, role: "admin" } });

  const again = { ...ADMIN, email: "second@example.com", setupPassword: "setup-secret" };
  expect((await post("/api/setup", again)).status).toBe(409);
  // Not a way to check guesses at the setup password any more
  expect((await post("/api/setup", { ...again, setupPassword: "wrong" })).status).toBe(409);
});

/** The admin signing in from a page at `origin`. */
function signInFrom(origin: string) {
  return post(
    "/api/auth/sign-in/email",
    { email: ADMIN.email, password: ADMIN.password },
    { Origin: origin, "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": "203.0.113.9" },
  );
}

test("refuses a sign-in from another site", async () => {
  await signInAsAdmin();
  expect((await signInFrom(BASE)).status).toBe(200);
  expect((await signInFrom("https://elsewhere.example")).status).toBe(403);
});

test("an admin can't add an account with a short password", async () => {
  const res = await post(
    "/api/auth/admin/create-user",
    { name: "Someone", email: "short@example.com", password: "short", role: "user" },
    await signInAsAdmin(),
  );
  expect(res.status).toBe(400);
});

test("a wrong password doesn't sign in", async () => {
  await signInAsAdmin();
  await expect(signIn(ADMIN.email, "wrong password")).rejects.toThrow(/401/);
});

function guess() {
  return post(
    "/api/auth/sign-in/email",
    { email: ADMIN.email, password: "guess" },
    { "CF-Connecting-IP": "198.51.100.1" },
  );
}

test("limits sign-ins from one address", async () => {
  await signInAsAdmin();
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await guess()).status);
  expect(statuses).toEqual([401, 401, 401, 429]);
});

test("nobody can sign up", async () => {
  const res = await post("/api/auth/sign-up/email", {
    name: "Stranger",
    email: "stranger@example.com",
    password: "a long enough password",
  });
  expect(res.ok).toBe(false);
});

test("signing out ends the session", async () => {
  const headers = await signInAsUser();
  expect((await get("/api/state", headers)).status).toBe(200);
  expect((await post("/api/auth/sign-out", {}, headers)).status).toBe(200);
  expect((await get("/api/state", headers)).status).toBe(401);
});

test("users change lines; only admins upload firmware or manage accounts", async () => {
  const headers = await signInAsUser();
  expect((await get("/api/state", headers)).status).toBe(200);
  expect((await upload(headers)).status).toBe(403);
  const create = await post(
    "/api/auth/admin/create-user",
    { name: "Someone", email: "someone@example.com", password: "a fine password" },
    headers,
  );
  expect(create.status).toBe(403);

  expect((await upload(await signInAsAdmin())).status).toBe(201);
});

test("an admin's API key uploads firmware, and only that", async () => {
  const admin = await signInAsAdmin();
  const res = await post("/api/auth/api-key/create", { name: "curl" }, admin);
  expect(res.status, await res.clone().text()).toBe(200);
  const { key } = await res.json<{ key: string }>();
  expect(key).toMatch(/^hb_/);

  expect((await upload({ "X-Api-Key": key })).status).toBe(201);
  expect((await upload({ "X-Api-Key": `${key}x` })).status).toBe(401);
  // Not a session: the rest of the admin still needs signing in.
  expect((await get("/api/state", { "X-Api-Key": key })).status).toBe(401);

  // A user's key is a user's: no firmware.
  const user = await signInAsUser();
  const userKey = await (
    await post("/api/auth/api-key/create", { name: "x" }, user)
  ).json<{ key: string }>();
  expect((await upload({ "X-Api-Key": userKey.key })).status).toBe(403);
});

test("a banned admin's API key stops working", async () => {
  const email = "banned-admin@example.com";
  const password = "a fine admin password";
  const admin = await signInAsAdmin();
  const created = await post(
    "/api/auth/admin/create-user",
    { name: "Former admin", email, password, role: "admin" },
    admin,
  );
  const { user } = await created.json<{ user: { id: string } }>();
  const keyRes = await post(
    "/api/auth/api-key/create",
    { name: "curl" },
    await signIn(email, password),
  );
  const { key } = await keyRes.json<{ key: string }>();
  expect((await upload({ "X-Api-Key": key })).status).toBe(201);

  const ban = await post("/api/auth/admin/ban-user", { userId: user.id }, admin);
  expect(ban.status, await ban.clone().text()).toBe(200);
  expect((await upload({ "X-Api-Key": key })).status).toBe(401);
});

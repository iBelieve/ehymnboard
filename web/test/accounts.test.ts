import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { createFirstAccount, needsSetup } from "../src/worker/accounts";
import worker from "../src/worker/index";
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

// These three run while there's no account yet, before the next test makes one.

test("limits setup tries from one address", async () => {
  const wrong = { ...ADMIN, setupPassword: "wrong" };
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await post("/api/setup", wrong, { "CF-Connecting-IP": "198.51.100.7" })).status);
  }
  expect(statuses).toEqual([403, 403, 403, 429]);
});

test("says so when the server has no setup password", async () => {
  const request = new Request(`${BASE}/api/setup`, {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ ...ADMIN, setupPassword: "" }),
  });
  const res = await worker.fetch(
    request,
    { ...env, SETUP_PASSWORD: undefined },
    createExecutionContext(),
  );
  expect(res.status).toBe(403);
  expect(await res.text()).toMatch(/no SETUP_PASSWORD/);
});

/** The accounts database, where saving a password fails as D1 might. */
function failingPasswords(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (/^insert into "account"/i.test(query)) {
            throw new Error("D1 went away");
          }
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });
}

test("a first account that fails half-way leaves setup open", async () => {
  const failing = { ...env, DB: failingPasswords(env.DB) };
  const created = await createFirstAccount(failing, new Request(`${BASE}/api/setup`), ADMIN);
  expect(created).toEqual(expect.any(String));
  expect(await needsSetup(env)).toBe(true);
});

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

/** A new API key of the account signed in with `session`. */
async function createKey(session: Record<string, string>): Promise<string> {
  const res = await post("/api/auth/api-key/create", { name: "a workflow" }, session);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json<{ key: string }>()).key;
}

function putLines(headers: Record<string, string>, lines = ["1", "2", "3", "4", "5", "6"]) {
  return exports.default.fetch(
    new Request(`${BASE}/api/lines`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ lines }),
    }),
  );
}

test("an admin's API key uploads firmware and sets the lines", async () => {
  const key = await createKey(await signInAsAdmin());
  expect(key).toMatch(/^hb_/);

  expect((await upload({ "X-Api-Key": key })).status).toBe(201);
  expect((await upload({ Authorization: `Bearer ${key}` })).status).toBe(201);
  expect((await upload({ "X-Api-Key": `${key}x` })).status).toBe(401);
  expect((await putLines({ "X-Api-Key": key })).status).toBe(200);
  expect((await get("/api/state", { Authorization: `Bearer ${key}` })).status).toBe(200);
  expect((await get("/api/screens/1", { "X-Api-Key": key })).status).toBe(200);
});

test("a user's API key sets the lines, but uploads no firmware", async () => {
  const key = await createKey(await signInAsUser());
  const res = await putLines({ Authorization: `Bearer ${key}` }, ["Hymn 334", "", "", "", "", ""]);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toMatchObject({ lines: ["Hymn 334", "", "", "", "", ""] });
  expect((await upload({ "X-Api-Key": key })).status).toBe(403);
  expect((await putLines({ Authorization: "Bearer hb_not-a-key" })).status).toBe(401);
  // An empty X-Api-Key (an unset variable) doesn't hide the key in Authorization.
  expect((await putLines({ "X-Api-Key": "", Authorization: `Bearer ${key}` })).status).toBe(200);
});

test("an API key can't manage accounts or keys", async () => {
  const key = await createKey(await signInAsAdmin());
  const ways: Record<string, string>[] = [{ "X-Api-Key": key }, { Authorization: `Bearer ${key}` }];
  for (const headers of ways) {
    const create = await post(
      "/api/auth/admin/create-user",
      { name: "Someone", email: "keyed@example.com", password: "a fine password", role: "admin" },
      headers,
    );
    expect(create.status).toBe(401);
    expect((await post("/api/auth/api-key/create", { name: "more" }, headers)).status).toBe(401);
  }
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
  const key = await createKey(await signIn(email, password));
  expect((await upload({ "X-Api-Key": key })).status).toBe(201);

  const ban = await post("/api/auth/admin/ban-user", { userId: user.id }, admin);
  expect(ban.status, await ban.clone().text()).toBe(200);
  expect((await upload({ "X-Api-Key": key })).status).toBe(401);
});

/** A new "user" account, made by `admin`, with an API key that sets the lines. */
async function volunteerWithKey(admin: Record<string, string>, email: string) {
  const password = "a volunteer password";
  const created = await post(
    "/api/auth/admin/create-user",
    { name: "Volunteer", email, password, role: "user" },
    admin,
  );
  const { user } = await created.json<{ user: { id: string } }>();
  const key = await createKey(await signIn(email, password));
  expect((await putLines({ "X-Api-Key": key })).status).toBe(200);
  return { id: user.id, key };
}

test("setting an account's password, or removing it, deletes its API keys", async () => {
  const admin = await signInAsAdmin();
  const reset = await volunteerWithKey(admin, "reset@example.com");
  const removed = await volunteerWithKey(admin, "removed@example.com");
  // A refused request leaves the keys alone.
  const short = { userId: reset.id, newPassword: "short" };
  expect((await post("/api/auth/admin/set-user-password", short, admin)).status).toBe(400);
  expect((await putLines({ "X-Api-Key": reset.key })).status).toBe(200);

  const set = { userId: reset.id, newPassword: "a brand new password" };
  expect((await post("/api/auth/admin/set-user-password", set, admin)).status).toBe(200);
  expect((await putLines({ "X-Api-Key": reset.key })).status).toBe(401);
  expect((await post("/api/auth/admin/remove-user", { userId: removed.id }, admin)).status).toBe(
    200,
  );
  expect((await putLines({ "X-Api-Key": removed.key })).status).toBe(401);
  const left = await env.DB.prepare(
    `SELECT count(*) AS n FROM "apikey" WHERE "referenceId" IN (?, ?)`,
  )
    .bind(reset.id, removed.id)
    .first<{ n: number }>();
  expect(left?.n).toBe(0);
});

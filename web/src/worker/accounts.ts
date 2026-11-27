import type { BetterAuthOptions } from "better-auth";
import type { Viewer } from "../shared/api";
import { migrateDatabase } from "./account-migrations";

/** Better Auth's shortest secret. */
const MIN_SECRET_LENGTH = 32;

/** How long a first account's setup may take before another may start over. */
const SETUP_CLAIM_MS = 60_000;

/**
 * Setup tries allowed from one address in SETUP_WINDOW_MS: as many as
 * Better Auth allows sign-ins (3 in 10 s), so the setup password is no
 * easier to guess than an account's.
 */
const SETUP_ATTEMPTS = 3;
const SETUP_WINDOW_MS = 10_000;

/** Whose address a request is: the one Cloudflare saw. */
const IP_ADDRESS = { ipAddressHeaders: ["cf-connecting-ip"] };

/** What the first account's setup needs. */
export type FirstAccount = { name: string; email: string; password: string };

/**
 * Better Auth, loaded only here: the Worker's other requests, the boards'
 * above all, never load it.
 */
async function createAuth(db: D1Database, secret: string, baseURL: string) {
  const [{ apiKey }, { betterAuth }, { APIError, createAuthMiddleware }, { admin }] =
    await Promise.all([
      import("@better-auth/api-key"),
      import("better-auth"),
      import("better-auth/api"),
      import("better-auth/plugins"),
    ]);
  return betterAuth({
    secret,
    // The request's own origin, since the same deploy answers on several
    // hosts (hymnboard.sonrise.io, hymnboard.mluther.org, workers.dev,
    // previews, localhost). Nothing here redirects or emails a link, which is
    // what a fixed one is for. It's also the one origin Better Auth trusts.
    baseURL,
    database: db,
    // Admins add accounts (the admin plugin's createUser); nobody signs up.
    emailAndPassword: { enabled: true, disableSignUp: true },
    // Someone who changes the lines once a week stays signed in.
    session: { expiresIn: 30 * 24 * 60 * 60 },
    plugins: [
      // Roles ("admin" or "user"), and managing accounts and passwords
      admin(),
      // For uploading firmware with curl (see apiKeyViewer)
      apiKey({ defaultPrefix: "hb_", rateLimit: { enabled: false } }),
    ],
    // Counts sign-in attempts per address, by the address Cloudflare saw. In
    // the database, since each isolate's memory sees only its own requests.
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      ipAddress: IP_ADDRESS,
      // Every deploy is served over https (localhost counts as secure too).
      useSecureCookies: true,
      // Better Auth would otherwise read every table's columns and indexes
      // before each instance's first query, and there's an instance per
      // request: 11 more queries on each of the admin's. The tables are
      // checked once, in CI, by test/account-migrations.test.ts instead.
      database: { validateSchema: false },
    },
    telemetry: { enabled: false },
    hooks: {
      // Better Auth checks a new password's length everywhere but in the
      // admin plugin's createUser, which makes the first account and the
      // ones admins add.
      before: createAuthMiddleware((ctx) => {
        const body: unknown = ctx.body;
        const password =
          typeof body === "object" && body !== null && "password" in body
            ? body.password
            : undefined;
        const min = ctx.context.password.config.minPasswordLength;
        if (
          ctx.path === "/admin/create-user" &&
          typeof password === "string" &&
          password.length < min
        ) {
          return Promise.reject(
            new APIError("BAD_REQUEST", {
              message: `Password too short: at least ${min} characters`,
            }),
          );
        }
        return Promise.resolve();
      }),
    },
  });
}

type Auth = Awaited<ReturnType<typeof createAuth>>;

/** Better Auth's options, for checking the tables have all they want. */
export async function authOptions(db: D1Database, secret: string): Promise<BetterAuthOptions> {
  return (await createAuth(db, secret, "https://hymnboard.sonrise.io")).options;
}

/** The accounts databases this isolate has brought up to date. */
const migrated = new WeakSet<D1Database>();

/**
 * Better Auth on the accounts database (the DB binding): every account and
 * session, for every board, since someone signs in before we know which
 * boards they look after. A new one for each request: Better Auth keeps
 * promises of its own, and a Worker can't await one that another request
 * made (it hangs), so none is shared between requests.
 */
async function getAuth(env: Env, request: Request): Promise<Auth> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET must be set, at least ${MIN_SECRET_LENGTH} characters`);
  }
  await migrate(env);
  return createAuth(env.DB, secret, new URL(request.url).origin);
}

/** Brings the accounts database up to date, once per isolate. */
async function migrate(env: Env): Promise<void> {
  if (!migrated.has(env.DB)) {
    await migrateDatabase(env.DB);
    migrated.add(env.DB);
  }
}

/** Better Auth's own endpoints, under /api/auth/. */
export async function handleAuthRequest(env: Env, request: Request): Promise<Response> {
  return (await getAuth(env, request)).handler(request);
}

/** Who's signed in with this request's session cookie, if anyone. */
export async function viewer(env: Env, request: Request): Promise<Viewer | null> {
  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return null;
  }
  const auth = await getAuth(env, request);
  // Without refreshing: a refresh here would extend the session but not the
  // browser's cookie, whose Set-Cookie has nowhere to go, and the admin
  // page's own /api/auth/get-session would then find nothing to refresh.
  // That one, through handleAuthRequest(), refreshes both.
  const session = await auth.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableRefresh: true },
  });
  return session && toViewer(session.user);
}

/** The account an API key belongs to, if the key is valid. */
export async function apiKeyViewer(
  env: Env,
  request: Request,
  key: string,
): Promise<Viewer | null> {
  const result = await (await getAuth(env, request)).api.verifyApiKey({ body: { key } });
  const userId = result.valid ? result.key?.referenceId : undefined;
  if (!userId) {
    return null;
  }
  const user = await env.DB.prepare(
    `SELECT "id", "name", "email", "role", "banned", "banExpires" FROM "user" WHERE "id" = ?`,
  )
    .bind(userId)
    .first<UserRow & { banned: number | null; banExpires: string | null }>();
  // A banned account can't sign in, so its keys don't work either.
  const banned =
    !!user?.banned && (user.banExpires === null || new Date(user.banExpires) > new Date());
  return user && !banned ? toViewer(user) : null;
}

/** True until the first account exists. */
export async function needsSetup(env: Env): Promise<boolean> {
  await migrate(env);
  return (await env.DB.prepare(`SELECT 1 AS "one" FROM "user" LIMIT 1`).first()) === null;
}

/**
 * Counts a try at the first account's setup from this request's address,
 * in Better Auth's rateLimit table (which it also prunes), under a key none
 * of its own endpoints uses. False once the address has tried too often
 * lately. A request with no address (only tests and `wrangler dev`) isn't
 * counted, as Better Auth doesn't count it either.
 */
export async function allowSetupAttempt(env: Env, request: Request): Promise<boolean> {
  if (!request.headers.has("cf-connecting-ip")) {
    return true;
  }
  // Better Auth's reading of the address, so IPv6 counts by subnet as its own
  // limits do
  const { getIP } = await import("better-auth/api");
  const ip = getIP(request, { advanced: { ipAddress: IP_ADDRESS } });
  if (!ip) {
    return true;
  }
  await migrate(env);
  const now = Date.now();
  const count = await env.DB.prepare(
    `INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?1, ?2, 1, ?3)
     ON CONFLICT ("key") DO UPDATE SET
       "count" = CASE WHEN "lastRequest" <= ?4 THEN 1 ELSE "count" + 1 END,
       "lastRequest" = ?3
     RETURNING "count"`,
  )
    .bind(crypto.randomUUID(), `${ip}|/api/setup`, now, now - SETUP_WINDOW_MS)
    .first<number>("count");
  return (count ?? 1) <= SETUP_ATTEMPTS;
}

/**
 * Creates the first account, an admin, if there's none yet. The Worker
 * checks the setup password first. False if an account already exists, or
 * why it couldn't make one (Better Auth refused it, say, as an invalid
 * email).
 */
export async function createFirstAccount(
  env: Env,
  request: Request,
  account: FirstAccount,
): Promise<boolean | string> {
  const auth = await getAuth(env, request);
  // One at a time, so two setups at once can't both see no accounts: each
  // claims the one setup row first. A claim lapses after a minute, in case
  // its isolate died before finishing.
  const now = Date.now();
  const claim = await env.DB.prepare(
    `INSERT INTO "setup" ("id", "startedAt") VALUES (1, ?1)
     ON CONFLICT ("id") DO UPDATE SET "startedAt" = ?1 WHERE "startedAt" < ?2`,
  )
    .bind(now, now - SETUP_CLAIM_MS)
    .run();
  if (!(await needsSetup(env))) {
    return false;
  }
  if (claim.meta.changes !== 1) {
    return "Someone else is creating the first account; try again in a minute";
  }
  try {
    await auth.api.createUser({ body: { ...account, role: "admin" } });
    return true;
  } catch (error) {
    // D1 has no transactions, so Better Auth may have made the user before
    // failing to save its password: remove it, or setup would be over with
    // nobody able to sign in. Then let the next try go ahead at once.
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM "user" WHERE "email" = ? AND "id" NOT IN (SELECT "userId" FROM "account")`,
      ).bind(account.email.toLowerCase()),
      env.DB.prepare(`DELETE FROM "setup" WHERE "startedAt" = ?`).bind(now),
    ]);
    return error instanceof Error ? error.message : String(error);
  }
}

type UserRow = { id: string; name: string; email: string; role?: string | null };

function toViewer(user: UserRow): Viewer {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role === "admin" ? "admin" : "user",
  };
}

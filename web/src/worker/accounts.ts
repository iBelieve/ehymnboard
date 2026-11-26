import { DurableObject } from "cloudflare:workers";
import type { Viewer } from "../shared/api";
import { ACCOUNT_MIGRATIONS, migrateOnStart } from "./migrations";

/** Better Auth's shortest secret. */
const MIN_SECRET_LENGTH = 32;

/** What the first account's setup needs. */
export type FirstAccount = { name: string; email: string; password: string };

/**
 * Better Auth, loaded only here: the Worker's other requests, the boards'
 * above all, never load it.
 */
async function createAuth(sql: SqlStorage, secret: string) {
  const [{ apiKey }, { betterAuth }, { admin }, { DurableObjectDialect }] = await Promise.all([
    import("@better-auth/api-key"),
    import("better-auth"),
    import("better-auth/plugins"),
    import("./durable-object-dialect"),
  ]);
  return betterAuth({
    secret,
    // No baseURL: it's taken from each request, since the same deploy answers
    // on several hosts (hymnboard.sonrise.io, hymnboard.mluther.org,
    // workers.dev, previews, localhost). Nothing here redirects or emails a
    // link, which is what a fixed one is for.
    database: { dialect: new DurableObjectDialect(sql), type: "sqlite", transaction: false },
    // Admins add accounts (the admin plugin's createUser); nobody signs up.
    emailAndPassword: { enabled: true, disableSignUp: true },
    // Someone who changes the lines once a week stays signed in.
    session: { expiresIn: 30 * 24 * 60 * 60 },
    plugins: [
      // Roles ("admin" or "user"), and managing accounts and passwords
      admin(),
      // For uploading firmware with curl (see verifyApiKey)
      apiKey({ defaultPrefix: "hb_", rateLimit: { enabled: false } }),
    ],
    // Kept in this object's memory, which is fine for one object: it counts
    // sign-in attempts per address, by the address Cloudflare saw.
    rateLimit: { enabled: true, storage: "memory" },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Every deploy is served over https (localhost counts as secure too).
      useSecureCookies: true,
    },
    telemetry: { enabled: false },
  });
}

type Auth = Awaited<ReturnType<typeof createAuth>>;

/**
 * Every account and session, for every board: one instance ("accounts")
 * shared by all of them, since someone signs in before we know which boards
 * they look after. Better Auth runs in here, on this object's SQLite storage;
 * the Worker forwards /api/auth/* to fetch() and asks viewer() about every
 * other admin request.
 */
export class Accounts extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  #auth: Promise<Auth> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    migrateOnStart(ctx, ACCOUNT_MIGRATIONS);
  }

  /** Better Auth, once there's a secret to sign its cookies with. */
  #betterAuth(): Promise<Auth> {
    const secret = this.env.BETTER_AUTH_SECRET;
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`BETTER_AUTH_SECRET must be set, at least ${MIN_SECRET_LENGTH} characters`);
    }
    this.#auth ??= createAuth(this.#sql, secret);
    return this.#auth;
  }

  /** Better Auth's own endpoints, under /api/auth/. */
  override async fetch(request: Request): Promise<Response> {
    return (await this.#betterAuth()).handler(request);
  }

  /** Who's signed in with this request's session cookie, if anyone. */
  async viewer(cookie: string): Promise<Viewer | null> {
    const auth = await this.#betterAuth();
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return session && toViewer(session.user);
  }

  /** The account an API key belongs to, if the key is valid. */
  async apiKeyViewer(key: string): Promise<Viewer | null> {
    const result = await (await this.#betterAuth()).api.verifyApiKey({ body: { key } });
    const userId = result.valid ? result.key?.referenceId : undefined;
    if (!userId) {
      return null;
    }
    const user = this.#sql
      .exec<UserRow>(`SELECT "id", "name", "email", "role" FROM "user" WHERE "id" = ?`, userId)
      .toArray()[0];
    return user ? toViewer(user) : null;
  }

  /** True until the first account exists. */
  needsSetup(): boolean {
    return this.#sql.exec(`SELECT 1 FROM "user" LIMIT 1`).toArray().length === 0;
  }

  /**
   * Creates the first account, an admin, if there's none yet. The Worker
   * checks the setup password first. False if an account already exists.
   */
  createFirstAccount(account: FirstAccount): Promise<boolean> {
    // One at a time, so two setups at once can't both see no accounts.
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.needsSetup()) {
        return false;
      }
      const auth = await this.#betterAuth();
      await auth.api.createUser({ body: { ...account, role: "admin" } });
      return true;
    });
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

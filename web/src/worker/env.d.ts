// Secrets (`wrangler secret put`, or `.dev.vars` locally), so
// `wrangler types` can't see them.
interface Env {
  // Signs Better Auth's session cookies: at least 32 random characters
  // (`openssl rand -base64 32`). The admin refuses to sign anyone in without it.
  BETTER_AUTH_SECRET?: string;
  // Lets whoever knows it create the first account, an admin, while there's
  // none. Unset, nobody can.
  SETUP_PASSWORD?: string;
  // Comma-separated board IDs allowed on /ws besides the known boards: the
  // e2e tests' emulated board. Unset in production.
  EXTRA_DEVICE_IDS?: string;
}

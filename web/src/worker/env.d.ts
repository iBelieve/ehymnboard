// Secrets set in the environment (dokku config or `wrangler secret put`), so
// `wrangler types` can't see them. Leave both unset to disable basic auth.
interface Env {
  BASIC_AUTH_USERNAME?: string;
  BASIC_AUTH_PASSWORD?: string;
}

// Secrets (`wrangler secret put`, or the environment in the Docker image), so
// `wrangler types` can't see them. Leave both unset to disable basic auth.
interface Env {
  BASIC_AUTH_USERNAME?: string;
  BASIC_AUTH_PASSWORD?: string;
  // Comma-separated board IDs allowed on /ws besides the known boards: the
  // e2e tests' emulated board. Unset in production.
  EXTRA_DEVICE_IDS?: string;
}

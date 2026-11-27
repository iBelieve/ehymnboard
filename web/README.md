# eHymnBoard web app and backend (Workers)

The hymn board server: a Cloudflare Worker written in TypeScript with
[Hono](https://hono.dev), a React admin built with Vite, and a single
`HymnBoard` Durable Object (SQLite-backed) that holds the lines, the rendered
screens, device status and the OTA firmware image. Production runs on
Cloudflare as the Worker `hymnboard`, at `hymnboard.sonrise.io` (see
"Cloudflare (production)").

## Layout

| Path          | What it is                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/worker/` | Hono routes (`index.ts`), the `HymnBoard` Durable Object, device names and healthchecks.io pings             |
| `src/client/` | The React admin: line editor, live board preview, device status                                              |
| `src/shared/` | Code both sides run: screen geometry, API types, and the 1-bit text rasterizer (opentype.js + scanline fill) |
| `test/`       | Rasterizer tests against reference screens (`fixtures/render/`) and endpoint tests in the Workers runtime    |

The device protocol keeps the endpoints of the old Flask server (`server/` at
commit 02ece7f) byte for byte: `GET /images/{1,2,3}` returns the raw
81,600-byte buffer with a bare SHA-1 `ETag` (or 304 for a matching `?etag=`),
plus `/device_booted`, `/device_healthy` (which no board calls now), `/ok`,
and the OTA endpoints `/firmware/latest` and `/firmware/image`.

Boards also keep a WebSocket open at `GET /ws` (the messages are in
[device/README.md](../device/README.md#talking-to-the-server)), so the
server pushes each change instead of the boards polling. The `HymnBoard`
Durable Object accepts the sockets with the Hibernation API, tagged by board,
so it can be evicted between changes while the sockets stay
open: the runtime answers the boards' `ping` with `pong` itself
(`setWebSocketAutoResponse`), and each socket's board ID is in its
attachment. Applying lines or uploading firmware sends every board the new
`state`. Only the boards in `src/worker/devices.ts` may connect (403
otherwise), plus any in `EXTRA_DEVICE_IDS` (comma separated, for the e2e
tests' emulated board; leave it unset in production). While any board is
connected, an alarm every 10 minutes pings each live board's
healthchecks.io check (so the boards needn't call `/device_healthy`) and
closes sockets that stopped pinging. Sockets stay open across a deploy, but
their ping times stop updating, so after a deploy the boards' sockets from
before it are closed (code 4002) by whichever comes first: the admin's next
look at the boards, a board connecting or sending `shown` (its pings don't
wake the Durable Object), or the alarm, and the boards reconnect. A socket
opening and closing is logged
to the board's check too (pings need `HEALTHCHECKS=on`, which the production
Worker and the Worker tests (with `fetch` mocked) set, and previews,
`pnpm dev` and the e2e tests' server don't), and the admin shows each board as
Live or Offline.

## Development

```sh
pnpm install
pnpm dev          # Vite + the Worker in the Workers runtime, with hot reload, on :8000
pnpm test         # rasterizer + Worker tests
pnpm typecheck && pnpm lint   # tsc 7, oxlint (type-aware via tsrs); Prettier runs from the root
pnpm build        # dist/client (admin) and dist/hymnboard (Worker)
```

Basic auth is off unless `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` are
set (for `pnpm dev`, put them in `.dev.vars`). `pnpm dev` turns
`wrangler.jsonc`'s `HEALTHCHECKS=on` off (in `vite.config.ts`), so local
requests never ping the boards' real checks. After changing
`wrangler.jsonc`, run `pnpm exec wrangler types` to regenerate
`worker-configuration.d.ts`, with `.dev.vars` moved aside: the command reads
it too, and would declare its secrets as always set.

The e2e tests (`e2e/`) run this package's build themselves, under
`wrangler dev`, so they need no server started first (see
[e2e/README.md](../e2e/README.md)).

## Cloudflare (production)

Production is the Worker `hymnboard` in the Sonrise Software account, at
`https://hymnboard.sonrise.io` (the boards' address),
`https://hymnboard.mluther.org` (the church's address for the admin), both
Workers custom domains, and <https://hymnboard.sonrise.workers.dev>. Its Durable Object holds the lines,
device status and firmware the boards use.
`wrangler.jsonc` sets `HEALTHCHECKS=on`, so it pings the boards'
healthchecks.io checks (previews don't inherit it).

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
deploys every push to `master` that changes the web app. Its settings (Worker
**hymnboard** > Settings > Build):

| Setting           | Value                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Branch            | `master`                                                                                                |
| Root directory    | `web`                                                                                                   |
| Build command     | `pnpm install --frozen-lockfile --filter ehymnboard-web && pnpm run build`                              |
| Deploy command    | `pnpm exec wrangler deploy`                                                                             |
| Build watch paths | `web/*`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.node-version`, `tsconfig.base.json` |

The build variable `SKIP_DEPENDENCY_INSTALL=1` turns off Workers Builds' own
install, which would install the whole workspace; the build command installs
only `web/`'s dependencies instead. Workers Builds takes
pnpm from the root `package.json`'s `packageManager` and Node from
`.node-version`. `wrangler deploy` reads the config the Vite build wrote
(`.wrangler/deploy/config.json` points it at `dist/hymnboard/wrangler.json`),
so it deploys exactly what was built.

Basic auth comes from the Worker's secrets, `BASIC_AUTH_USERNAME` and
`BASIC_AUTH_PASSWORD` (Settings > Variables and Secrets, or
`pnpm exec wrangler secret put BASIC_AUTH_PASSWORD`). Without them the admin
is open to anyone, so keep them set, and set them before the first deploy of
any new Worker.

### Previews

Every push to another branch that changes the web app gets its own
[Worker Preview](https://developers.cloudflare.com/workers/previews/): a URL
of its own, shown in a comment on the pull request, with its own empty Durable
Object, so a branch never touches the main deploy's data or another branch's.
Previews don't inherit bindings or vars, so `wrangler.jsonc`'s `previews`
block repeats the Durable Object binding; it has no `HEALTHCHECKS`,
so previews never ping healthchecks.io. It sets `EXTRA_DEVICE_IDS` to the
emulated board's ID, so the e2e tests can run against a preview. Workers Builds runs the same build
command and variable for previews, with `pnpm exec wrangler preview` as the
preview command.

Preview URLs are public, so the basic-auth secrets are set in the Previews
base config too (`pnpm exec wrangler preview base-config secret put
BASIC_AUTH_PASSWORD`, and the same for the username); new previews start
with them.

### Boards on TLS

The boards talk only to `https://hymnboard.sonrise.io` and
`wss://hymnboard.sonrise.io/ws` on port 443, and check the server's
certificate (see `device/README.md`).

`.github/workflows/check-tls-roots.yml` checks daily that Cloudflare's
certificate for `hymnboard.sonrise.io` (and the Worker's `workers.dev` name)
still chains to a root the boards trust.

### Production setup

- `hymnboard.sonrise.io` is a custom domain of the Worker (Worker
  **hymnboard** > Settings > Domains & Routes). It has no DNS record of its
  own besides the one the custom domain makes, and its certificate is
  Cloudflare's for custom domains; `check-tls-roots.yml` checks daily that the
  boards trust it.
- `hymnboard.mluther.org`, the address the church uses for the admin, is a
  custom domain of the Worker too.
- The zone's **WebSockets** setting must stay on for the boards' sockets.
- The boards' sockets hibernate, so they only wake the Durable
  Object for a `shown` message or a socket opening or closing. Otherwise it
  runs for HTTP requests (the admin's, and the boards' at boot, after a
  change and for the hourly firmware check) and the 10 minute alarm.
- Keep the ETag unquoted: the firmware stores the header value as is.

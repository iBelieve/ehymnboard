# eHymnBoard web app and backend (Workers)

The hymn board server (it replaced the Flask app that lived in `server/`,
last at commit 02ece7f): a Cloudflare Worker written in TypeScript with
[Hono](https://hono.dev), a React admin built with Vite, and a single
`HymnBoard` Durable Object (SQLite-backed) that holds the lines, the rendered
screens, device status and the OTA firmware image. Production runs on
Cloudflare as the Worker `hymnboard`, at `hymnboard.sonrise.io` (see
"Cloudflare (production)"). The same build can be self-hosted on
[workerd](https://github.com/cloudflare/workerd) in Docker with dokku, where
production ran until 2026-11-23.

## Layout

| Path          | What it is                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/worker/` | Hono routes (`index.ts`), the `HymnBoard` Durable Object, device names and healthchecks.io pings             |
| `src/client/` | The React admin: line editor, live board preview, device status                                              |
| `src/shared/` | Code both sides run: screen geometry, API types, and the 1-bit text rasterizer (opentype.js + scanline fill) |
| `selfhost/`   | workerd config generator and a tiny static-assets Worker that stands in for Workers Static Assets            |
| `test/`       | Rasterizer tests against Flask's output (`fixtures/flask/`) and endpoint tests in the Workers runtime        |

The device protocol keeps the Flask server's endpoints byte for byte:
`GET /images/{1,2,3}` returns the raw 81,600-byte buffer with a bare SHA-1
`ETag` (or 304 for a matching `?etag=`), plus `/device_booted`,
`/device_healthy` (for firmware from before the WebSocket), `/ok`, and the
OTA endpoints `/firmware/latest` and `/firmware/image`.

Boards also keep a WebSocket open at `GET /ws` (the messages are in
[device/README.md](../device/README.md#talking-to-the-server)), so the
server pushes each change instead of the boards polling. The `HymnBoard`
Durable Object accepts the sockets with the Hibernation API, tagged by board,
so on Cloudflare it can be evicted between changes while the sockets stay
open: the runtime answers the boards' `ping` with `pong` itself
(`setWebSocketAutoResponse`), and each socket's board ID is in its
attachment. Applying lines or uploading firmware sends every board the new
`state`. Only the boards in `src/worker/devices.ts` may connect (403
otherwise), plus any in `EXTRA_DEVICE_IDS` (comma separated, for the e2e
tests' emulated board; leave it unset in production). While any board is
connected, an alarm every 10 minutes pings each live board's
healthchecks.io check (the boards no longer call `/device_healthy`) and
closes sockets that stopped pinging. After a deploy, the boards' sockets from
before it are closed (code 4002) by whichever comes first: the admin's next
look at the boards, a board connecting or sending a message, or the alarm.
They reconnect: on Cloudflare those sockets stay open, but their ping times
stop updating. A socket opening and closing is logged
to the board's check too (pings need `HEALTHCHECKS=on`, which the production
Worker, the self-hosted image and the Worker tests (with `fetch` mocked) set,
and previews and `pnpm dev` don't), and the admin shows each board as Live or
Offline.

## Development

```sh
pnpm install
pnpm dev          # Vite + the Worker in workerd, with hot reload, on :8000
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

## Self-hosting (dokku)

Production ran on the dokku app `hymnboard` until the move to Cloudflare on
2026-11-23; it's kept as a fallback (see "Rolling back to dokku" below). The
Docker image runs the built Worker on workerd and stores Durable Object
data under `/data`, which must be a persistent volume. Run the `dokku`
commands on the host, or from a machine on the tailnet as
`ssh dokku@dev.sonrise.io dokku …`.

```sh
APP=hymnboard-next   # any name for a new app; production is hymnboard
dokku apps:create "$APP"
# Build web/Dockerfile from the repository root, where the pnpm workspace's
# lockfile is (the root .dockerignore sends only what web/ needs).
dokku builder:set "$APP" selected dockerfile
dokku builder-dockerfile:set "$APP" dockerfile-path web/Dockerfile
dokku storage:ensure-directory "$APP"
dokku storage:mount "$APP" "/var/lib/dokku/data/storage/$APP:/data"
dokku config:set "$APP" BASIC_AUTH_USERNAME=... BASIC_AUTH_PASSWORD=...
git push "dokku@dev.sonrise.io:$APP" master
```

An app set up before the pnpm workspace builds from `web/` alone
(`build-dir web`), which no longer has a lockfile. The production app,
`hymnboard`, is one: switch it over before deploying a commit with the
workspace:

```sh
dokku builder:set "$APP" build-dir   # clear it: build from the repository root
dokku builder:set "$APP" selected dockerfile
dokku builder-dockerfile:set "$APP" dockerfile-path web/Dockerfile
```

Rolling back to an image built before this (`dokku git:from-image`, or a
commit from before the workspace) needs the old settings back first: clear
`dockerfile-path` (`dokku builder-dockerfile:set "$APP" dockerfile-path`)
and set `build-dir` to the directory that commit builds from.

The image listens on `$PORT`, or 8000 when it isn't set (as with `docker run`
and `pnpm dev`). Dokku's nginx passes WebSocket upgrades through, and the
boards ping every 30 s, well inside nginx's default 60 s `proxy_read_timeout`;
workerd keeps the sockets in memory, so a redeploy drops them and the boards
reconnect within a few seconds. Dokku sets `PORT` (5000 unless the app says otherwise) and
proxies port 80 to it, so there's no `ports:set` step. If
`dokku ports:report "$APP"` shows a mapping from earlier, its container port
must match `PORT`.

The Durable Object's SQLite database lives in
`/var/lib/dokku/data/storage/$APP/ehymnboard-HymnBoard/` on the host. To start
an app over with empty data, `dokku ps:stop "$APP"`, delete that directory,
then `dokku ps:start "$APP"`.

The boards need firmware with the case-insensitive header parsing from PR #16
(both run it since 688965a): workerd always writes the header as `ETag`, and
older firmware only matched `Etag: `.

### Rolling out the WebSocket

Deploy the server first: firmware from before the WebSocket keeps polling and
calling `/device_healthy`, which still work. Then publish the new firmware
(see [device/README.md](../device/README.md#releasing-an-update)); the old
firmware finds it within 10 minutes. Each board commits it once its socket
gets its first `state`, and shows Live on the admin page. From then on, don't
roll the server back to a build without `/ws`: the boards would never get a
live socket and would reboot every 3 minutes (their screens stay as they
are) until it's back.

### Rolling out alongside the Flask app

The Flask app (`hymnboard`) keeps running untouched the whole time, so rolling
back is one command away. Its code is no longer in this repository, so rolling
back uses the build that app already has deployed, not a redeploy from
`master`. Don't push `master` to `hymnboard`: it no longer has the Flask app.
If the Flask app ever has to be rebuilt, deploy commit 02ece7f, the last with
`server/`, the same way it was deployed before:

```sh
git push dokku@dev.sonrise.io:hymnboard 02ece7f:refs/heads/master   # its deploy branch
```

1. **Deploy next to it** with the steps above and a temporary domain, such as
   `dokku domains:set "$APP" hymnboard-next.sonrise.io`. The
   Cloudflare-proxied `*.sonrise.io` wildcard already points at this host, so
   that needs no DNS change. Check the admin at `https://hymnboard-next.sonrise.io`.
2. **Copy the lines.** Nothing is migrated: type the six lines from the Flask
   admin into the new one, so the boards keep showing the same hymns.
3. **Switch the boards.** `api.hymnboard.sonrise.io` and the admin domain
   resolve to this same host either way, so the switch is a dokku domain move,
   not a DNS change. It takes effect when nginx reloads, within seconds:

   ```sh
   dokku domains:remove hymnboard api.hymnboard.sonrise.io hymnboard.sonrise.io
   dokku domains:add "$APP" api.hymnboard.sonrise.io hymnboard.sonrise.io
   ```

   Requests in the moment between the two commands miss both apps, and the
   boards simply retry on their next poll. The `mluther.org` names can follow
   the same way, or stay on the Flask app.

4. **Watch.** Every screen has a new ETag, so each board downloads each screen
   once (three "Updating image" entries per board in healthchecks.io), then
   gets 304s. In the admin, "last seen" keeps moving while "last updated"
   stays put. A board that keeps re-downloading gets a "Re-downloading every
   poll" badge and one healthchecks.io failure, "Board isn't keeping its ETag",
   after three identical downloads in a row.
5. **Roll back if needed** by running the two commands with the apps swapped.
   The Flask app's data was never touched, so it serves the lines it had at the
   switch. Retype any lines changed in the meantime, and re-upload any OTA
   firmware uploaded to the new app. Each board redraws once more on the way
   back.
6. **Once it's settled**, stop the Flask app (`dokku ps:stop hymnboard`) and
   destroy it later. Device status and firmware live in each app's own storage,
   so nothing needs to be copied back.

## Cloudflare (production)

Production is the Worker `hymnboard` in the Sonrise Software account, at
`https://hymnboard.sonrise.io` (the boards' address),
`https://hymnboard.mluther.org` (the church's address for the admin), both
Workers custom domains, and <https://hymnboard.sonrise.workers.dev>. Its Durable Object holds the lines,
device status and firmware the boards use; the dokku app's are separate.
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
only `web/`'s dependencies instead, as `Dockerfile` does. Workers Builds takes
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

Firmware with TLS (see `device/README.md`) talks only to
`https://hymnboard.sonrise.io` and `wss://hymnboard.sonrise.io/ws` on port
443, and checks Cloudflare's certificate. Firmware from before it talks plain
HTTP to `api.hymnboard.sonrise.io` on port 80. That name has no valid
certificate (Universal SSL covers `*.sonrise.io`, one level deep), which is
why the boards move to `hymnboard.sonrise.io`. The server answers the same on
either name, so the move is the firmware's alone:

1. **Publish the TLS firmware** as the release (`POST /firmware`). Boards on
   the old firmware download it over plain HTTP from `api.`, as before.
2. **Each board commits it** once its `wss://` socket is live and a version
   check over `https://` succeeds. A board that can't do both rolls back to
   the old firmware and stays on `api.`; the devices page shows the rollback.
3. **Remove `api.`** once the devices page shows every board on the TLS
   firmware with no rollback (or its custom domain, on the Worker). After
   that, **Always Use HTTPS** can be on for the whole zone:

   ```sh
   dokku domains:remove hymnboard api.hymnboard.sonrise.io
   ```

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
  custom domain of the Worker too. It replaced that name's proxied A record
  to the dokku host (the address the `*.sonrise.io` wildcard has).
- The zone's **WebSockets** setting must stay on for the boards' sockets.
- Every board runs the TLS firmware, so nothing uses `api.hymnboard.sonrise.io`
  any more. A board on firmware from before TLS would need that name pointed
  at the Worker, with **Always Use HTTPS** and HSTS off for it.
- On Cloudflare the boards' sockets hibernate, so the Durable Object only runs
  for a change, a `shown` message, a socket opening or closing, and the 10
  minute alarm.
- Keep the ETag unquoted: the firmware stores the header value as is.

### Rolling back to dokku

First publish the firmware the boards run on the dokku app (`POST /firmware`,
as in [device/README.md](../device/README.md#releasing-an-update)), through a
temporary domain the wildcard already reaches, such as
`dokku domains:add hymnboard hymnboard-fallback.sonrise.io`. A board installs
any version the server offers that differs from its own, so an older release
left on the dokku app would downgrade every board as soon as it connects.

Then delete both custom domains, and add `hymnboard.mluther.org`'s A record
back (proxied, with the `*.sonrise.io` wildcard's address). `hymnboard.sonrise.io`
then matches the proxied `*.sonrise.io` wildcard again, which leads to the
dokku host, where the `hymnboard` app still serves both names. The boards
reconnect within a minute or two. The dokku app has its own data, so set the
lines there again.

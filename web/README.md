# eHymnBoard web app and backend (Workers)

The hymn board server (it replaced the Flask app that lived in `server/`,
last at commit 02ece7f): a Cloudflare Worker written in TypeScript with
[Hono](https://hono.dev), a React admin built with Vite, and a single
`HymnBoard` Durable Object (SQLite-backed) that holds the lines, the rendered
screens, device status and the OTA firmware image. It is self-hosted on
[workerd](https://github.com/cloudflare/workerd) in Docker today and can move
to Cloudflare later with `wrangler deploy` and a DNS change.

## Layout

| Path          | What it is                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/worker/` | Hono routes (`index.ts`), the `HymnBoard` Durable Object, device names and healthchecks.io pings             |
| `src/client/` | The React admin: line editor, live board preview, device status                                              |
| `src/shared/` | Code both sides run: screen geometry, API types, and the 1-bit text rasterizer (opentype.js + scanline fill) |
| `selfhost/`   | workerd config generator and a tiny static-assets Worker that stands in for Workers Static Assets            |
| `test/`       | Rasterizer tests against Flask's output (`fixtures/flask/`) and endpoint tests in the Workers runtime        |

The device protocol is unchanged from the Flask server: `GET /images/{1,2,3}`
returns the raw 81,600-byte buffer with a bare SHA-1 `ETag` (or 304 for a
matching `?etag=`), plus `/device_booted`, `/device_healthy`, `/ok`, and the
OTA endpoints `/firmware/latest` and `/firmware/image`.

## Development

```sh
pnpm install
pnpm dev          # Vite + the Worker in workerd, with hot reload, on :8000
pnpm test         # rasterizer + Worker tests
pnpm typecheck && pnpm lint   # tsc 7, oxlint (type-aware via tsrs); Prettier runs from the root
pnpm build        # dist/client (admin) and dist/hymnboard (Worker)
```

Basic auth is off unless `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` are
set (for `pnpm dev`, put them in `.dev.vars`). After changing
`wrangler.jsonc`, run `pnpm exec wrangler types` to regenerate
`worker-configuration.d.ts`.

## Self-hosting (dokku)

The Docker image runs the built Worker on workerd and stores Durable Object
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
and `pnpm dev`). Dokku sets `PORT` (5000 unless the app says otherwise) and
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

## Cloudflare (test deploy)

The same Worker also runs on Cloudflare as `hymnboard`, at
<https://hymnboard.sonrise.workers.dev>, in the Sonrise Software account. It's
for testing, and may become production later; the boards don't use it, and it
has its own Durable Object, so its lines, device status and firmware are
separate from the dokku app's. It never pings healthchecks.io: only the
self-hosted image sets `HEALTHCHECKS=on` (in `selfhost/generate-config.mjs`),
so test traffic can't touch the boards' real checks.

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
deploys every push to `master` that changes the web app. Its settings (Worker
**hymnboard** > Settings > Build):

| Setting           | Value                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Branch            | `master`                                                                                                |
| Root directory    | `web`                                                                                                   |
| Build command     | `pnpm install --frozen-lockfile && pnpm run build`                                                      |
| Deploy command    | `pnpm exec wrangler deploy`                                                                             |
| Build watch paths | `web/*`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.node-version`, `tsconfig.base.json` |

With `web` as the root directory, Workers Builds doesn't see the workspace's
lockfile and would install with npm, so the build variable
`SKIP_DEPENDENCY_INSTALL=1` turns that off and the build command installs
with pnpm instead (Corepack picks the version in the root `package.json`'s
`packageManager`; pnpm finds the workspace root by itself). `wrangler deploy` reads the config
the Vite build wrote (`.wrangler/deploy/config.json` points it at
`dist/hymnboard/wrangler.json`), so it deploys exactly what was built.

Basic auth comes from the Worker's secrets, `BASIC_AUTH_USERNAME` and
`BASIC_AUTH_PASSWORD` (Settings > Variables and Secrets, or
`pnpm exec wrangler secret put BASIC_AUTH_PASSWORD`). Without them the admin
is open to anyone, so keep them set.

### Making it production

Add `"vars": { "HEALTHCHECKS": "on" }` to `wrangler.jsonc` (and stop the dokku
app's pings, or the boards' checks get both), then point
`api.hymnboard.sonrise.io` and `hymnboard.sonrise.io` at the Worker as custom
domains. The boards speak plain HTTP on port 80, so turn off **Always Use
HTTPS** and HSTS for the api hostname. Keep the ETag unquoted: the firmware
stores the header value as is.

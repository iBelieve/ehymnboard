# eHymnBoard web app and backend (Workers)

The successor to `server/`: a Cloudflare Worker written in TypeScript with
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
pnpm dev          # Vite + the Worker in workerd, with hot reload
pnpm test         # rasterizer + Worker tests
pnpm typecheck && pnpm lint && pnpm format:check  # tsc 7, oxlint (type-aware via tsrs), Prettier
pnpm build        # dist/client (admin) and dist/ehymnboard (Worker)
```

Basic auth is off unless `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` are
set (for `pnpm dev`, put them in `.dev.vars`). After changing
`wrangler.jsonc`, run `pnpm exec wrangler types` to regenerate
`worker-configuration.d.ts`.

## Self-hosting (dokku)

The Docker image runs the built Worker on workerd and stores Durable Object
data under `/data`, which must be a persistent volume.

```sh
dokku apps:create hymnboard-web
dokku builder:set hymnboard-web build-dir web
dokku storage:ensure-directory hymnboard-web
dokku storage:mount hymnboard-web /var/lib/dokku/data/storage/hymnboard-web:/data
dokku config:set hymnboard-web BASIC_AUTH_USERNAME=... BASIC_AUTH_PASSWORD=...
dokku ports:set hymnboard-web http:80:5000
git push dokku-web master   # a remote pointing at hymnboard-web
```

The boards need firmware with the case-insensitive header parsing from PR #16
(both run it since 688965a): workerd always writes the header as `ETag`, and
older firmware only matched `Etag: `.

### Rolling out alongside the Flask app

The Flask app (`hymnboard`) keeps running untouched the whole time, so rolling
back is one command away.

1. **Deploy next to it** with the steps above and a temporary domain, such as
   `dokku domains:set hymnboard-web hymnboard-next.sonrise.io`. The
   Cloudflare-proxied `*.sonrise.io` wildcard already points at this host, so
   that needs no DNS change. Check the admin at `https://hymnboard-next.sonrise.io`.
2. **Copy the lines.** Nothing is migrated: type the six lines from the Flask
   admin into the new one, so the boards keep showing the same hymns.
3. **Switch the boards.** `api.hymnboard.sonrise.io` and the admin domain
   resolve to this same host either way, so the switch is a dokku domain move,
   not a DNS change. It takes effect when nginx reloads, within seconds:

   ```sh
   dokku domains:remove hymnboard api.hymnboard.sonrise.io hymnboard.sonrise.io
   dokku domains:add hymnboard-web api.hymnboard.sonrise.io hymnboard.sonrise.io
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

## Moving to Cloudflare later

`pnpm build && pnpm exec wrangler deploy`, then point
`api.hymnboard.sonrise.io` at the Worker. The boards speak plain HTTP on port
80, so turn off **Always Use HTTPS** and HSTS for that hostname. Keep the ETag
unquoted: the firmware stores the header value as is.

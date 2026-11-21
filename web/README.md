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

> **Flash the boards first.** workerd sends the header as `ETag`. Firmware
> before the case-insensitive header parsing in PR #16 only recognizes
> `Etag`, never adopts the new tag, and would redraw every screen every 15
> seconds.

```sh
dokku apps:create hymnboard-web
dokku builder:set hymnboard-web build-dir web
dokku storage:ensure-directory hymnboard-web
dokku storage:mount hymnboard-web /var/lib/dokku/data/storage/hymnboard-web:/data
dokku config:set hymnboard-web BASIC_AUTH_USERNAME=... BASIC_AUTH_PASSWORD=...
dokku ports:set hymnboard-web http:80:5000
git push dokku-web master   # a remote pointing at hymnboard-web
```

Try it on a temporary domain, then move `api.hymnboard.sonrise.io` (and the
admin domain) from the Flask app to `hymnboard-web` with `dokku domains:remove`
and `dokku domains:add`. To roll back, move the domains back; the Flask app
keeps its own data.

Lines aren't migrated: type them in once after the switch. Every screen gets a
new ETag, so each board redraws once.

## Moving to Cloudflare later

`pnpm build && pnpm exec wrangler deploy`, then point
`api.hymnboard.sonrise.io` at the Worker. The boards speak plain HTTP on port
80, so turn off **Always Use HTTPS** and HSTS for that hostname. Keep the ETag
unquoted: the firmware stores the header value as is.

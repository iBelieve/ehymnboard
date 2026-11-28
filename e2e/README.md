# Full-stack end-to-end tests

These tests run the whole system the way it runs in church. The real
firmware runs in the [emulator](../device/emulator/README.md) and talks to a
running hymn board server over real HTTP. A browser drives that server's
admin page with [Playwright](https://playwright.dev). The tests never reach
into the server: the usher's side goes through the page, as a person would,
and the board's side is the firmware's own HTTP client. A server rewrite is
held to the same tests as the server it replaces: if it behaves the same,
the tests pass unchanged. They start the server themselves: `web/`'s build,
run locally by `wrangler dev` (the Workers runtime under Miniflare, as in
production), so they need nothing running first. CI (the `e2e` job in
`.github/workflows/ci.yml`) runs them the same way.

| Test file       | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hymns.spec.ts` | Lines typed on the admin page are pushed to the board within a second and reach the right screen and band, each change is downloaded and drawn once and only for the screens it touches, no downloads in between (no polling), the admin's board picture matches the panels pixel for pixel, Clear, a power cut keeps the ETags, and a board cut off from the server catches up when it's back (Live and Offline on the Hymn Boards page) |
| `ota.spec.ts`   | A release published with `POST /firmware` is pushed to the board, downloaded, installed through the bootloader, committed and reported on the Hymn Boards page, with the screens kept                                                                                                                                                                                                                                                     |

## How it fits together

The emulator's LAN normally answers the board from a mock server. With
`backend` set, it hands each request, byte for byte (Host header and all),
to the real server over TCP and passes the answer back unchanged. The
firmware parses that server's exact status line, header casing and framing
(lwIP's HTTP client doesn't decode chunked bodies, for one, so a server must
send a `Content-Length`).
The board's WebSocket goes to the server the same way, as a byte stream
both ways for as long as it stays open. While the server answers, the
simulated clock stops, so a slow server never looks slow to the firmware,
and the board's idle time between pings takes no real time. The emulated
board's ID is all zeros, so the server must accept it on `/ws` with
`EXTRA_DEVICE_IDS=0000000000000000`. Each test boots a fresh board with blank
flash. The board's serial output, its requests and a PNG of every frame its
panels showed are attached to the report.

The selectors stick to what a person sees on the admin page: six text boxes
in order, Apply and Clear buttons, an SVG picture of the board with one
`<image>` per screen, and a "Hymn Boards" link to a page with a table row
per board (found by the board's ID, its columns by their headings: Status,
Last seen, Booted, Firmware) and a "Latest firmware …" line. A new admin page
that keeps those passes unchanged.

Before the tests, `signIn.setup.ts` signs in on the page (Email, Password,
Sign in), or, on a server with no accounts yet, creates the first one with
the server's setup password (Setup password, Your name, Email, New password,
Create account). Every test starts with that session, and publishes firmware
with it too, so the account must be an admin, as the first one is.

## Run them

Build the firmware (see [device/README.md](../device/README.md)), then
(`pnpm install` installs the whole workspace, the emulator and `web/`
included):

```sh
cd e2e
pnpm install
pnpm exec playwright install chromium
pnpm test
```

`pnpm test` builds `web/`, starts it with `wrangler dev` on port 8790 with
empty data, `SETUP_PASSWORD` `e2e-setup` (and a test-only
`BETTER_AUTH_SECRET`), `HEALTHCHECKS` off and the
emulated board allowed (`EXTRA_DEVICE_IDS=0000000000000000`), runs the
tests and stops it. The server's state is kept in
`web/.wrangler/e2e-state` until the next run. In CI its log is printed with
the tests' (prefixed `[WebServer]`).

To test another server instead, set `E2E_BASE_URL`, and `E2E_SETUP_PASSWORD`
if it has no accounts yet; the tests then start nothing. That can be
`pnpm dev` in `web/` (`http://localhost:8000`, with `EXTRA_DEVICE_IDS` in
`web/.dev.vars`; its setup password is `dev`) or a Cloudflare preview of a branch (its
`http://…workers.dev` URL, plain HTTP; previews accept the emulated board). The board's
clock waits longer for a server that isn't local.

The tests change the server's lines and published firmware, so don't point
them at a server in use. Each test publishes the build under test as the server's firmware release
before its board boots and again when it ends, so a release left on the
server can't update a board by surprise.

| Variable                    | Default                                                 |
| --------------------------- | ------------------------------------------------------- |
| `E2E_BASE_URL`              | none: the tests start `web/` on `http://127.0.0.1:8790` |
| `E2E_EMAIL`, `E2E_PASSWORD` | `e2e@example.com`, `e2e-password`                       |
| `E2E_SETUP_PASSWORD`        | `e2e-setup` for their own server; none otherwise        |
| `FIRMWARE_UF2`              | `../device/build/ehymnboard.uf2`                        |
| `E2E_CHROMIUM_EXECUTABLE`   | Playwright's own Chromium                               |
| `EMULATOR_VERBOSE=1`        | prints the firmware's serial output                     |

`FIRMWARE_UF2` must sit in its build directory, which also holds the
bootloader, `firmware_version.txt` and the encrypted OTA image. The OTA test
relabels that image as a new release with the emulator's `OtaBuild`, so the
build's key must match `device/secrets.cmake` (or the example key).

Checks, all run in CI (`.github/workflows/ci.yml`):

```sh
pnpm run typecheck      # tsc 7
pnpm run lint           # oxlint, type-aware rules via tsrs
# Prettier runs from the repository root: pnpm run format:check
```

## Testing a replacement server

Run it and point `E2E_BASE_URL` at it. It must serve the device API and the
admin page there, with the same sign-in page (`signIn.setup.ts`), and accept the emulated board's
ID on `/ws`. To make CI test it, change the `webServer` entry in
`playwright.config.ts` to start it: its `command`, the `cwd` that runs in
(`../web` now) and the `url` Playwright waits on until the server is ready
(`GET /ok`, which must then answer with a 2xx).

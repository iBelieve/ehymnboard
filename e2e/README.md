# Full-stack end-to-end tests

These tests run the whole system the way it runs in church. The real
firmware runs in the [emulator](../device/emulator/README.md) and talks to a
running hymn board server over real HTTP. A browser drives that server's
admin page with [Playwright](https://playwright.dev). The tests never reach
into the server: the usher's side goes through the page, as a person would,
and the board's side is the firmware's own HTTP client. A server rewrite is
held to the same tests as the server it replaces: if it behaves the same,
the tests pass unchanged. CI (`.github/workflows/ci-e2e.yml`) runs them
against the server's Docker image.

| Test file       | Covers                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hymns.spec.ts` | Lines typed on the admin page reach the right screen and band, each change is downloaded and drawn once, the next loops get 304s (no refetch loop), the admin's board picture matches the panels pixel for pixel, Clear, and a power cut keeps the ETags |
| `ota.spec.ts`   | A release published with `POST /firmware` is found, downloaded, installed through the bootloader, committed and reported on the admin page, with the screens kept                                                                                        |

## How it fits together

The emulator's LAN normally answers the board from a mock server. With
`backend` set, it hands each request, byte for byte (Host header and all),
to the real server over TCP and passes the answer back unchanged. The
firmware parses that server's exact status line, header casing and framing
(lwIP's HTTP client doesn't decode chunked bodies, for one, so a server must
send a `Content-Length`).
While the server answers, the simulated clock stops, so a slow server never
looks slow to the firmware, and the board's 15 second sleeps and 10 minute
update checks take no real time. Each test boots a fresh board with blank
flash. The board's serial output, its requests and a PNG of every frame its
panels showed are attached to the report.

The selectors stick to what a person sees on the admin page: six text boxes
in order, Apply and Clear buttons, a line per board ("… (last seen …") and an
SVG picture of the board with one `<image>` per screen. A new admin page
that keeps those passes unchanged.

## Run them

Build the firmware (see [device/README.md](../device/README.md)) and start
a server, then (`pnpm install` installs the whole workspace, the emulator
included):

```sh
cd e2e
pnpm install
pnpm exec playwright install chromium
E2E_BASE_URL=http://localhost:8000 E2E_USERNAME=e2e E2E_PASSWORD=e2e-password pnpm test
```

To start the server for this, run its Docker image, as CI does (built from
the repository root), or `pnpm dev` in `web/` (both listen on port 8000):

```sh
docker build -t hymnboard -f web/Dockerfile . && docker run --rm -p 8000:8000 \
  -e BASIC_AUTH_USERNAME=e2e -e BASIC_AUTH_PASSWORD=e2e-password hymnboard
```

The tests change the server's lines and published firmware, so don't point
them at a server in use. Each test publishes the build under test as the server's firmware release
before its board boots and again when it ends, so a release left on the
server can't update a board by surprise.

| Variable                       | Default                              |
| ------------------------------ | ------------------------------------ |
| `E2E_BASE_URL`                 | `http://localhost:8000` (plain HTTP) |
| `E2E_USERNAME`, `E2E_PASSWORD` | none: the server's basic auth, if on |
| `FIRMWARE_UF2`                 | `../device/build/ehymnboard.uf2`     |
| `E2E_CHROMIUM_EXECUTABLE`      | Playwright's own Chromium            |
| `EMULATOR_VERBOSE=1`           | prints the firmware's serial output  |

`FIRMWARE_UF2` must sit in its build directory, which also holds the
bootloader, `firmware_version.txt` and the encrypted OTA image. The OTA test
relabels that image as a new release with the emulator's `OtaBuild`, so the
build's key must match `device/secrets.cmake` (or the example key).

Checks, all run in CI (`.github/workflows/ci-e2e.yml`):

```sh
pnpm run typecheck      # tsc 7 (needs device/emulator's packages installed)
pnpm run lint           # oxlint, type-aware rules via tsrs
pnpm run format:check   # Prettier
```

## Testing a replacement server

Point `SERVER_DIR` and `SERVER_PORT` in `ci-e2e.yml` at it (its directory
and the port its image listens on), and add its directory to the workflow's
`paths`. The image must serve the device API and the admin page on that port,
with basic auth from `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD`, and
answer `GET /ok` once it's ready.

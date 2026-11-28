# eHymnBoard Device Firmware

### Pico SDK

See documentation at https://datasheets.raspberrypi.com/pico/raspberry-pi-pico-c-sdk.pdf

Make sure you install the Raspberry Pi Pico SDK.

### WiFi Configuration

Copy `secrets.example.h` to `secrets.h` and replace the example config with one or more WiFi SSID and passphrase entries.

### OTA Key

Copy `secrets.example.cmake` to `secrets.cmake` and set `PFB_AES_KEY` to a random key (the file has a command to generate one). OTA images are encrypted with it, so keep it safe and don't change it: a board can only install images built with the same key as the firmware it's running.

### Compiling

Clone with submodules (or run `git submodule update --init`), then install the Python dependencies (the build uses `pycryptodome` to encrypt the OTA image):

```sh
uv sync
```

Then create the build directory:

```sh
cmake -G Ninja -B build
```

Then cd into the build directory and run:

```sh
ninja
```

To flash the Pico over USB:

```sh
picotool load -xf ehymnboard.elf
```

### OTA Updates

Boards update themselves over the air using [pico_fota_bootloader](https://github.com/JZimnol/pico_fota_bootloader) (the RP2040 has no built-in A/B boot support). Flash is laid out as:

| Region                               | Size    |
| ------------------------------------ | ------- |
| Bootloader                           | 36 KB   |
| Bootloader flags                     | 4 KB    |
| Application slot (running firmware)  | 1000 KB |
| Download slot                        | 1000 KB |
| Reserved (last sector: `SavedState`) | 8 KB    |

Whenever the server pushes a new version, and hourly besides, a board asks the server (`/firmware/latest`) whether it should run a different firmware version. If so, it downloads the image into the download slot, checks its SHA-256, and reboots. The bootloader then swaps the two slots (about 30 seconds) and starts the new firmware. Once the new firmware successfully talks to the server, it commits itself; if it reboots before that (crash, watchdog, or no network for 3 minutes), the bootloader swaps the old firmware back and the board won't retry that version.

The firmware version is the short commit hash (plus `-dirty` and a timestamp for uncommitted changes), so commit before building a release.

#### One-time setup (per board, over USB)

A board needs the bootloader before it can take OTA updates. Hold BOOTSEL while plugging it in, then erase the old firmware (otherwise the bootloader may try to run its leftovers) and load the bootloader and the firmware:

```sh
picotool erase
picotool load build/lib/pico_fota_bootloader/pico_fota_bootloader.uf2
picotool load -x build/ehymnboard.uf2
```

The first boot starts with fresh saved state, so the screens redraw once. After this, `picotool load -x build/ehymnboard.uf2` (in BOOTSEL mode) still works for flashing over USB.

### When the panels change

Only when someone changes the lines in the admin: the board draws a screen
only when the server's `state` names an image it isn't showing. Nothing else
redraws a panel, partially or fully: not a reconnect, a reboot or an OTA
update (the board keeps what it shows in flash), and not a change of the
`partial` option. The two exceptions are the nightly `redraw` between 3 and
5 AM (below) and the first boot on fresh flash. During a service the boards
must sit still, so keep it that way.

### Talking to the server

The board keeps a WebSocket open to the server (`wss://hymnboard.sonrise.io/ws`,
over TLS on port 443 like everything else it fetches; see "TLS" below) and the
server pushes it what to show; it doesn't poll. Images still come from `GET /images/N`, only
when one changes. The client is our own, on lwIP's raw TCP API
(`src/ws_client.cpp`), over host-tested framing and handshake code
(`ws_frame`, `ws_handshake`) that passes the Autobahn test suite (see
[emulator/autobahn/README.md](emulator/autobahn/README.md)).

The messages are short text (`src/board_messages.h`):

| From   | Message                                               | Meaning                                                                                                                                                                       |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server | `state 1 <etag1> <etag2> <etag3> <version> [partial]` | What each screen should show and the firmware to run (`-` for none), and whether to update the panels with a partial refresh (see below). Sent on connect and on every change |
| board  | `ping`                                                | Every 30 s. The server answers `pong` without waking the Durable Object                                                                                                       |
| board  | `shown <etag1> <etag2> <etag3>`                       | What the panels show now (`-` for a screen never drawn)                                                                                                                       |
| server | `redraw`                                              | Nightly: download every screen again (`GET /images/N` with `&redraw=1`) and redraw it with a full refresh                                                                     |

The nightly redraw is for the panels: Waveshare's manual says to refresh them
at least once every 24 hours, or old images can stick, and a full refresh
clears any ghosting. The server sends it between 3 AM and 5 AM where the board is (in
Chicago if Cloudflare can't place it; see `web/README.md`), so nobody sees the panels flash.

### Partial refresh

With the state's `partial` option (a Flagship flag on the server, per board;
see `web/README.md`), the board updates a panel with the panel's partial
waveform, which changes only the pixels that differ and doesn't flash,
instead of a full refresh. The waveform (`PARTIAL_LUT` in `src/waveshare.cpp`)
and the register writes are Waveshare's own, from their 13.3" (K) driver.
The controller compares the new image (BW RAM) with the old one (RED RAM),
but the board cuts the panel's power after every update, which loses both,
so the board keeps what each panel shows, packed as runs of pixels
(`src/shown_images.cpp`): a screen of hymn numbers packs to a few KB, and
all three get at most 20 KB of RAM, which leaves TLS the spare heap it needs. An image that doesn't fit is let go and
that panel's next update is a full one. So is the first update after a boot
or after the server turns the option on, every fifth update (to clear any
ghosting), and the nightly `redraw`, which also starts that count again. Older
firmware ignores the option.

The upgrade request carries the same query string as every other request
(`device_id`, `saved_state_writes`, `watchdog_caused_reboot`,
`firmware_version`) plus `proto=1`. The server only takes known board IDs
(403 otherwise) and keeps one socket per board, closing an older one with code 4000.
It closes a socket that stopped pinging with 4001, and one from before a server
deploy with 4002.

When the socket fails (no `pong` within 10 s, no `state` within 30 s of
connecting, or the server closes it), the board retries after 1 s, doubling to
at most 60 s, each with ±50% jitter. After 3 minutes without a live socket it
reboots, which also rolls back a new firmware that never got one (see below).
It still checks `GET /firmware/latest` at boot and hourly (5 minutes after a
check that failed), so a server whose socket is broken can ship a fix.

A failed image download is retried 15 s later; downloads that keep failing for
3 minutes reboot the board, even with the socket up. Between screens the board
keeps servicing its socket, so a slow update doesn't stop its pings.

lwIP and its callbacks run in a low-priority interrupt, and both they and the
main loop allocate, so `malloc_lock.cpp` turns interrupts off while newlib's
malloc or free runs.

#### Releasing an update

Build, then upload the encrypted image and its version, with an admin's API
key (from your Profile page in the admin, as an admin):

```sh
curl -H "X-Api-Key: $HYMNBOARD_API_KEY" \
  -F image=@build/ehymnboard_fota_image_encrypted.bin \
  -F version="$(cat build/firmware_version.txt)" \
  https://hymnboard.sonrise.io/firmware
```

Every board running a different version installs it, including boards with a newer build flashed over USB: the server pushes the new version to each connected board at once. A new firmware commits itself on the first `state` message it gets over its socket; one that reboots before that is rolled back. Before committing it also checks
that it can make an ordinary request (`/firmware/latest`): if that fails five
times, half a minute apart, it reboots to be rolled back. The devices page shows each board's firmware version and any rollback.

Notes:

- The image is AES encrypted: it contains the WiFi passphrases, and anyone can download it (`/firmware/image` takes no login). The SHA-256 is inside the encrypted image, so a corrupted or tampered image fails the check.
- Don't change the flash layout (`PFB_RESERVED_FILESYSTEM_SIZE_KB` in `CMakeLists.txt`) or the bootloader without reflashing every board over USB.
- Losing power during the ~30 second slot swap can leave a board unbootable until it is reflashed over USB.
- The emulator's `ota.test.ts` and `ota-rejects.test.ts` (see [emulator/README.md](emulator/README.md)) run the whole flow on an emulated board, bootloader included: download, swap, commit, rollback, a power cut mid-download, and bad, cut off or stalled images.

### TLS

Everything the board fetches, and its WebSocket, goes over TLS 1.2 to
`hymnboard.sonrise.io:443` (`EHYMNBOARD_SERVER_HOST` in `CMakeLists.txt`),
through lwIP's `altcp_tls` on mbedTLS (`src/tls.cpp`, configured in
`src/mbedtls_config.h`). The board checks the server's certificate chain and
its name; it doesn't check dates, since it has no clock it could trust before
the handshake. It offers only ECDHE key exchange with AES-128-GCM or
ChaCha20-Poly1305, on P-256 or P-384, with ECDSA or RSA certificates, which
Cloudflare's edge and Let's Encrypt both serve. Later requests resume the
first handshake's session, so a download skips the certificate check.

It trusts only the root CAs in `certs/roots.pem`: every CA Cloudflare issues
edge certificates from, Let's Encrypt among them, which also lets the server
move off Cloudflare to its own Let's Encrypt certificate without an OTA update
first, as long as Let's Encrypt's chains end at ISRG Root X1 or X2. The roots
stay in flash and are parsed only for the handshake that needs one. A server
whose certificate came from any other CA cuts the boards off until they're
flashed over USB, so `.github/workflows/check-tls-roots.yml` checks every day
that the live chains still verify against that file with the board's TLS
settings; it checks only the live server, so check a new one the same way
before moving to it. To add a root, append it with a `# Name:` line and
release firmware before the server switches.

A full handshake beside the open socket peaks at about 45 KB of the 88 KB
heap (the board logs `TLS: heap …` after each round of downloads). lwIP's
TCP window holds a whole 16 KB TLS record, which mbedTLS needs before it can
decrypt any of it.

The [emulator](emulator/README.md) ends TLS at its virtual router with
certificates from a test CA (`certs/test/`, made by `make-test-certs.sh`).
Firmware trusts that CA only when built with `-DEHYMNBOARD_TEST_ROOT_CA=ON`,
which CI uses. The build refuses it unless `PFB_AES_KEY` is the example key, so
real boards refuse a test build's OTA images; but don't flash one over USB
either (CI's `ehymnboard.uf2` artifacts are test builds): a certificate for
the server's name under the test CA, and its private key, are in the
repository. A test build says so on its serial output at boot.

```sh
cmake -G Ninja -B build -DEHYMNBOARD_TEST_ROOT_CA=ON   # for the emulator only
```

### Tests

The hardware-independent parts of the firmware (HTTP header parsing, request
paths, saved state, WebSocket framing and handshake, the board messages and
the connection's retry and ping policy) are unit and property tested on your
computer, no Pico needed. Builds with the host compiler under AddressSanitizer and
UndefinedBehaviorSanitizer:

```sh
cmake -S test -B build-test -G Ninja
ninja -C build-test
ctest --test-dir build-test
```

### Monitoring Output

You can monitor the serial output from the Pico using the included monitor script. It depends on `pyserial`, installable via pip. It will automatically detect the right serial device on macOS. Modify as needed for other platforms.

```sh
./monitor.py
```

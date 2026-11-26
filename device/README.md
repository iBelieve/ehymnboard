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

To flash the Pico over USB, hold BOOTSEL while plugging it in, then load the
bootloader and the firmware (the bootloader's UF2 also clears the boot
record, so the bootloader starts the firmware just loaded into slot A):

```sh
picotool load ehymnboard_bootloader.uf2
picotool load -x ehymnboard.uf2
```

### OTA Updates

Boards update themselves over the air through an A/B bootloader of this
project's own (`src/bootloader_main.cpp`; the RP2040 has no built-in A/B boot
support and can't remap flash). The firmware runs in place from either of two
slots, so it's built twice, linked once for each. Flash is laid out as:

| Region                                  | Offset     | Size    |
| --------------------------------------- | ---------- | ------- |
| boot2 and the stub that starts the rest | `0x0`      | 4 KB    |
| A/B bootloader, its marker at the end   | `0x1000`   | 28 KB   |
| Boot record, two copies                 | `0x8000`   | 8 KB    |
| Slot A                                  | `0xA000`   | 1000 KB |
| Slot B                                  | `0x104000` | 1000 KB |
| Reserved (last sector: `SavedState`)    | `0x1FE000` | 8 KB    |

Whenever the server pushes a new version, and hourly besides, a board asks the server (`/firmware/latest`) whether it should run a different firmware version. If so, it downloads the image for the slot it isn't running from (`/firmware/image?slot=b`, say) straight into that slot, checks its SHA-256 and that it was built for that slot, writes a new boot record putting it on trial, and reboots. The bootloader starts it with the watchdog armed. Once the new firmware's socket is live and it can make an ordinary request, it commits itself. Until then each boot uses up one of its 3 trial boots; after the last, the bootloader starts the old firmware again, which is still in the other slot, and the board won't retry that version. Nothing is ever copied between slots, so a rollback is instant.

The boot record (`src/boot_control.h`) says which slot runs, whether it's on trial, and each slot's image size and CRC-32. It's written to whichever of its two sectors doesn't hold the newest copy, with a sequence number and a CRC, so a power cut while writing it leaves the previous one in force. What each failure does:

| What fails                                              | What happens                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Power cut or failed download while writing the slot     | The other slot is untouched and still active; the board downloads the update again                                       |
| Power cut while any boot record is written              | The previous record stands: the update is installed again, or the trial goes on                                          |
| Power cut or reboot during a trial boot                 | It counts as one of the 3 trial boots, so a good update survives one or two                                              |
| New firmware crashes, hangs or never gets its socket up | Watchdog or the 3 minute reboot, 3 times, then the old firmware                                                          |
| New firmware's socket works but its requests don't      | It gives up its trial at once: the old firmware on the next boot                                                         |
| A slot's image doesn't match its CRC                    | The bootloader starts the other slot                                                                                     |
| An image for the wrong slot, wrong key or corrupted     | Refused before installing                                                                                                |
| The old firmware can't get online after a rollback      | The network was probably down for the new one too: after 3 minutes it forgets the rollback and the update is tried again |

The bootloader itself is never rewritten by an update, so nothing an update does can stop the board booting.

#### Moving off pico_fota_bootloader

Boards from before the A/B bootloader run [pico_fota_bootloader](https://github.com/JZimnol/pico_fota_bootloader), which kept its application in slot A and its download slot where slot B is. They move over the air, with no USB: they download slot A's image as before (no `slot` in the request) and pico_fota_bootloader swaps it in. Once that firmware is healthy, instead of committing to pico_fota_bootloader it replaces it (`src/bootloader_install.h`): it rewrites flash's first sector with the stub, erases the boot record sectors, writes the bootloader and then its marker. A power cut after the first sector is rewritten restarts the firmware in slot A, which finishes the job; a power cut while that one sector is rewritten (about 50 ms, once per board) leaves the board needing USB. If the new firmware fails before it's healthy, pico_fota_bootloader rolls it back as before. pico_fota_bootloader's own slot swap took about 30 seconds during which a power cut could leave the board unbootable; that's gone after the move.

The firmware version is the short commit hash (plus `-dirty` and a timestamp for uncommitted changes), so commit before building a release.

#### One-time setup (per board, over USB)

A new board needs the bootloader before it can take OTA updates. Hold BOOTSEL while plugging it in, then erase the flash (so nothing left over looks like firmware) and load the bootloader and the firmware:

```sh
picotool erase
picotool load build/ehymnboard_bootloader.uf2
picotool load -x build/ehymnboard.uf2
```

The first boot starts with fresh saved state, so the screens redraw once.

### Talking to the server

The board keeps a WebSocket open to the server (`wss://hymnboard.sonrise.io/ws`,
over TLS on port 443 like everything else it fetches; see "TLS" below) and the
server pushes it what to show; it doesn't poll. Images still come from `GET /images/N`, only
when one changes. The client is our own, on lwIP's raw TCP API
(`src/ws_client.cpp`), over host-tested framing and handshake code
(`ws_frame`, `ws_handshake`) that passes the Autobahn test suite (see
[emulator/autobahn/README.md](emulator/autobahn/README.md)).

The messages are short text (`src/board_messages.h`):

| From   | Message                                     | Meaning                                                                                                  |
| ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| server | `state 1 <etag1> <etag2> <etag3> <version>` | What each screen should show and the firmware to run (`-` for none). Sent on connect and on every change |
| board  | `ping`                                      | Every 30 s. The server answers `pong` (on Cloudflare, without waking the Durable Object)                 |
| board  | `shown <etag1> <etag2> <etag3>`             | What the panels show now (`-` for a screen never drawn)                                                  |

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

Build, then upload the OTA bundle (both slots' encrypted images, `ehymnboard_ota_bundle.bin`) and its version:

```sh
curl -u "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  -F image=@build/ehymnboard_ota_bundle.bin \
  -F version="$(cat build/firmware_version.txt)" \
  https://hymnboard.sonrise.io/firmware
```

Every board running a different version installs it, including boards with a newer build flashed over USB: the server pushes the new version to each connected board at once. The server sends each board the image for its other slot, and slot A's to a board on pico_fota_bootloader. A single image (`ehymnboard_fota_image_encrypted.bin`, slot A's) still uploads, for a build from before the A/B bootloader; only boards on pico_fota_bootloader get it, as boards on the A/B bootloader mustn't run such firmware. A new firmware commits itself on the first `state` message it gets over its socket. Before committing it also checks that it can make an ordinary request (`/firmware/latest`): if that fails five times, half a minute apart, it gives up its trial and reboots to be rolled back. The devices page shows each board's firmware version and any rollback.

Notes:

- The image is AES encrypted: it contains the WiFi passphrases, and firmware from before TLS downloads it over plain HTTP. The SHA-256 is inside the encrypted image, so a corrupted or tampered image fails the check.
- Don't change the flash layout (`boot_control.h` and the `EHB_*` variables in `CMakeLists.txt`) or the stub without a plan for moving every board over the air, as for pico_fota_bootloader.
- The emulator runs the whole flow on an emulated board, bootloader included (see [emulator/README.md](emulator/README.md)): `ota.test.ts` (install, commit, trial boots, rollback, retry after an outage), `ota-rejects.test.ts` (bad, wrong-slot, cut off or stalled images), `power-cuts.test.ts` (a power cut during each boot record write) and `migration.test.ts` (moving off pico_fota_bootloader, with a power cut during each of its flash writes). The host tests (`test/test_boot_control.cpp`) check the bootloader's decisions through random updates with power cuts anywhere.

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
edge certificates from, and Let's Encrypt. They stay in flash and are parsed
only for the handshake that needs one. A server whose certificate came from
any other CA cuts the boards off until they're flashed over USB, so
`.github/workflows/check-tls-roots.yml` checks every day that the live
chains still verify against that file with the board's TLS settings. To add
a root, append it with a `# Name:` line and release firmware before the
server switches.

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
paths, saved state, WebSocket framing and handshake, the board messages, the
connection's retry and ping policy and the bootloader's boot record) are unit and property tested on your
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

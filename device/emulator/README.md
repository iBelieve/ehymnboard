# Firmware emulator

Runs the real firmware in [rp2040js](https://github.com/wokwi/rp2040js) on an
emulated eHymnBoard: a Pico W with a fake CYW43439 WiFi chip, a scripted
access point with its own LAN (DHCP, DNS, TCP), a mock hymn board server,
three e-paper panels modeled on their SSD1677 controller, and flash that
survives reboots. The unmodified pico-sdk WiFi driver, lwIP and the firmware's
HTTP client all run as they would on a real board, so tests can exercise WiFi
and server failures that are hard to set up on hardware. Everything runs
locally and no Wokwi account is needed.

## Run the scenario tests

Build the firmware as usual (`device/src/secrets.h` copied from
`secrets.example.h` matches the fake AP `SSID_1`), then:

```sh
cd device/emulator
pnpm install
pnpm test                                   # uses ../build/ehymnboard.uf2
FIRMWARE_UF2=/path/to/ehymnboard.uf2 pnpm test
EMULATOR_VERBOSE=1 pnpm test                # print serial output and events
```

`$FIRMWARE_UF2` must sit in its build directory: the bootloader UF2
(`lib/pico_fota_bootloader/`), `firmware_version.txt` and
`ehymnboard_fota_image_encrypted.bin` are read from beside it.

The emulator is TypeScript that Node runs directly (type stripping, so no
build step and only erasable syntax). Its own checks, all run in CI:

```sh
pnpm run typecheck      # tsc 7
pnpm run lint           # oxlint, type-aware rules via tsrs
pnpm run format:check   # Prettier (pnpm run format to fix)
```

CI runs the tests against the firmware the `build` job produces (the `emulator`
job in `.github/workflows/ci-device.yml`). The whole suite takes a few seconds:
sleeps jump straight to the next timer alarm, so simulated time runs far
faster than real time.

| Test file               | Covers                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `happy-path.test.ts`    | Join, healthcheck, all three screens drawn intact, saved ETags give 304s, a changed image redraws only its screen                                         |
| `pio-bus.test.ts`       | The same first loop over the real PIO/DMA gSPI driver instead of the fast path                                                                            |
| `wifi.test.ts`          | Unknown networks skipped, wrong password retried, no known network                                                                                        |
| `server-errors.test.ts` | A 500, a connection closed mid-image, a wrong-size image, a reset connection, an unknown host                                                             |
| `panels.test.ts`        | Each screen gets exactly Waveshare's documented full-update sequence with no controller faults; a panel stuck busy makes the firmware time out and reboot |
| `epaper.test.ts`        | The panel model on its own: RAM window and address counters, gate lines, BUSY, deep sleep and fault detection                                             |
| `recovery.test.ts`      | WiFi lost for good, the 3 minute watchdog reboot, rejoin with ETags kept in flash                                                                         |
| `ota.test.ts`           | OTA updates through the bootloader: installed, committed, kept through a power cut; rolled back and skipped; power cut mid-download; bad images           |

## Run the firmware interactively

```sh
node src/run.ts ../build/ehymnboard.uf2 --seconds 60   # simulated seconds
```

`--trace` logs every gSPI transaction and ioctl.

## Writing a test

`src/emulator.ts` puts the pieces together. `new Emulator({ firmware })` (or
`boot()` from `test/helpers.ts`) gives you:

- `waitForSerial(text, ms, fromIndex)` runs until the firmware prints `text`
  (a string or RegExp) and returns the index after it; `waitFor(what, cond, ms)`
  runs until a condition holds. Both throw with the serial tail on timeout.
- `server` is the `MockServer`: `setImage(screen, version)` changes an image,
  and `override = (req) => response` answers a request yourself. A response
  is `{ status, headers, body }`, plus `stall`, `reset` or `truncateAt` to
  break the connection.
- `net.requests` lists every HTTP request with its status, `displays` every
  panel refresh with the image now on it, `reboots` the watchdog resets.
- `board.panels[i]` is each screen's controller: `transcript` (every command,
  its data, and power and reset events), `faults` (rules from the panel manual
  the firmware broke), and `stuckBusy` to make one hang.
- `server.firmware = { version, image }` offers an OTA update, as the real
  server does after an upload. `OtaBuild` (`src/ota-image.ts`) decrypts the
  build's `ehymnboard_fota_image_encrypted.bin` with the key from
  `device/secrets.cmake` (or `$PFB_AES_KEY`, or the example key) and makes
  images of the same build under another version: `imageFor(nextVersion("ota2"))`.
- `powerCycle()` unplugs the board and plugs it back in. `dropLink()` takes the AP away. `aps` (an option) lists the networks in
  range, each `{ ssid, password?, bssid?, rssi?, channel? }`.

## How it works

The emulator's source is in `src/` and its tests are in `test/`.

- `fake-cyw43.ts` models the WiFi chip at the gSPI level: the bus and
  backplane registers the driver polls, the firmware download (discarded),
  ioctls and iovars over SDPCM, async events for scans and joins (including
  wrong-password and missing-network failures), and Ethernet frames once
  joined. It raises GPIO 24 as the host-wake interrupt while it has packets
  queued. It can be driven bit by bit from the PIO pins (GPIO 23, 24, 25, 29)
  or a transfer at a time.
- `epaper.ts` models the Waveshare 13.3" e-Paper HAT (K): its SSD1677
  command set with parameter counts, the RAM window and address counters (X in
  pixels, 8 per byte), data entry modes, gate lines, hardware and software
  reset, deep sleep, and BUSY for the manual's typical 4 s full update. What a
  screen shows is its RAM as addressed, so a wrong window or entry mode shows
  up as a wrong image. Sources: the panel's user manual (Rev 1.0, sections 6,
  7.2 and 10.2) and Waveshare's epd13in3k drivers.
- `board.ts` builds the RP2040, wires the panels' power, reset, chip select,
  data/command and busy pins and SPI0, keeps a flash image
  (bootrom erase and program calls are answered directly, as rp2040js has no
  QSPI flash model), and rebuilds the chip from that flash on a watchdog
  reset. The firmware is built to run after pico_fota_bootloader, so the
  bootloader's UF2 from the same build
  (`lib/pico_fota_bootloader/pico_fota_bootloader.uf2`) is flashed first, and
  OTA updates swap the flash slots just as on a board. When the firmware's `.elf` sits next to its `.uf2`, calls to
  `cyw43_spi_transfer()` are answered directly (the fast path); otherwise, or
  with `pioBus: true`, PIO is stepped in lockstep with the CPU.
- `virtual-net.ts` is the LAN behind the AP: the router at 10.0.0.1 answers
  ARP, DHCP and DNS and serves HTTP on port 80 from a small TCP stack.
- `bootrom-b1.bin` is the RP2040 B1 bootrom (BSD-3-Clause, from
  raspberrypi/pico-bootrom via the rp2040js demo).

## Limits

- The panel model shows only the black and white RAM and doesn't model
  waveforms, LUTs, temperature or 4-level grey; its reset busy times aren't
  in the manual and are guesses.
- Timing is approximate: instruction cycles are counted, but bus and flash
  timing are not modeled, so this won't catch timing races.
- The unique board ID reads as zeros, and nothing types at the USB serial
  console.
- rp2040js workarounds live in `board.ts`: its PIO timer, its watchdog
  re-firing forever at expiry, USB CDC answering every poll at once, and USB
  CDC enumerating only once (the firmware re-enumerates after the bootloader).
- Networks are open or WPA2-PSK only: no WPA3 and no roaming between APs.

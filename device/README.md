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

| Region | Size |
| --- | --- |
| Bootloader | 36 KB |
| Bootloader flags | 4 KB |
| Application slot (running firmware) | 1000 KB |
| Download slot | 1000 KB |
| Reserved (last sector: `SavedState`) | 8 KB |

About every 10 minutes a board asks the server (`/firmware/latest`) whether it should run a different firmware version. If so, it downloads the image into the download slot, checks its SHA-256, and reboots. The bootloader then swaps the two slots (about 30 seconds) and starts the new firmware. Once the new firmware successfully talks to the server, it commits itself; if it reboots before that (crash, watchdog, or no network for 3 minutes), the bootloader swaps the old firmware back and the board won't retry that version.

The firmware version is the short commit hash (plus `-dirty` and a timestamp for uncommitted changes), so commit before building a release.

#### One-time setup (per board, over USB)

A board needs the bootloader before it can take OTA updates. Hold BOOTSEL while plugging it in, then erase the old firmware (otherwise the bootloader may try to run its leftovers) and load the bootloader and the firmware:

```sh
picotool erase
picotool load build/lib/pico_fota_bootloader/pico_fota_bootloader.uf2
picotool load -x build/ehymnboard.uf2
```

The first boot starts with fresh saved state, so the screens redraw once. After this, `picotool load -x build/ehymnboard.uf2` (in BOOTSEL mode) still works for flashing over USB.

#### Releasing an update

Build, then upload the encrypted image and its version:

```sh
curl -u "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  -F image=@build/ehymnboard_fota_image_encrypted.bin \
  -F version="$(cat build/firmware_version.txt)" \
  https://api.hymnboard.sonrise.io/firmware
```

Every board running a different version installs it, including boards with a newer build flashed over USB. The devices page shows each board's firmware version and any rollback.

Notes:

- The image is served over plain HTTP, so it is AES encrypted: it contains the WiFi passphrases. The SHA-256 is inside the encrypted image, so a corrupted or tampered image fails the check.
- Don't change the flash layout (`PFB_RESERVED_FILESYSTEM_SIZE_KB` in `CMakeLists.txt`) or the bootloader without reflashing every board over USB.
- Losing power during the ~30 second slot swap can leave a board unbootable until it is reflashed over USB.

### Tests

The hardware-independent parts of the firmware (HTTP header parsing, request
paths, saved state) are unit and property tested on your computer, no Pico
needed. Builds with the host compiler under AddressSanitizer and
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

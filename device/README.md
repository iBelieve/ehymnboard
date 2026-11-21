# eHymnBoard Device Firmware

### Pico SDK

See documentation at https://datasheets.raspberrypi.com/pico/raspberry-pi-pico-c-sdk.pdf

Make sure you install the Raspberry Pi Pico SDK.

### WiFi Configuration

Copy `secrets.example.h` to `secrets.h` and replace the example config with one or more WiFi SSID and passphrase entries.

### Compiling

First create the build directory:

```sh
cmake -G Ninja -B build
```

Then cd into the build directory and run:

```sh
ninja
```

To flash the Pico:

```sh
picotool load -xf ehymnboard.elf
```

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

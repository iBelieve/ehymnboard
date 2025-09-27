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

### Monitoring Output

You can monitor the serial output from the Pico using the included monitor script. It depends on `pyserial`, installable via pip. It will automatically detect the right serial device on macOS. Modify as needed for other platforms.

```sh
./monitor.py
```

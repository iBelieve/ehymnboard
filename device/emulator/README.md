# Firmware emulator (prototype)

Runs the real firmware UF2 in [rp2040js](https://github.com/wokwi/rp2040js)
with a fake CYW43439 WiFi chip attached, so the unmodified pico-sdk WiFi
driver and lwIP run against a scripted access point. Nothing leaves the
machine and no Wokwi account is needed.

Status (step 1 of the plan): the driver brings the fake chip up (bus init,
225 KB firmware download, CLM, `cyw43_arch_init()`), and a WiFi scan returns
the fake APs, so `setup_wifi()` picks `SSID_1` and starts joining. Joining,
DHCP and the HTTP fetch are step 2 and not done yet.

## Run

Build the firmware as usual (`device/src/secrets.h` copied from
`secrets.example.h` matches the fake AP `SSID_1`), then:

```sh
cd device/emulator
pnpm install
node run.mjs ../build/ehymnboard.uf2 --timeout 120   # wall-clock seconds
```

`--trace` logs every gSPI transaction and ioctl. The simulation runs at about
a sixth of real time.

## How it works

- `fake-cyw43.mjs` watches the WL_ON, CS and CLK pins (GPIO 23, 25, 29),
  samples the data pin (GPIO 24) on each rising clock edge and drives it with
  response bits in the read phase. It models the gSPI registers, the
  backplane window and core reset registers the driver polls, discards the
  firmware download, answers ioctls/iovars over SDPCM, and sends async events
  (scan results so far). It raises GPIO 24 as the host-wake interrupt while
  it has packets queued.
- `run.mjs` loads the UF2, attaches USB CDC for stdio, and steps PIO in
  lockstep with the CPU (rp2040js normally runs PIO on a slow timer).
- `bootrom-b1.bin` is the RP2040 B1 bootrom (BSD-3-Clause, from
  raspberrypi/pico-bootrom via the rp2040js demo).

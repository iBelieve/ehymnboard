/*
 * eHymnBoard device emulator
 * Copyright (C) 2026  Michael Spencer <sonrisesoftware@gmail.com>

 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Boots a firmware UF2 in rp2040js with a fake CYW43 attached and prints the
// USB CDC (stdio) output.
//
// Usage: node run.mjs <firmware.uf2> [--timeout <wall-clock seconds>] [--trace]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ConsoleLogger, LogLevel, Simulator, USBCDC } from 'rp2040js';
import { FakeCYW43 } from './fake-cyw43.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    timeout: { type: 'string', default: '120' },
    trace: { type: 'boolean', default: false },
  },
});
if (positionals.length !== 1) {
  console.error('usage: node run.mjs <firmware.uf2> [--timeout <seconds>] [--trace]');
  process.exit(2);
}

const sim = new Simulator();
const mcu = sim.rp2040;
const { clock } = sim;

// The RP2040 B1 bootrom (BSD-3-Clause, from raspberrypi/pico-bootrom), as
// shipped in the rp2040js demo.
const bootrom = fs.readFileSync(new URL('./bootrom-b1.bin', import.meta.url));
mcu.loadBootrom(new Uint32Array(bootrom.buffer, bootrom.byteOffset, bootrom.byteLength / 4));
mcu.logger = new ConsoleLogger(LogLevel.Error);

const uf2 = fs.readFileSync(positionals[0]);
for (let off = 0; off + 512 <= uf2.length; off += 512) {
  const addr = uf2.readUInt32LE(off + 12);
  const size = uf2.readUInt32LE(off + 16);
  mcu.flash.set(uf2.subarray(off + 32, off + 32 + size), addr - 0x10000000);
}

const chip = new FakeCYW43(mcu, {
  trace: values.trace,
  aps: [
    { ssid: 'SSID_1', auth: 'wpa2', rssi: -48, channel: 6, bssid: [0x02, 0x11, 0x22, 0x33, 0x44, 0x55] },
    { ssid: 'NeighbourNet', auth: 'wpa2', rssi: -71, channel: 11 },
  ],
});

const cdc = new USBCDC(mcu.usbCtrl);
cdc.onSerialData = (v) => process.stdout.write(v);

const WATCHDOG_BASE = 0x40058;
mcu.peripherals[WATCHDOG_BASE].onWatchdogTrigger = () => {
  console.log('\n[emu] watchdog reset');
  process.exit(3);
};

// rp2040js steps PIO from its own timer, far slower than the CPU, so a gSPI
// transfer would take ages of simulated time. Step PIO in lockstep with the
// CPU instead.
for (const pio of mcu.pio) {
  pio.run = () => {};
}
const CYCLE_NANOS = 1e9 / 125_000_000;

function execute() {
  for (let i = 0; i < 200_000; i++) {
    let cycles;
    if (!mcu.core.waiting) {
      cycles = mcu.core.executeInstruction();
    } else if (mcu.pio.some((p) => !p.stopped)) {
      cycles = 8;
    } else {
      clock.tick(clock.nanosToNextAlarm);
      continue;
    }
    clock.tick(cycles * CYCLE_NANOS);
    for (const pio of mcu.pio) {
      if (!pio.stopped) {
        for (let c = 0; c < cycles; c++) {
          pio.step();
        }
      }
    }
  }
  setImmediate(execute);
}

const t0 = Date.now();
const limitMs = Number(values.timeout) * 1000;
setInterval(() => {
  if (Date.now() - t0 > limitMs) {
    const { transactions, firmwareBytes, ioctls } = chip.stats;
    console.log(
      `\n[emu] wall-clock limit, sim time ${(clock.nanos / 1e6).toFixed(0)} ms, ` +
        `${transactions} gSPI transactions, ${firmwareBytes} bytes to chip RAM, ${ioctls} ioctls`,
    );
    process.exit(0);
  }
}, 500);

mcu.core.PC = 0x10000000;
execute();

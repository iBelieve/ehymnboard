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

// Boots a firmware UF2 on the emulated board, with the fake AP, LAN and
// server, and prints the firmware's serial output and emulator events.
//
// Usage: node src/run.ts <firmware.uf2> [--seconds <simulated seconds>]
//          [--bootloader <pico_fota_bootloader.uf2>] [--trace]
import { parseArgs } from "node:util";
import { Emulator } from "./emulator.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "60" },
    bootloader: { type: "string" },
    trace: { type: "boolean", default: false },
  },
});
if (positionals.length !== 1) {
  console.error(
    "usage: node src/run.ts <firmware.uf2> [--seconds <simulated seconds>] [--bootloader <uf2>] [--trace]",
  );
  process.exit(2);
}

const emu = new Emulator({
  firmware: positionals[0],
  bootloader: values.bootloader,
  trace: values.trace,
  echo: true,
});
const t0 = Date.now();
emu.run(Number(values.seconds) * 1000);
const wall = (Date.now() - t0) / 1000;
console.log(
  `\n[emu] ran ${(emu.simMs / 1000).toFixed(1)} s simulated in ${wall.toFixed(1)} s, ${emu.reboots} reboot(s)`,
);

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

import assert from "node:assert/strict";
import path from "node:path";
import { Emulator, type EmulatorOptions, testImage } from "../src/emulator.ts";

/** The firmware under test: $FIRMWARE_UF2, or device/build/ehymnboard.uf2. */
export const FIRMWARE =
  process.env.FIRMWARE_UF2 ?? path.join(import.meta.dirname, "..", "..", "build", "ehymnboard.uf2");

/** Boots a fresh emulator. Set EMULATOR_VERBOSE=1 to see serial output and events. */
export function boot(opts: Partial<EmulatorOptions> = {}) {
  const verbose = !!process.env.EMULATOR_VERBOSE;
  return new Emulator({ firmware: FIRMWARE, quiet: !verbose, echo: verbose, ...opts });
}

/**
 * Boots far enough that the socket is live and the first images are on the
 * panels; returns the serial index after that.
 */
export function waitForFirstImages(emu: Emulator, ms = 40_000) {
  return emu.waitForSerial("State saved to flash", ms, emu.waitForSerial("WS: live", ms));
}

/** The board's /device_booted requests, oldest first. */
export function bootReports(emu: Emulator) {
  return emu.net.requests.filter((r) => r.path === "/device_booted");
}

/** Counts how many times text occurs in the serial output. */
export function count(emu: Emulator, text: string) {
  return emu.serial.split(text).length - 1;
}

/** Checks that screens 1-3 each showed, in order, the first image the server has for it. */
export function assertFirstImagesShown(emu: Emulator) {
  assert.deepEqual(
    emu.displays.map((d) => d.screen),
    [1, 2, 3],
  );
  for (const d of emu.displays) {
    assert.deepEqual(
      d.frame,
      testImage(d.screen, 1),
      `screen ${d.screen} shows the image the server sent`,
    );
  }
  assertNoPanelFaults(emu);
}

/** Checks that the firmware broke none of the panel controller's rules. */
export function assertNoPanelFaults(emu: Emulator) {
  for (const panel of emu.board.panels) {
    assert.deepEqual(panel.faults, [], `screen ${panel.id} faults`);
  }
}

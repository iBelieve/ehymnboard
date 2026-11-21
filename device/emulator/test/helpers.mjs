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

import assert from 'node:assert/strict';
import path from 'node:path';
import { Emulator, testImage } from '../emulator.mjs';

/** The firmware under test: $FIRMWARE_UF2, or device/build/ehymnboard.uf2. */
export const FIRMWARE =
  process.env.FIRMWARE_UF2 ?? path.join(import.meta.dirname, '..', '..', 'build', 'ehymnboard.uf2');

/** Boots a fresh emulator. Set EMULATOR_VERBOSE=1 to see serial output and events. */
export function boot(opts = {}) {
  const verbose = !!process.env.EMULATOR_VERBOSE;
  return new Emulator({ firmware: FIRMWARE, quiet: !verbose, echo: verbose, ...opts });
}

/** Counts how many times text occurs in the serial output. */
export function count(emu, text) {
  return emu.serial.split(text).length - 1;
}

/** Checks that screens 1-3 each showed, in order, the first image the server has for it. */
export function assertFirstImagesShown(emu) {
  assert.deepEqual(
    emu.displays.map((d) => d.screen),
    [1, 2, 3],
  );
  for (const d of emu.displays) {
    assert.deepEqual(d.frame, testImage(d.screen, 1), `screen ${d.screen} shows the image the server sent`);
  }
}

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
import { test } from 'node:test';
import { assertFirstImagesShown, boot } from './helpers.mjs';

// The other tests answer cyw43_spi_transfer() directly. This one runs the
// firmware's real gSPI driver: PIO bit-banging and DMA, clocked bit by bit.
test('the real PIO bus driver joins and fetches all three screens', () => {
  const emu = boot({ pioBus: true });
  emu.waitForSerial('Connected to SSID_1', 30_000);
  emu.waitForSerial('State saved to flash', 60_000);
  assertFirstImagesShown(emu);
  // The firmware blob alone is ~230 KB, so millions of clock edges.
  assert.ok(emu.board.chip.stats.clockEdges > 1_000_000, 'traffic went over the PIO bus');
});

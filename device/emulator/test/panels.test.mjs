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
import { REFRESH_MS } from '../epaper.mjs';
import { assertNoPanelFaults, boot } from './helpers.mjs';

// What Waveshare's own driver sends for one full update: init() then
// display() in RaspberryPi_JetsonNano/python/lib/waveshare_epd/epd13in3k.py
// (github.com/waveshareteam/e-Paper). The manual's reference program
// (section 10.2) is the same apart from its own LUT load and update mode.
const WAVESHARE_FULL_UPDATE = [
  'hardware reset',
  '0x12', // software reset
  '0x0c ae c7 c3 c0 80', // booster soft start
  '0x01 a7 02 00', // driver output control: 680 gate lines
  '0x11 03', // data entry mode: X then Y, both increasing
  '0x44 00 00 bf 03', // RAM X window 0-959 (pixels)
  '0x45 00 00 a7 02', // RAM Y window 0-679
  '0x3c 05', // border waveform
  '0x18 80', // internal temperature sensor
  '0x4e 00 00', // RAM X counter
  '0x4f 00 00', // RAM Y counter
  '0x24 <81600 bytes>', // the image, 960 / 8 * 680
  '0x22 f7', // display update control 2: full update
  '0x20', // master activation
];

test('each screen gets exactly the full update sequence Waveshare documents', () => {
  const emu = boot();
  emu.waitForSerial('State saved to flash', 60_000);
  assertNoPanelFaults(emu);
  for (const panel of emu.board.panels) {
    // Powered only for its own update, then switched off again.
    assert.deepEqual(panel.transcript, ['power on', ...WAVESHARE_FULL_UPDATE, 'power off'], `screen ${panel.id}`);
    assert.equal(panel.powered, false);
  }
  // The updates run one after another, each taking the panel's refresh time.
  const gaps = emu.displays.slice(1).map((d, i) => d.atMs - emu.displays[i].atMs);
  for (const gap of gaps) {
    assert.ok(gap >= REFRESH_MS, `screens refresh in turn, ${gap} ms apart`);
  }
  assert.deepEqual(
    emu.displays.map((d) => d.updateControl),
    [0xf7, 0xf7, 0xf7],
  );
});

test('a panel stuck busy makes the firmware give up after 30 s and reboot', () => {
  const emu = boot();
  emu.board.panels[1].stuckBusy = true;
  const at = emu.waitForSerial('Timeout waiting for busy pin to go low', 90_000);
  const before = emu.displays.map((d) => d.screen);
  assert.deepEqual(before, [1], 'screen 1 refreshed before screen 2 hung');
  assert.equal(emu.board.panels[1].powered, false, 'the stuck panel is switched off');
  emu.waitFor('a watchdog reset', () => emu.reboots >= 1, 60_000);
  emu.waitForSerial('Rebooted due to watchdog timeout!', 15_000, at);
});

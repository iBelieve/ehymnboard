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
import { boot, count } from './helpers.mjs';

test('skips unknown networks and joins the known one', () => {
  const emu = boot({
    aps: [
      { ssid: 'NeighbourNet', password: 'whatever', rssi: -40 },
      { ssid: 'SSID_2', password: 'PASSPHRASE_2', rssi: -60 },
    ],
  });
  emu.waitForSerial('Connected to SSID_2', 15_000);
  assert.equal(count(emu, 'Trying to connect to SSID NeighbourNet'), 0);
});

test('retries a wrong password, then connects once the password is right', () => {
  const ap = { ssid: 'SSID_1', password: 'not-the-passphrase' };
  const emu = boot({ aps: [ap] });

  const at = emu.waitForSerial('All attempts to connect to known SSIDs failed', 30_000);
  assert.equal(count(emu, '- Bad auth for SSID_1'), 5);
  assert.equal(emu.net.requests.length, 0, 'no HTTP without a connection');

  // The AP's password is fixed (or the right one is configured); the next
  // rescan, 30 s later, connects.
  ap.password = 'PASSPHRASE_1';
  emu.waitForSerial('Connected to SSID_1', 45_000, at);
  emu.waitForSerial('State saved to flash', 20_000, at);
  assert.equal(emu.displays.length, 3);
});

test('keeps scanning while no known network is around', () => {
  const aps = [];
  const emu = boot({ aps });
  const at = emu.waitForSerial('No known SSIDs found', 15_000);
  aps.push({ ssid: 'SSID_1', password: 'PASSPHRASE_1' });
  emu.waitForSerial('Connected to SSID_1', 45_000, at);
});

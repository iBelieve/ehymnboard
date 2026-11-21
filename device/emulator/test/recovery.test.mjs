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
import { boot } from './helpers.mjs';

test('after losing WiFi for good it reboots, rejoins and keeps its saved ETags', () => {
  const emu = boot();
  let at = emu.waitForSerial('State saved to flash', 30_000);
  assert.equal(emu.displays.length, 3);

  // The AP drops us. The firmware only joins at boot, so every fetch fails
  // until the 3 minute no-success timeout reboots it through the watchdog.
  emu.dropLink();
  at = emu.waitForSerial('All fetches have failed for >3 minutes, rebooting to recover', 300_000, at);
  emu.waitFor('a watchdog reset', () => emu.reboots === 1, 60_000);

  // After the reboot: rejoins, reports the watchdog reboot, and the ETags
  // saved in flash mean nothing is downloaded or redrawn again.
  at = emu.waitForSerial('Rebooted due to watchdog timeout!', 15_000, at);
  emu.waitForSerial('Screen 1 Etag: v1-1', 5_000, at);
  emu.waitForSerial('Connected to SSID_1', 20_000, at);
  emu.waitForSerial('Sleeping for 15 seconds', 30_000, emu.waitForSerial('Refreshing screens (loop=1', 15_000, at));
  const booted = emu.net.requests.filter((r) => r.path === '/device_booted').at(-1);
  assert.equal(booted.query.watchdog_caused_reboot, '1');
  const after = emu.net.requests.filter((r) => r.path.startsWith('/images/')).slice(-3);
  assert.deepEqual(
    after.map((r) => r.status),
    [304, 304, 304],
  );
  assert.equal(emu.displays.length, 3, 'no redraw after the reboot');
});

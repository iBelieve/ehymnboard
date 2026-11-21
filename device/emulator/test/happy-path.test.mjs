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
import { testImage } from '../emulator.mjs';
import { assertFirstImagesShown, boot, count } from './helpers.mjs';

test('boots, joins WiFi, shows all three screens, then only refreshes what changed', () => {
  const emu = boot();

  emu.waitForSerial('Successfully reported healthcheck', 15_000, emu.waitForSerial('Connected to SSID_1', 15_000));
  const booted = emu.net.requests.find((r) => r.path === '/device_booted');
  assert.ok(booted, 'reports device_booted');
  assert.equal(booted.query.watchdog_caused_reboot, '0');

  // First loop: all three images download and reach their panels intact.
  let at = emu.waitForSerial('State saved to flash', 20_000);
  assertFirstImagesShown(emu);
  assert.ok(emu.board.flashWrites > 0, 'ETags are written to flash');

  // Second loop: the firmware sends the saved ETags and gets 304s.
  at = emu.waitForSerial('Sleeping for 15 seconds', 30_000, emu.waitForSerial('Refreshing screens (loop=2', 30_000, at));
  assert.equal(emu.displays.length, 3, 'no panel refresh when nothing changed');
  const loop2 = emu.net.requests.filter((r) => r.path.startsWith('/images/')).slice(3);
  assert.deepEqual(
    loop2.map((r) => [r.path, r.query.etag, r.status]),
    [
      ['/images/1', 'v1-1', 304],
      ['/images/2', 'v1-2', 304],
      ['/images/3', 'v1-3', 304],
    ],
  );

  // A new image for screen 2 refreshes only screen 2.
  emu.server.setImage(2, 2);
  emu.waitForSerial('State saved to flash', 30_000, at);
  assert.equal(emu.displays.length, 4);
  assert.equal(emu.displays[3].screen, 2);
  assert.deepEqual(emu.displays[3].frame, testImage(2, 2));
  assert.match(emu.serial.slice(at), /Screen 2 Etag: v2-2/);
  assert.equal(count(emu, 'Rebooted due to watchdog'), 0);
});

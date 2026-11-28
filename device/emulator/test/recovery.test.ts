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
import { test } from "node:test";
import { boot, count, waitForFirstImages } from "./helpers.ts";

test("after losing WiFi for good it reboots, rejoins and keeps its saved ETags", () => {
  const emu = boot();
  let at = waitForFirstImages(emu);
  assert.equal(emu.displays.length, 3);

  // The AP drops us. The board finds out when its next ping can't be sent,
  // and since the firmware only joins at boot, every reconnect fails until
  // 3 minutes without a socket reboot it.
  emu.dropLink();
  const dropped = emu.simMs;
  at = emu.waitForSerial("WS: socket closed, retrying in", 45_000, at);
  assert.ok(emu.simMs - dropped <= 31_000, "noticed by the next ping");
  at = emu.waitForSerial("No live socket for >3 minutes, rebooting to recover", 240_000, at);
  emu.waitFor("a watchdog reset", () => emu.reboots === 1, 60_000);

  // After the reboot: rejoins, reports the watchdog reboot, and the ETags
  // saved in flash mean nothing is downloaded or redrawn again.
  at = emu.waitForSerial("Rebooted due to watchdog timeout!", 15_000, at);
  emu.waitForSerial("Screen 1 Etag: v1-1", 5_000, at);
  emu.waitForSerial("Connected to SSID_1", 20_000, at);
  emu.waitForSerial("WS: live", 30_000, at);
  emu.run(5_000);
  const booted = emu.net.requests.filter((r) => r.path === "/device_booted").at(-1);
  assert.ok(booted);
  assert.equal(booted.query.watchdog_caused_reboot, "1");
  assert.equal(booted.query.reset, "no_socket", "and why it rebooted");
  assert.equal(booted.query.reset_phase, "running");
  assert.ok(
    Number(booted.query.reset_uptime) >= 180,
    `rebooted after ${booted.query.reset_uptime} s`,
  );
  // WiFi went down once before the reboot
  assert.equal(count(emu, "WiFi: link down"), 1);
  assert.equal(
    emu.net.requests.filter((r) => r.path.startsWith("/images/")).length,
    3,
    "no image downloads after the reboot",
  );
  assert.equal(emu.displays.length, 3, "no redraw after the reboot");
  assert.ok(emu.server.openSockets.at(-1)?.received.includes("shown v1-1 v1-2 v1-3"));
});

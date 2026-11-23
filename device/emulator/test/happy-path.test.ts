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
import { testImage } from "../src/emulator.ts";
import { assertFirstImagesShown, boot, count } from "./helpers.ts";

test("boots, joins WiFi, shows all three screens, then redraws only what the server pushes", () => {
  const emu = boot();

  emu.waitForSerial(
    "Successfully reported healthcheck",
    15_000,
    emu.waitForSerial("Connected to SSID_1", 15_000),
  );
  const booted = emu.net.requests.find((r) => r.path === "/device_booted");
  assert.ok(booted, "reports device_booted");
  assert.equal(booted.query.watchdog_caused_reboot, "0");

  // The socket opens with the board's status, and the first state message
  // makes it live.
  let at = emu.waitForSerial("WS: live", 15_000);
  const [socket] = emu.server.sockets;
  assert.ok(socket?.request, "one socket");
  assert.equal(socket.request.path, "/ws");
  assert.equal(socket.request.query.device_id, booted.query.device_id);
  assert.equal(socket.request.query.proto, "1");
  assert.equal(socket.request.query.firmware_version, booted.query.firmware_version);

  // All three images download and reach their panels intact, and the board
  // tells the server what they show.
  at = emu.waitForSerial("State saved to flash", 20_000, at);
  assertFirstImagesShown(emu);
  assert.ok(emu.board.flashWrites > 0, "ETags are written to flash");
  emu.waitFor("the shown message", () => socket.received.includes("shown v1-1 v1-2 v1-3"), 1_000);

  // No polling: five minutes go by with only pings on the socket.
  const before = emu.net.requests.length;
  emu.run(5 * 60_000);
  assert.deepEqual(
    emu.net.requests.slice(before).map((r) => r.path),
    [],
    "no HTTP requests while nothing changes",
  );
  const pings = socket.received.filter((m) => m === "ping").length;
  assert.ok(pings >= 9 && pings <= 11, `a ping every 30 s (${pings} in 5 minutes)`);
  assert.equal(emu.displays.length, 3, "no redraws");
  assert.equal(emu.server.sockets.length, 1, "the same socket the whole time");

  // A new image for screen 2: only screen 2 downloads, within a second.
  at = emu.serial.length;
  const pushedAt = emu.simMs;
  emu.server.setImage(2, 2);
  emu.waitForSerial("Refreshing screen 2", 1_000, at);
  const reaction = emu.simMs - pushedAt;
  emu.waitForSerial("State saved to flash", 30_000, at);
  assert.ok(reaction <= 500, `asks for the new image ${reaction.toFixed(0)} ms after the push`);
  assert.equal(emu.displays.length, 4);
  assert.equal(emu.displays[3].screen, 2);
  assert.deepEqual(emu.displays[3].frame, testImage(2, 2));
  assert.match(emu.serial.slice(at), /Screen 2 Etag: v2-2/);
  assert.deepEqual(
    emu.net.requests.slice(before).map((r) => [r.path, r.query.etag, r.status]),
    [["/images/2", "v1-2", 200]],
  );
  emu.waitFor(
    "the new shown message",
    () => socket.received.includes("shown v1-1 v2-2 v1-3"),
    1_000,
  );
  assert.equal(count(emu, "Rebooted due to watchdog"), 0);
});

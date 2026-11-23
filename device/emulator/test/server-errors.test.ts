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
import type { Emulator } from "../src/emulator.ts";
import type { HttpResponse } from "../src/virtual-net.ts";
import { boot, count } from "./helpers.ts";

// The first loop's images, failing the given screen in the given way.
function failScreen(emu: Emulator, screen: number, response: HttpResponse) {
  emu.server.override = (req) => (req.path === `/images/${screen}` ? response : undefined);
}

const badResponses: [name: string, response: HttpResponse, message: RegExp][] = [
  [
    "a connection that closes mid-image",
    { status: 200, headers: { Etag: "bad" }, body: new Uint8Array(81600), truncateAt: 40_000 },
    /Fetch image HTTP request failed with error: 9/, // HTTPC_RESULT_ERR_CONTENT_LEN
  ],
  [
    "an image of the wrong size",
    { status: 200, headers: { Etag: "bad" }, body: new Uint8Array(40_000) },
    /Image is the wrong size: 40000 bytes received, 81600 expected/,
  ],
];
for (const [name, response, message] of badResponses) {
  test(`${name} is not shown and its ETag is not adopted`, () => {
    const emu = boot();
    failScreen(emu, 1, response);
    const at = emu.waitForSerial("State saved to flash", 60_000);
    assert.match(emu.serial, message);
    assert.deepEqual(
      emu.displays.map((d) => d.screen),
      [2, 3],
    );
    emu.server.override = null;
    emu.waitForSerial("New image for screen 1", 30_000, at);
    const retry = emu.net.requests.filter((r) => r.path === "/images/1").at(-1);
    assert.ok(retry);
    assert.equal(retry.query.etag, undefined, "the bad response must not have set the ETag");
  });
}

test("a reset connection and an unknown host count as failures, not crashes", () => {
  const emu = boot();
  emu.server.override = (req) => (req.path === "/images/1" ? { reset: true } : undefined);
  const at = emu.waitForSerial("Refreshing screen 2", 40_000);
  assert.match(emu.serial, /Fetch image HTTP request failed with error: /);

  // DNS stops resolving the server and the socket drops: once lwIP's cached
  // answer expires (60 s TTL) every reconnect fails, but nothing reboots
  // before the 3 minute limit.
  emu.net.dns["api.hymnboard.sonrise.io"] = false;
  emu.server.override = null;
  emu.server.upgradeStatus = 503;
  emu.server.sockets[0].drop();
  emu.waitForSerial("WS: DNS lookup of api.hymnboard.sonrise.io failed", 120_000, at);
  emu.run(30_000);
  assert.equal(emu.reboots, 0);
  assert.equal(count(emu, "Rebooted due to watchdog"), 0);
  emu.net.dns["api.hymnboard.sonrise.io"] = true;
  emu.server.upgradeStatus = 101;
  emu.waitForSerial("New image for screen 1", 90_000, emu.waitForSerial("WS: live", 90_000, at));
});

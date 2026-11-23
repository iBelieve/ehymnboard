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

// TLS: every request and the WebSocket go over https/wss to port 443, where
// the router's TLS server stands in for Cloudflare's edge. The firmware must
// be built with -DEHYMNBOARD_TEST_ROOT_CA=ON to trust the test certificates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Emulator, SERVER_HOST } from "../src/emulator.ts";
import { assertFirstImagesShown, boot, count, waitForFirstImages } from "./helpers.ts";

/** Free heap the board must keep at its busiest, for what TLS hasn't needed yet. */
const HEAP_HEADROOM = 24 * 1024;

/** Checks the heap never came within HEAP_HEADROOM of running out. */
function assertHeapHeadroom(emu: Emulator) {
  const reports = [...emu.serial.matchAll(/TLS: heap \d+ in use, peak (\d+) of (\d+)/g)];
  assert.ok(reports.length > 0, "the board reported its heap");
  for (const [, peak, size] of reports) {
    const free = Number(size) - Number(peak);
    assert.ok(free >= HEAP_HEADROOM, `only ${free} bytes free at the peak`);
  }
  assert.equal(count(emu, "TLS: out of memory"), 0);
}

/** Checks the board is cut off: nothing reached the server, nothing drawn. */
function assertNothingGotThrough(emu: Emulator) {
  assert.deepEqual(
    emu.net.requests.map((r) => r.path),
    [],
  );
  assert.equal(emu.displays.length, 0);
}

test("speaks TLS to the server by name, and resumes the session for later requests", () => {
  const emu = boot();
  waitForFirstImages(emu);

  assert.ok(emu.net.requests.length > 0);
  for (const r of emu.net.requests) {
    assert.ok(r.tls, `${r.path} came over TLS`);
    assert.equal(r.tls.servername, SERVER_HOST, "SNI");
    assert.match(r.tls.cipher ?? "", /^ECDHE-ECDSA-/, `${r.path}'s cipher`);
  }
  // Only the first handshakes check the chain; the downloads resume the session
  const images = emu.net.requests.filter((r) => r.path.startsWith("/images/"));
  assert.equal(images.length, 3);
  assert.ok(
    images.every((r) => r.tls?.resumed),
    "downloads resume the session",
  );
  assert.ok(count(emu, "TLS: checking the server's chain") <= 2);
  assertFirstImagesShown(emu);
  assertHeapHeadroom(emu);
});

test("works with an RSA certificate too (like Let's Encrypt's)", () => {
  const emu = boot({ tlsCert: "server-rsa" });
  waitForFirstImages(emu);
  for (const r of emu.net.requests) {
    assert.match(r.tls?.cipher ?? "", /^ECDHE-RSA-/, `${r.path}'s cipher`);
  }
  assertFirstImagesShown(emu);
  assertHeapHeadroom(emu);
});

for (const [cert, why] of [
  ["wrong-host", "for another name"],
  ["untrusted", "not from a trusted root"],
] as const) {
  test(`refuses a server whose certificate is ${why}, and recovers once it's right`, () => {
    const emu = boot({ tlsCert: cert });
    const at = emu.waitForSerial(new RegExp(`TLS: server certificate \\d is ${why}`), 30_000);
    // The socket keeps failing and retrying, without crashing
    emu.waitForSerial("WS: socket closed, retrying", 60_000, at);
    emu.run(30_000);
    assertNothingGotThrough(emu);
    assert.equal(emu.reboots, 0);

    emu.net.tlsCert = undefined;
    waitForFirstImages(emu, 90_000);
    assertFirstImagesShown(emu);
  });
}

test("gives up on a TLS handshake that never finishes, then retries", () => {
  const emu = boot();
  emu.net.tlsStall = true;
  const at = emu.waitForSerial("WS: connecting...", 60_000);
  emu.waitForSerial("WS: socket is dead, dropping it", 40_000, at);
  assertNothingGotThrough(emu);

  emu.net.tlsStall = false;
  waitForFirstImages(emu, 90_000);
  assertFirstImagesShown(emu);
});

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

// Firmware updates the board refuses or gives up on: it stays on the firmware
// it runs and keeps working. (Apart from ota.test.ts so the test runner can
// run the two files side by side.)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Emulator } from "../src/emulator.ts";
import { OtaBuild, sealImage } from "../src/ota-image.ts";
import type { HttpResponse } from "../src/virtual-net.ts";
import { boot, count, FIRMWARE, waitForFirstImages } from "./helpers.ts";

const build = new OtaBuild(FIRMWARE);
const NEXT = build.nextVersion("ota2");

/**
 * Boots with the server offering NEXT, answering the download with `image`;
 * returns once the firmware has given up on it with `failure`.
 */
function offer(image: Uint8Array | HttpResponse, failure: string) {
  const emu = boot();
  if (image instanceof Uint8Array) {
    emu.server.firmware = { version: NEXT, image };
  } else {
    emu.server.firmware = { version: NEXT, image: new Uint8Array() };
    emu.server.override = (req) => (req.path === "/firmware/image" ? image : undefined);
  }
  const at = emu.waitForSerial(`OTA: updating from ${build.version} to ${NEXT}`, 60_000);
  emu.waitForSerial(failure, 120_000, at);
  return emu;
}

/** Checks the board stayed on its firmware and kept working. */
function assertStillRunning(emu: Emulator) {
  waitForFirstImages(emu, 120_000);
  emu.run(60_000);
  assert.equal(emu.server.openSockets.length, 1, "live on its socket");
  assert.equal(emu.reboots, 0);
  assert.equal(count(emu, "[BOOTLOADER] Nothing to swap"), 1, "only the first boot");
  assert.equal(count(emu, "Firmware version:"), 1);
}

test("rejects an image that doesn't match its SHA-256", () => {
  const image = build.imageFor(NEXT);
  // Flipping a bit garbles one 16 byte AES block of the decrypted image.
  image[image.length >> 1] ^= 0x01;

  assertStillRunning(offer(image, "OTA: SHA-256 check failed, discarding image"));
});

test("rejects an image encrypted with another key", () => {
  const image = sealImage(build.binary, Buffer.from("anotherkey".padEnd(32, "x")));

  assertStillRunning(offer(image, "OTA: SHA-256 check failed, discarding image"));
});

test("rejects an image that isn't whole flash pages", () => {
  const image = build.imageFor(NEXT).subarray(0, 1000);

  assertStillRunning(offer(image, "OTA: invalid firmware image size 1000"));
});

test("rejects an image too big for the download slot", () => {
  const image = new Uint8Array(1001 * 1024);

  assertStillRunning(offer(image, `OTA: invalid firmware image size ${image.length}`));
});

test("gives up on a download cut off part way", () => {
  const image = build.imageFor(NEXT);
  const cut: HttpResponse = { status: 200, body: image, truncateAt: 100_000 };

  assertStillRunning(offer(cut, "OTA: download failed"));
});

test("gives up on a download that stalls", () => {
  // lwIP's HTTP client times out first (HTTPC_RESULT_ERR_TIMEOUT)
  assertStillRunning(offer({ stall: true }, "OTA: download failed (result=5, status=0)"));
});

test("leaves a version replaced between the check and the download", () => {
  assertStillRunning(offer({ status: 409 }, "OTA: download failed (result=0, status=409)"));
});

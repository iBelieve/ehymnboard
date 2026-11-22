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

// Firmware updates over the air, through pico_fota_bootloader: the firmware
// downloads the image into the download slot, the bootloader swaps it in on
// reboot, and the new firmware commits once it reaches the server, or is
// rolled back if it reboots before then.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Emulator } from "../src/emulator.ts";
import { OtaBuild, sealImage } from "../src/ota-image.ts";
import type { HttpResponse } from "../src/virtual-net.ts";
import { boot, count, FIRMWARE } from "./helpers.ts";

const build = new OtaBuild(FIRMWARE);
const NEXT = build.nextVersion("ota2");

function requests(emu: Emulator, path: string) {
  return emu.net.requests.filter((r) => r.path === path);
}

/** Boots the build with the server offering it as NEXT; returns once NEXT is running. */
function bootAndInstallNext() {
  const emu = boot();
  emu.server.firmware = { version: NEXT, image: build.imageFor(NEXT) };

  let at = emu.waitForSerial(`OTA: updating from ${build.version} to ${NEXT}`, 60_000);
  at = emu.waitForSerial(`OTA: downloaded and verified`, 120_000, at);
  at = emu.waitForSerial("[BOOTLOADER] Swapping images...", 30_000, at);
  at = emu.waitForSerial(`Firmware version: ${NEXT}`, 30_000, at);
  at = emu.waitForSerial("OTA: running newly installed firmware", 5_000, at);
  return { emu, at };
}

test("installs the update the server offers and commits it once it reaches the server", () => {
  const { emu, at } = bootAndInstallNext();
  emu.waitForSerial("OTA: firmware is healthy, committing", 60_000, at);
  emu.waitForSerial(`OTA: firmware is up to date (${NEXT})`, 30_000, at);

  assert.equal(requests(emu, "/firmware/image").length, 1);
  const booted = requests(emu, "/device_booted").at(-1);
  assert.ok(booted);
  assert.equal(booted.query.firmware_version, NEXT);
  assert.equal(booted.query.ota_status, "updated");
  assert.equal(booted.query.ota_version, NEXT);
  // The ETags saved before the update survive it: nothing is redrawn.
  assert.equal(emu.displays.length, 3);

  // Committed, it stays installed through a power cut.
  emu.powerCycle();
  const after = emu.serial.length;
  emu.waitForSerial("[BOOTLOADER] Nothing to swap", 10_000, after);
  emu.waitForSerial(`Firmware version: ${NEXT}`, 10_000, after);
  emu.waitForSerial(`OTA: firmware is up to date (${NEXT})`, 60_000, after);
  assert.equal(count(emu, "Rolling back"), 0);
  const rebooted = requests(emu, "/device_booted").at(-1);
  assert.ok(rebooted);
  assert.equal(rebooted.query.ota_status, undefined, "a plain boot isn't reported as an update");
});

test("rolls back an update that never reaches the server, and doesn't retry it", () => {
  const { emu, at } = bootAndInstallNext();

  // The new firmware can't fetch anything, so it never commits; after 3
  // minutes it reboots and the bootloader puts the old firmware back.
  emu.server.override = (req) => (req.path.startsWith("/images/") ? { status: 500 } : undefined);
  let since = emu.waitForSerial(
    "All fetches have failed for >3 minutes, rebooting to recover",
    300_000,
    at,
  );
  emu.server.override = null;
  since = emu.waitForSerial("[BOOTLOADER] Rolling back to the previous firmware...", 60_000, since);
  since = emu.waitForSerial(`Firmware version: ${build.version}`, 30_000, since);
  since = emu.waitForSerial(`OTA: update to ${NEXT} failed and was rolled back`, 5_000, since);
  emu.waitForSerial(
    `OTA: server offers ${NEXT}, which was rolled back before, skipping`,
    60_000,
    since,
  );

  assert.equal(count(emu, "OTA: firmware is healthy, committing"), 0);
  assert.equal(
    requests(emu, "/firmware/image").length,
    1,
    "the rejected version isn't downloaded again",
  );
  const booted = requests(emu, "/device_booted").at(-1);
  assert.ok(booted);
  assert.equal(booted.query.firmware_version, build.version);
  assert.equal(booted.query.ota_status, "rolled_back");
  assert.equal(booted.query.ota_version, NEXT);

  // A newer upload is still installed.
  const third = build.nextVersion("ota3");
  emu.server.firmware = { version: third, image: build.imageFor(third) };
  emu.powerCycle();
  emu.waitForSerial(`Firmware version: ${third}`, 180_000, emu.serial.length);
});

test("a power cut during the download keeps the old firmware, then installs on the next try", () => {
  const emu = boot();
  emu.server.firmware = { version: NEXT, image: build.imageFor(NEXT) };
  emu.waitFor("the download to start", () => requests(emu, "/firmware/image").length > 0, 60_000);
  emu.run(300);
  assert.equal(count(emu, "OTA: downloaded and verified"), 0, "cut before the download is done");

  emu.powerCycle();
  const after = emu.serial.length;
  emu.waitForSerial("[BOOTLOADER] Nothing to swap", 10_000, after);
  emu.waitForSerial(`Firmware version: ${build.version}`, 10_000, after);
  emu.waitForSerial(`Firmware version: ${NEXT}`, 180_000, after);
  emu.waitForSerial("OTA: firmware is healthy, committing", 60_000, after);
  assert.equal(requests(emu, "/firmware/image").length, 2);
});

test("checks for an update on the first loop that reaches the server", () => {
  const emu = boot();
  emu.server.firmware = { version: NEXT, image: build.imageFor(NEXT) };
  emu.server.override = (req) => (req.path.startsWith("/images/") ? { status: 500 } : undefined);
  const at = emu.waitForSerial("Refreshing screens (loop=2", 60_000);
  assert.equal(requests(emu, "/firmware/latest").length, 0, "no check after a failed loop");

  emu.server.override = null;
  emu.waitForSerial(`OTA: updating from ${build.version} to ${NEXT}`, 60_000, at);
});

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
  emu.waitForSerial("Sleeping for 15 seconds", 120_000, emu.waitForSerial(failure, 120_000, at));
  return emu;
}

/** Checks the board stayed on its firmware and kept working. */
function assertStillRunning(emu: Emulator) {
  emu.waitForSerial("Refreshing screens (loop=2", 30_000, emu.serial.length);
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

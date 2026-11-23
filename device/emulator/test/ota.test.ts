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
// reboot, and the new firmware commits once its WebSocket is live, or is
// rolled back if it reboots before then.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Emulator } from "../src/emulator.ts";
import { OtaBuild } from "../src/ota-image.ts";
import { boot, count, FIRMWARE, waitForFirstImages } from "./helpers.ts";

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

test("installs the update the server offers and commits it once its socket is live", () => {
  const { emu, at } = bootAndInstallNext();
  // Commits on the first loop after the socket goes live, once that loop has
  // drawn what the state asked for
  const live = emu.waitForSerial("WS: live", 60_000, at);
  emu.waitForSerial(
    "OTA: firmware is healthy, committing",
    5_000,
    emu.waitForSerial("State saved to flash", 60_000, live),
  );
  emu.waitForSerial(`OTA: firmware is up to date (${NEXT})`, 30_000, at);
  // Committing rewrites the bootloader's flash info sector, erasing it first.
  // Let that finish: a power cut in between leaves the bootloader with no
  // application to start.
  emu.run(1_000);

  assert.equal(requests(emu, "/firmware/image").length, 1);
  const booted = requests(emu, "/device_booted").at(-1);
  assert.ok(booted);
  assert.equal(booted.query.firmware_version, NEXT);
  assert.equal(booted.query.ota_status, "updated");
  assert.equal(booted.query.ota_version, NEXT);
  // Each screen is drawn once in all (the old firmware installed the update
  // at boot, before drawing anything).
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

test("rolls back an update whose socket never goes live, and doesn't retry it", () => {
  const { emu, at } = bootAndInstallNext();

  // The new firmware's socket never gets going, so it never commits; after 3
  // minutes it reboots and the bootloader puts the old firmware back.
  emu.server.upgradeStatus = 500;
  let since = emu.waitForSerial("No live socket for >3 minutes, rebooting to recover", 300_000, at);
  assert.ok(!emu.serial.slice(at).includes("OTA: firmware is healthy"), "never committed");
  emu.server.upgradeStatus = 101;
  since = emu.waitForSerial("[BOOTLOADER] Rolling back to the previous firmware...", 60_000, since);
  since = emu.waitForSerial(`Firmware version: ${build.version}`, 30_000, since);
  since = emu.waitForSerial(`OTA: update to ${NEXT} failed and was rolled back`, 5_000, since);
  emu.waitForSerial(
    `OTA: server offers ${NEXT}, which was rolled back before, skipping`,
    60_000,
    since,
  );
  // Live again on the old firmware, the state message still offers NEXT:
  // that doesn't bring the rejected version back either.
  emu.waitForSerial("WS: live", 60_000, since);
  emu.run(10_000);

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

test("rolls back an update that can't make requests, though its socket is live", () => {
  const { emu, at } = bootAndInstallNext();

  // Before committing, the new firmware checks it can make an https request
  // besides its socket. Here every version check is cut off unanswered.
  emu.server.override = (req) => (req.path === "/firmware/latest" ? { reset: true } : undefined);
  let since = emu.waitForSerial("WS: live", 60_000, at);
  since = emu.waitForSerial(
    "OTA: new firmware can't make requests, rebooting to roll it back",
    240_000,
    since,
  );
  assert.equal(count(emu, "OTA: firmware is healthy, committing"), 0);
  emu.server.override = null;
  since = emu.waitForSerial("[BOOTLOADER] Rolling back to the previous firmware...", 60_000, since);
  emu.waitForSerial(`OTA: update to ${NEXT} failed and was rolled back`, 30_000, since);
});

test("commits an update whose version check gets an error status: the server answered", () => {
  const { emu, at } = bootAndInstallNext();
  emu.server.override = (req) => (req.path === "/firmware/latest" ? { status: 503 } : undefined);
  emu.waitForSerial(
    "OTA: firmware is healthy, committing",
    60_000,
    emu.waitForSerial("WS: live", 60_000, at),
  );
  assert.equal(count(emu, "can't make requests"), 0);
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

test("installs firmware the server pushes on the socket at once", () => {
  const emu = boot();
  const at = waitForFirstImages(emu);
  assert.equal(requests(emu, "/firmware/latest").length, 1, "one check at boot");

  emu.server.setFirmware({ version: NEXT, image: build.imageFor(NEXT) });
  const pushedAt = emu.simMs;
  emu.waitForSerial(`OTA: updating from ${build.version} to ${NEXT}`, 1_000, at);
  assert.ok(emu.simMs - pushedAt < 500, "checks as soon as the state offers it");
  emu.waitForSerial(`Firmware version: ${NEXT}`, 180_000, at);
  emu.waitForSerial("OTA: firmware is healthy, committing", 60_000, at);
});

test("an offer whose check fails is checked again within 5 minutes, not an hour", () => {
  const emu = boot();
  const at = waitForFirstImages(emu);
  let refused = 0;
  emu.server.override = (req) =>
    req.path === "/firmware/latest" && refused++ === 0 ? { status: 503 } : undefined;
  emu.server.setFirmware({ version: NEXT, image: build.imageFor(NEXT) });
  const failed = emu.waitForSerial("OTA: version check failed with status 503", 5_000, at);
  const failedAt = emu.simMs;
  emu.waitForSerial(`OTA: updating from ${build.version} to ${NEXT}`, 6 * 60_000, failed);
  const after = emu.simMs - failedAt;
  assert.ok(
    after >= 4 * 60_000 && after <= 6 * 60_000,
    `retried ${(after / 1000).toFixed(0)} s later`,
  );
  emu.waitForSerial(`Firmware version: ${NEXT}`, 180_000, failed);
});

test("still checks over HTTP hourly, and at boot even without a socket", () => {
  // A server whose socket is broken can still ship a fixed firmware
  const emu = boot();
  emu.server.upgradeStatus = 500;
  emu.waitForSerial("OTA: firmware is up to date", 60_000);
  assert.equal(requests(emu, "/firmware/latest").length, 1);

  emu.server.upgradeStatus = 101;
  waitForFirstImages(emu, 120_000);
  emu.run(61 * 60_000);
  assert.equal(requests(emu, "/firmware/latest").length, 2, "one more check an hour later");
  assert.equal(emu.reboots, 0);
});

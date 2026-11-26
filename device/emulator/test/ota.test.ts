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

// Firmware updates over the air, through the A/B bootloader: the firmware
// downloads the update into the slot it isn't running from and reboots, the
// bootloader starts it on trial, and the new firmware commits once its
// WebSocket is live. If it doesn't within its trial boots, the bootloader goes
// back to the old firmware, still in the other slot.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Emulator } from "../src/emulator.ts";
import { OtaBuild } from "../src/ota-image.ts";
import { boot, count, FIRMWARE, waitForFirstImages } from "./helpers.ts";

const build = new OtaBuild(FIRMWARE);
const NEXT = build.nextVersion("ota2");
/** Boots new firmware gets to commit (boot::TRIAL_BOOTS) */
const TRIAL_BOOTS = 3;
/** The boot record's two sectors (boot::RECORD_OFFSETS) */
const RECORD_SECTORS = [0x8000, 0x9000];

function requests(emu: Emulator, path: string) {
  return emu.net.requests.filter((r) => r.path === path);
}

/** Offers `version` of this build, both slots' images. */
function offer(emu: Emulator, version: string) {
  emu.server.firmware = { version, images: build.imagesFor(version) };
}

/** Boots the build with the server offering it as NEXT; returns once NEXT is running. */
function bootAndInstallNext() {
  const emu = boot();
  offer(emu, NEXT);

  let at = emu.waitForSerial(`OTA: updating from ${build.version} to ${NEXT}`, 60_000);
  at = emu.waitForSerial(`OTA: downloaded and verified`, 120_000, at);
  at = emu.waitForSerial(`Firmware version: ${NEXT}`, 30_000, at);
  at = emu.waitForSerial("OTA: running from slot B, A/B bootloader", 1_000, at);
  at = emu.waitForSerial("OTA: running newly installed firmware", 5_000, at);
  return { emu, at };
}

test("installs the update into the other slot and commits it once its socket is live", () => {
  const { emu, at } = bootAndInstallNext();
  assert.equal(count(emu, "OTA: running from slot A, A/B bootloader"), 1);
  assert.deepEqual(
    requests(emu, "/firmware/image").map((r) => r.query.slot),
    ["b"],
    "the board in slot A asks for slot B's image",
  );
  // Commits on the first loop after the socket goes live, once that loop has
  // drawn what the state asked for
  const live = emu.waitForSerial("WS: live", 60_000, at);
  emu.waitForSerial(
    "OTA: firmware is healthy, committing",
    5_000,
    emu.waitForSerial("State saved to flash", 60_000, live),
  );
  emu.waitForSerial(`OTA: firmware is up to date (${NEXT})`, 30_000, at);

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
  let after = emu.serial.length;
  emu.waitForSerial(`Firmware version: ${NEXT}`, 10_000, after);
  emu.waitForSerial("OTA: running from slot B", 1_000, after);
  emu.waitForSerial(`OTA: firmware is up to date (${NEXT})`, 60_000, after);
  assert.equal(count(emu, "rolled back"), 0);
  const rebooted = requests(emu, "/device_booted").at(-1);
  assert.ok(rebooted);
  assert.equal(rebooted.query.ota_status, undefined, "a plain boot isn't reported as an update");

  // The next update goes back into slot A, over the firmware NEXT replaced.
  const third = build.nextVersion("ota3");
  after = emu.serial.length;
  emu.server.setFirmware({ version: third, images: build.imagesFor(third) });
  emu.waitForSerial(`Firmware version: ${third}`, 180_000, after);
  emu.waitForSerial("OTA: running from slot A", 1_000, after);
  emu.waitForSerial("OTA: firmware is healthy, committing", 60_000, after);
  assert.equal(requests(emu, "/firmware/image").at(-1)?.query.slot, "a");
});

test("rolls back an update whose socket never goes live, after its trial boots, and doesn't retry it", () => {
  const { emu, at } = bootAndInstallNext();

  // The new firmware's socket never gets going, so it never commits; it
  // reboots after 3 minutes each time, and after its last trial boot the
  // bootloader starts the old firmware again.
  emu.server.upgradeStatus = 500;
  let since = emu.waitForSerial(
    `OTA: update to ${NEXT} failed and was rolled back`,
    20 * 60_000,
    at,
  );
  const trial = emu.serial.slice(at, since);
  assert.ok(!trial.includes("OTA: firmware is healthy"), "never committed");
  assert.equal(trial.split("No live socket for >3 minutes").length - 1, TRIAL_BOOTS);
  assert.equal(
    count(emu, `Firmware version: ${NEXT}`),
    TRIAL_BOOTS,
    "NEXT ran once for each trial boot",
  );
  assert.ok(emu.serial.lastIndexOf(`Firmware version: ${build.version}`) < since);
  assert.ok(emu.serial.lastIndexOf("OTA: running from slot A") > at);

  // Live again on the old firmware: the state message still offers NEXT, but
  // that doesn't bring the rejected version back.
  emu.server.upgradeStatus = 101;
  since = emu.waitForSerial(
    `OTA: server offers ${NEXT}, which was rolled back before, skipping`,
    60_000,
    since,
  );
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

  // A newer upload is still installed, even if the power goes while its
  // install is recorded: that attempt isn't taken for the old rollback.
  const third = build.nextVersion("ota3");
  offer(emu, third);
  emu.powerCycle();
  const cycled = emu.serial.length;
  const cut = emu.board.cutPowerDuring(1, (op) => RECORD_SECTORS.includes(op.offset));
  emu.waitFor("the cut during the install's record", cut, 180_000);
  emu.waitForSerial(`Firmware version: ${third}`, 240_000, cycled);
  assert.ok(!emu.serial.slice(cycled).includes(`update to ${third} failed`));
});

test("tries a rolled-back update again if the old firmware can't get online either", () => {
  const { emu, at } = bootAndInstallNext();

  // No socket at all, for the new firmware or the old: the network's down,
  // so the update isn't to blame
  emu.server.upgradeStatus = 500;
  let since = emu.waitForSerial(
    `OTA: update to ${NEXT} failed and was rolled back`,
    20 * 60_000,
    at,
  );
  since = emu.waitForSerial(
    `OTA: offline since the rollback, will try ${NEXT} again`,
    5 * 60_000,
    since,
  );

  emu.server.upgradeStatus = 101;
  since = emu.waitForSerial(`OTA: updating from ${build.version} to ${NEXT}`, 60_000, since);
  emu.waitForSerial("OTA: firmware is healthy, committing", 240_000, since);
  assert.equal(requests(emu, "/firmware/image").length, 2);
});

test("rolls back at once an update that can't make requests, though its socket is live", () => {
  const { emu, at } = bootAndInstallNext();

  // Before committing, the new firmware checks it can make an https request
  // besides its socket. Here every version check is cut off unanswered.
  emu.server.override = (req) => (req.path === "/firmware/latest" ? { reset: true } : undefined);
  let since = emu.waitForSerial("WS: live", 60_000, at);
  since = emu.waitForSerial(
    "OTA: new firmware can't make requests, rolling it back",
    240_000,
    since,
  );
  assert.equal(count(emu, "OTA: firmware is healthy, committing"), 0);
  emu.server.override = null;
  // (reset_pico() waits 30 s first)
  since = emu.waitForSerial(`OTA: update to ${NEXT} failed and was rolled back`, 60_000, since);
  // That firmware knew it was broken: no more trial boots
  assert.equal(count(emu, `Firmware version: ${NEXT}`), 1);
  assert.ok(emu.serial.lastIndexOf("OTA: running from slot A") > at);
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
  offer(emu, NEXT);
  emu.waitFor("the download to start", () => requests(emu, "/firmware/image").length > 0, 60_000);
  emu.run(300);
  assert.equal(count(emu, "OTA: downloaded and verified"), 0, "cut before the download is done");

  emu.powerCycle();
  const after = emu.serial.length;
  emu.waitForSerial(`Firmware version: ${build.version}`, 10_000, after);
  emu.waitForSerial("OTA: running from slot A", 1_000, after);
  emu.waitForSerial(`Firmware version: ${NEXT}`, 180_000, after);
  emu.waitForSerial("OTA: firmware is healthy, committing", 60_000, after);
  assert.equal(requests(emu, "/firmware/image").length, 2);
});

test("a power cut during a trial boot doesn't throw away a good update", () => {
  const { emu, at } = bootAndInstallNext();
  emu.powerCycle();
  const after = emu.serial.length;
  emu.waitForSerial(`Firmware version: ${NEXT}`, 10_000, after);
  emu.waitForSerial("OTA: running newly installed firmware", 5_000, after);
  emu.waitForSerial("OTA: firmware is healthy, committing", 60_000, after);
  assert.equal(count(emu, "rolled back"), 0);
  assert.ok(at < after);
});

test("installs firmware the server pushes on the socket at once", () => {
  const emu = boot();
  const at = waitForFirstImages(emu);
  assert.equal(requests(emu, "/firmware/latest").length, 1, "one check at boot");

  emu.server.setFirmware({ version: NEXT, images: build.imagesFor(NEXT) });
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
  emu.server.setFirmware({ version: NEXT, images: build.imagesFor(NEXT) });
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

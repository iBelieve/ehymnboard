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

// Moving a board from pico_fota_bootloader to the A/B bootloader over the air.
// The board starts as one in the field will: pico_fota_bootloader at the
// start of flash, the old firmware in its application slot (slot A), and the
// new firmware just downloaded into its download slot (slot B) by the old
// firmware, which then reboots. pico_fota_bootloader swaps the new one in,
// and once it's healthy it replaces pico_fota_bootloader (bootloader_install.h).
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { FlashOp } from "../src/board.ts";
import type { Emulator } from "../src/emulator.ts";
import { OtaBuild } from "../src/ota-image.ts";
import { boot, count, FIRMWARE } from "./helpers.ts";

const build = new OtaBuild(FIRMWARE);
const OLD = build.nextVersion("old0");
const NEXT = build.nextVersion("ota2");

/** pico_fota_bootloader, as the build makes it (with its logs on). */
const OLD_BOOTLOADER = path.join(
  path.dirname(FIRMWARE),
  "lib",
  "pico_fota_bootloader",
  "pico_fota_bootloader.uf2",
);
// pico_fota_bootloader's flash layout
const APPLICATION_SLOT = 0xa000;
const DOWNLOAD_SLOT = 0x104000;
const DOWNLOAD_SLOT_VALID = 0x9008;
const SHOULD_SWAP_MAGIC = 0xabcdef12;
/** Flash's first sector: boot2 and the A/B bootloader's stub. */
const STUB_SECTOR_END = 0x1000;
/** Where the A/B bootloader's slots start: below that, the bootloaders. */
const BOOTLOADERS_END = APPLICATION_SLOT;

/**
 * A board on pico_fota_bootloader with OLD in its application slot and this
 * build waiting in its download slot, powered on.
 */
function bootWithUpdateDownloaded() {
  const emu = boot({ bootloader: OLD_BOOTLOADER });
  const { flash } = emu.board;
  flash.fill(0xff, APPLICATION_SLOT);
  flash.set(build.binaryFor(OLD), APPLICATION_SLOT);
  flash.set(build.binaryFor(build.version), DOWNLOAD_SLOT);
  new DataView(flash.buffer).setUint32(DOWNLOAD_SLOT_VALID, SHOULD_SWAP_MAGIC, true);
  emu.powerCycle();
  emu.waitForSerial("[BOOTLOADER] Swapping images...", 10_000);
  const at = emu.waitForSerial(`Firmware version: ${build.version}`, 30_000);
  emu.waitForSerial("OTA: running from slot A, before the A/B bootloader", 1_000, at);
  return { emu, at: emu.waitForSerial("OTA: running newly installed firmware", 1_000, at) };
}

/** Checks the board runs this build from slot A, started by the A/B bootloader. */
function assertOnABBootloader(emu: Emulator) {
  emu.powerCycle();
  const at = emu.serial.length;
  emu.waitForSerial(`Firmware version: ${build.version}`, 10_000, at);
  emu.waitForSerial("OTA: running from slot A, A/B bootloader", 1_000, at);
  emu.waitForSerial("WS: live", 60_000, at);
  assert.ok(!emu.serial.slice(at).includes("[BOOTLOADER]"), "pico_fota_bootloader is gone");
  assert.equal(count(emu, "rolled back"), 0);
}

test("moves a board to the A/B bootloader once the new firmware is healthy, then updates it", () => {
  const { emu, at } = bootWithUpdateDownloaded();
  let since = emu.waitForSerial("Bootloader: A/B bootloader installed", 120_000, at);
  emu.waitForSerial("OTA: firmware is healthy, committing", 1_000, since);
  const booted = emu.net.requests.filter((r) => r.path === "/device_booted").at(-1);
  assert.equal(booted?.query.ota_status, "updated");
  assert.equal(booted.query.ota_version, build.version);

  assertOnABBootloader(emu);

  // Now it installs updates into slot B
  since = emu.serial.length;
  emu.server.setFirmware({ version: NEXT, images: build.imagesFor(NEXT) });
  emu.waitForSerial(`Firmware version: ${NEXT}`, 180_000, since);
  emu.waitForSerial("OTA: running from slot B, A/B bootloader", 1_000, since);
  emu.waitForSerial("OTA: firmware is healthy, committing", 60_000, since);
});

test("the old bootloader rolls back new firmware that fails before moving to the A/B bootloader", () => {
  const { emu, at } = bootWithUpdateDownloaded();
  // Its socket never goes live, so it never commits, and never replaces
  // pico_fota_bootloader, which puts OLD back
  emu.server.upgradeStatus = 500;
  const since = emu.waitForSerial("No live socket for >3 minutes", 300_000, at);
  emu.waitForSerial("[BOOTLOADER] Rolling back to the previous firmware...", 60_000, since);
  emu.waitForSerial(`Firmware version: ${OLD}`, 30_000, since);
  assert.equal(count(emu, "Bootloader: "), 0);
});

/**
 * The flash operations below the slots of a migration with no power cut,
 * from the new firmware starting to its first commit on the A/B bootloader.
 */
function migrationWrites() {
  const { emu } = bootWithUpdateDownloaded();
  const ops: FlashOp[] = [];
  emu.board.cutPowerDuring(Infinity, (op) => {
    if (op.offset < BOOTLOADERS_END) {
      ops.push(op);
    }
    return false;
  });
  emu.waitForSerial("OTA: firmware is healthy, committing", 120_000);
  return ops;
}

/** Whether `next` programs the page right after `op`'s. */
function continues(op: FlashOp | undefined, next: FlashOp | undefined) {
  return (
    op?.kind === "program" && next?.kind === "program" && op.offset + op.length === next.offset
  );
}

// Every erase, and the first and last program of each run of pages (each
// page of the stub's sector and the bootloader is a program of its own)
const writes = migrationWrites().flatMap((op, i, ops) => {
  const first = !continues(ops[i - 1], op);
  const last = !continues(op, ops[i + 1]);
  return first || last ? [{ op, nth: i + 1 }] : [];
});

/**
 * Boots the board on pico_fota_bootloader with the update downloaded, and
 * cuts the power during the migration's `nth` write (`where`); returns the
 * emulator and the serial index of the cut.
 */
function cutDuringMigration(nth: number, where: string) {
  const { emu, at } = bootWithUpdateDownloaded();
  const cut = emu.board.cutPowerDuring(nth, (o) => o.offset < BOOTLOADERS_END);
  emu.waitFor(`the cut during the ${where}`, cut, 120_000);
  const after = emu.serial.length;
  assert.ok(at < after, "the cut came after the new firmware started");
  return { emu, after };
}

for (const { op, nth } of writes) {
  const where = `${op.kind} of ${op.length} bytes at 0x${op.offset.toString(16)}`;
  if (op.offset < STUB_SECTOR_END) {
    // Flash's first sector, boot2 and the stub: the one moment the board
    // can't boot (the bootrom finds no boot2, or the stub isn't whole)
    test(`a power cut during the ${where} (flash's first sector) is the one that stops the board`, () => {
      const { emu, after } = cutDuringMigration(nth, where);
      try {
        emu.run(30_000);
      } catch {
        // A crash, as likely as nothing at all
      }
      assert.ok(!emu.serial.slice(after).includes("Firmware version"));
    });
    continue;
  }
  test(`a power cut during the ${where} still ends on the A/B bootloader`, () => {
    const { emu, after } = cutDuringMigration(nth, where);
    // Back on the new firmware, which (if it has to) finishes the move once
    // its socket is live
    emu.waitForSerial(`Firmware version: ${build.version}`, 30_000, after);
    emu.waitForSerial("WS: live", 120_000, after);
    emu.run(30_000);
    assertOnABBootloader(emu);
  });
}

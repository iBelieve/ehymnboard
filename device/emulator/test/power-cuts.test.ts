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

// Power cuts during an update, at each write that matters to the bootloader:
// the board always comes back on working firmware, and ends up on the update.
// Each test cuts the power part way through one flash operation (see
// Board.cutPowerDuring()). The download into the other slot is cut in
// ota.test.ts; the move from pico_fota_bootloader in migration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlashOp } from "../src/board.ts";
import { OtaBuild } from "../src/ota-image.ts";
import { boot, count, FIRMWARE } from "./helpers.ts";

const build = new OtaBuild(FIRMWARE);
const NEXT = build.nextVersion("ota2");

/** The boot record's two sectors (boot::RECORD_OFFSETS) */
const RECORD_SECTORS = [0x8000, 0x9000];
const isRecordWrite = (op: FlashOp) => RECORD_SECTORS.includes(op.offset);

// From the download being verified to the update committing, the boot record
// is written three times, an erase and a program each: by the old firmware
// installing the update, by the bootloader starting its first trial boot,
// and by the new firmware committing
const WRITES = [
  "the installer's erase",
  "the installer's program",
  "the first trial boot's erase",
  "the first trial boot's program",
  "the commit's erase",
  "the commit's program",
];

for (const [i, write] of WRITES.entries()) {
  test(`a power cut during ${write} leaves the board working, and on the update`, () => {
    const emu = boot();
    emu.server.firmware = { version: NEXT, images: build.imagesFor(NEXT) };
    emu.waitForSerial("OTA: downloaded and verified", 180_000);
    const cut = emu.board.cutPowerDuring(i + 1, isRecordWrite);
    emu.waitFor(`the cut during ${write}`, cut, 120_000);
    const after = emu.serial.length;

    // Back on working firmware, old or new, which then gets to the update
    // and commits it
    emu.waitForSerial("OTA: firmware is healthy, committing", 300_000, after);
    const versions = [...emu.serial.slice(after).matchAll(/Firmware version: (\S+)/g)];
    assert.equal(versions.at(-1)?.[1], NEXT);
    assert.equal(count(emu, "rolled back"), 0);

    // Committed: it stays
    emu.powerCycle();
    const cycled = emu.serial.length;
    emu.waitForSerial(`Firmware version: ${NEXT}`, 10_000, cycled);
    emu.waitForSerial("OTA: running from slot B, A/B bootloader", 1_000, cycled);
    emu.waitForSerial("WS: live", 60_000, cycled);
    assert.ok(!emu.serial.slice(cycled).includes("running newly installed firmware"));
  });
}

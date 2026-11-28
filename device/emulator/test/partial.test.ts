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

// Partial refresh: with the state's "partial" option, the board updates a
// panel with display mode 2 from the image it keeps of what the panel shows.
// The panel model changes only the pixels where the new image differs from
// the old one given, so a wrong old image shows up as a wrong frame.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RAM_BYTES, ROW_BYTES } from "../src/epaper.ts";
import type { Emulator } from "../src/emulator.ts";
import { assertHeapHeadroom, assertNoPanelFaults, boot, waitForFirstImages } from "./helpers.ts";

const FULL = 0xf7;
const PARTIAL = 0xcf;

/** A white screen with black blocks, like large digits, placed by `n`. */
function hymn(n: number) {
  const image = new Uint8Array(RAM_BYTES).fill(0xff);
  for (let row = 200 + n * 3; row < 400; row++) {
    for (let col = 10 + n * 4; col < 50 + n * 4; col++) {
      // A gap down the middle of every other block, mid-byte
      image[row * ROW_BYTES + col] = n % 2 && col === 30 + n * 4 ? 0xf0 : 0x00;
    }
  }
  return image;
}

/**
 * A busy screen: 80 rows of 38 short black strokes, about 6 KB packed, so
 * three of them nearly fill the board's budget.
 */
function busy(n: number) {
  const image = new Uint8Array(RAM_BYTES).fill(0xff);
  for (let line = 0; line < 80; line++) {
    const row = 100 + line * 6;
    for (let stroke = 0; stroke < 38; stroke++) {
      image[row * ROW_BYTES + 2 + stroke * 2 + ((n + line) % 2)] = 0x00;
    }
  }
  return image;
}

let version = 0;

/** Gives `screen` a new image and returns how the board drew it. */
function change(emu: Emulator, screen: number, draw = hymn) {
  const image = draw(++version);
  const before = emu.displays.length;
  emu.server.setImageBody(screen, `h${version}-${screen}`, image);
  emu.waitFor(`screen ${screen} drawn`, () => emu.displays.length > before, 60_000);
  const display = emu.displays.at(-1);
  assert.ok(display);
  assert.equal(display.screen, screen);
  assert.deepEqual(display.frame, image, `screen ${screen} shows the new image`);
  return display.updateControl;
}

/** Boots with partial refresh on, and waits until the first images are on. */
function bootPartial() {
  const emu = boot();
  emu.server.partialRefresh = true;
  // Images like the server's, which pack small (the emulator's own test
  // images are patterns that don't fit the budget)
  for (const screen of [1, 2, 3]) {
    emu.server.images.set(screen, { etag: `h0-${screen}`, body: hymn(0) });
  }
  const at = waitForFirstImages(emu);
  emu.waitFor(
    "the shown message",
    () => emu.server.sockets[0]?.received.some((m) => m.startsWith("shown h0-1")) ?? false,
    60_000,
  );
  return { emu, at };
}

test("updates partially once it knows what a panel shows, fully every 5th time and on a redraw", () => {
  const { emu } = bootPartial();
  // Nothing is known about the panels after a boot
  assert.deepEqual(
    emu.displays.map((d) => d.updateControl),
    [FULL, FULL, FULL],
  );
  assert.match(
    emu.serial,
    /Screen 3's image kept for partial refresh \(\d+ bytes packed, \d+ in all\)/,
  );

  // Four partial updates, then a full one, then partial again
  const updates = Array.from({ length: 6 }, () => change(emu, 2));
  assert.deepEqual(updates, [PARTIAL, PARTIAL, PARTIAL, PARTIAL, FULL, PARTIAL]);
  // The other screens weren't touched, and the old image went to the RED RAM
  const panel = emu.board.panels[1];
  assert.ok(panel.transcript.includes("0x26 <81600 bytes>"));
  assert.ok(panel.transcript.includes("0x22 cf"));
  assertNoPanelFaults(emu);

  // A redraw is a full update of each screen, after which partial works again
  const before = emu.displays.length;
  emu.server.sockets.at(-1)?.sendText("redraw");
  emu.waitFor("the redraw", () => emu.displays.length === before + 3, 60_000);
  assert.deepEqual(
    emu.displays.slice(before).map((d) => d.updateControl),
    [FULL, FULL, FULL],
  );
  assert.equal(change(emu, 1), PARTIAL);
  assertNoPanelFaults(emu);
});

test("is off unless the server turns it on, and a reboot starts with full updates", () => {
  const { emu, at } = bootPartial();
  assert.equal(change(emu, 1), PARTIAL);

  // Turned off: every update is full, and the images are let go
  emu.server.setPartialRefresh(false);
  emu.waitForSerial("Partial refresh turned off", 5_000, at);
  assert.equal(change(emu, 1), FULL);
  assert.equal(change(emu, 1), FULL);

  // Turned back on: the first update is full, as the panel's image wasn't kept
  emu.server.setPartialRefresh(true);
  assert.equal(change(emu, 1), FULL);
  assert.equal(change(emu, 1), PARTIAL);

  // After a reboot nothing is known about the panels
  const cycled = emu.serial.length;
  emu.powerCycle();
  emu.waitForSerial("Partial refresh turned on", 60_000, cycled);
  assert.equal(change(emu, 1), FULL);
  assert.equal(change(emu, 1), PARTIAL);
  assertNoPanelFaults(emu);
});

test("keeps enough heap for TLS with busy screens near the budget", () => {
  const { emu } = bootPartial();
  // Each panel's image is kept in turn, so all three are held by the end
  for (let round = 0; round < 3; round++) {
    for (const screen of [1, 2, 3]) change(emu, screen, busy);
  }
  const kept = [
    ...emu.serial.matchAll(/kept for partial refresh \(\d+ bytes packed, (\d+) in all\)/g),
  ];
  const most = Math.max(...kept.map(([, all]) => Number(all)));
  assert.ok(most > 17 * 1024, `the images came near the budget (${most} bytes)`);
  // A busy update after all three are kept is still partial
  assert.equal(change(emu, 2, busy), PARTIAL);
  assertHeapHeadroom(emu);
  assertNoPanelFaults(emu);
});

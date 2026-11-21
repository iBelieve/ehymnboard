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

// Unit tests for the SSD1677 panel model on its own, without the firmware.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EPaperPanel, type PanelDisplay, RAM_BYTES, ROW_BYTES } from "../epaper.ts";

/** A powered panel with a fake clock: run() fires the timers it scheduled. */
type TestPanel = EPaperPanel & { run: () => void; displayed: PanelDisplay[] };

function panel(): TestPanel {
  const timers: (() => void)[] = [];
  const displayed: PanelDisplay[] = [];
  const run = () => {
    for (let fn = timers.shift(); fn; fn = timers.shift()) {
      fn();
    }
  };
  const p = Object.assign(new EPaperPanel({ id: 1, after: (_ms, fn) => timers.push(fn) }), {
    run,
    displayed,
  });
  p.onDisplay = (d) => displayed.push(d);
  p.setPower(true);
  p.setReset(false);
  p.setReset(true);
  p.run();
  return p;
}

const send = (p: EPaperPanel, cmd: number, ...data: number[]) => {
  p.byte(cmd, false);
  for (const d of data) {
    p.byte(d, true);
  }
};

const refresh = (p: TestPanel) => {
  send(p, 0x22, 0xf7);
  send(p, 0x20);
  p.run();
};

test("a full frame written with the POR window lands in raster order", () => {
  const p = panel();
  const frame = Uint8Array.from({ length: RAM_BYTES }, (_, i) => (i * 7) & 0xff);
  send(p, 0x24, ...frame);
  refresh(p);
  assert.deepEqual(p.faults, []);
  assert.equal(p.displayed.length, 1);
  assert.deepEqual(p.displayed[0].image, frame);
});

test("a window and counters place a partial write; X is in pixels", () => {
  const p = panel();
  send(p, 0x24, ...new Uint8Array(RAM_BYTES).fill(0xff));
  // Two bytes wide (pixels 16-31), two rows (10-11), X first, both increasing.
  send(p, 0x11, 0x03);
  send(p, 0x44, 16, 0, 31, 0);
  send(p, 0x45, 10, 0, 11, 0);
  send(p, 0x4e, 16, 0);
  send(p, 0x4f, 10, 0);
  send(p, 0x24, 1, 2, 3, 4);
  refresh(p);
  const img = p.displayed[0].image;
  assert.deepEqual([...img.subarray(10 * ROW_BYTES + 1, 10 * ROW_BYTES + 5)], [0xff, 1, 2, 0xff]);
  assert.deepEqual([...img.subarray(11 * ROW_BYTES + 1, 11 * ROW_BYTES + 5)], [0xff, 3, 4, 0xff]);
});

test("Y-first entry mode fills columns", () => {
  const p = panel();
  send(p, 0x11, 0x07);
  send(p, 0x44, 0, 0, 15, 0);
  send(p, 0x45, 0, 0, 1, 0);
  send(p, 0x24, 1, 2, 3, 4);
  refresh(p);
  const img = p.displayed[0].image;
  assert.deepEqual([img[0], img[ROW_BYTES], img[1], img[ROW_BYTES + 1]], [1, 2, 3, 4]);
});

test("only the gate lines set by driver output control are refreshed", () => {
  const p = panel();
  send(p, 0x01, 99, 0, 0); // 100 gate lines
  send(p, 0x24, ...new Uint8Array(RAM_BYTES).fill(0));
  refresh(p);
  const img = p.displayed[0].image;
  assert.equal(img[99 * ROW_BYTES], 0);
  assert.equal(img[100 * ROW_BYTES], 0xff, "rows past the gates keep the old (white) image");
});

test("BUSY stays high through a refresh and commands during it are faults", () => {
  const p = panel();
  send(p, 0x22, 0xf7);
  send(p, 0x20);
  assert.equal(p.busy, true);
  send(p, 0x12);
  assert.match(p.faults[0], /command 0x12 sent while BUSY is high/);
  p.run();
  assert.equal(p.busy, false);
});

test("protocol mistakes are recorded as faults", () => {
  const p = panel();
  send(p, 0x44, 0, 0); // two of four bytes, then a new command
  send(p, 0x99);
  send(p, 0x20);
  send(p, 0x24, ...new Uint8Array(RAM_BYTES + 1));
  send(p, 0x11, 3, 3);
  p.byte(0x12, false);
  p.run();
  send(p, 0x22, 0xf7);
  send(p, 0x20);
  p.setPower(false);
  send(p, 0x12);
  assert.deepEqual(p.faults, [
    "0x44 (set RAM X start/end) got 2 of 4 data bytes",
    "unknown command 0x99",
    "master activation (0x20) before display update control 2 (0x22)",
    "0x24 wrote 81601 bytes, more than the 81600 in the RAM window",
    "0x11 (data entry mode) got more than its 1 data bytes",
    "power cut while BUSY is high",
    "SPI byte 0x12 while the panel is powered off",
  ]);
});

test("deep sleep ignores everything until a hardware reset", () => {
  const p = panel();
  send(p, 0x10, 0x03);
  send(p, 0x24, 0);
  assert.match(p.faults[0], /in deep sleep/);
  const faults = p.faults.length;
  p.setReset(false);
  p.setReset(true);
  p.run();
  send(p, 0x24, 0);
  assert.equal(p.faults.length, faults);
});

test("the transcript lists commands, data and pin events", () => {
  const p = panel();
  send(p, 0x24, 1, 2, 3);
  send(p, 0x3c, 0x05);
  p.setPower(false);
  assert.deepEqual(p.transcript, [
    "power on",
    "hardware reset",
    "0x24 <3 bytes>",
    "0x3c 05",
    "power off",
  ]);
});

/*
 * eHymnBoard full-stack end-to-end tests
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

// What a panel shows: a 960x680 1-bit frame, 8 pixels per byte, most
// significant bit first, as the board sent it to the panel's RAM.
import zlib from "node:zlib";

export const WIDTH = 960;
const HEIGHT = 680;

/** Each screen shows two lines: the first in its top band, the second in its bottom band. */
const LINE_BAND = Math.round(HEIGHT * 0.45);
export const TOP = { from: 0, to: LINE_BAND };
export const BOTTOM = { from: HEIGHT - LINE_BAND, to: HEIGHT };

function pixel(frame: Uint8Array, x: number, y: number) {
  const i = y * WIDTH + x;
  return (frame[i >> 3] >> (7 - (i & 7))) & 1;
}

/** Where text was drawn in rows [from, to): pixels that differ from the background. */
export function inkIn(frame: Uint8Array, band: { from: number; to: number }) {
  const background = pixel(frame, 0, 0);
  let count = 0;
  let left = WIDTH;
  let right = -1;
  for (let y = band.from; y < band.to; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (pixel(frame, x, y) !== background) {
        count++;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return { count, centerX: count ? (left + right) / 2 : NaN, width: right - left + 1 };
}

/** The rows [from, to) of a frame, to compare one band across frames. */
export function rows(frame: Uint8Array, band: { from: number; to: number }) {
  return frame.subarray((band.from * WIDTH) / 8, (band.to * WIDTH) / 8);
}

/** A frame as a grayscale PNG, to attach to a test report. */
export function toPng(frame: Uint8Array) {
  const raw = Buffer.alloc((WIDTH + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      raw[y * (WIDTH + 1) + 1 + x] = pixel(frame, x, y) ? 255 : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

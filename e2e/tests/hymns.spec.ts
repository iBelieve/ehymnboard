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

// An usher changes the hymns on the admin page, and the board shows them:
// each change is downloaded and drawn once, on the screens it touches, and
// after that the board gets 304s instead of downloading again.
import { BOTTOM, inkIn, rows, TOP, WIDTH } from "./frames.ts";
import { type Board, expect, type Loop, test } from "./fixtures.ts";

const HYMNS = ["Hymn", "123", "Psalm", "23", "Offertory", "456"];

/** The screens redrawn in a loop, in order. */
const redrawn = (loop: Loop) => loop.displays.map((d) => d.screen);
const statuses = (loop: Loop) => loop.images.map((i) => [i.screen, i.status]);
const ALL_304 = [
  [1, 304],
  [2, 304],
  [3, 304],
];

/** The board's next few loops all get 304s and redraw nothing. */
async function expectSettled(board: Board, loops = 3) {
  for (let i = 0; i < loops; i++) {
    const loop = await board.nextLoop();
    expect(statuses(loop), "no download once the board has the current image").toEqual(ALL_304);
    expect(redrawn(loop)).toEqual([]);
  }
}

/** Text in a band of a screen: some ink, centered across the screen. */
function expectText(frame: Uint8Array, band: typeof TOP) {
  const ink = inkIn(frame, band);
  expect(ink.count).toBeGreaterThan(1000);
  expect(Math.abs(ink.centerX - WIDTH / 2)).toBeLessThan(20);
  return ink;
}

test("hymns typed on the admin page reach the board once, then 304s", async ({ admin, board }) => {
  await admin.clear();

  // A new board downloads all three (blank) screens, then settles.
  const first = await board.nextLoop();
  expect(statuses(first)).toEqual([
    [1, 200],
    [2, 200],
    [3, 200],
  ]);
  expect(redrawn(first)).toEqual([1, 2, 3]);
  for (const { frame } of first.displays) {
    expect(inkIn(frame, { from: 0, to: 680 }).count, "a blank screen").toBe(0);
  }
  await expectSettled(board);

  // The board shows up on the admin page.
  await expect(await admin.boardStatus(board.id)).toContainText("last seen just now");

  // New hymns: each screen is redrawn once with its two lines.
  await admin.apply(HYMNS);
  const posted = await board.nextLoop();
  expect(redrawn(posted)).toEqual([1, 2, 3]);
  for (const { frame } of posted.displays) {
    expectText(frame, TOP);
    expectText(frame, BOTTOM);
  }
  // Longer lines are drawn wider: "Offertory" against "Hymn".
  expect(inkIn(posted.displays[2].frame, TOP).width).toBeGreaterThan(
    inkIn(posted.displays[0].frame, TOP).width,
  );
  // The admin's picture of the board shows exactly what the panels show.
  const preview = await admin.previewFrames();
  for (const [i, { frame }] of posted.displays.entries()) {
    expect(Buffer.from(preview[i]).equals(Buffer.from(frame)), `screen ${i + 1} preview`).toBe(
      true,
    );
  }
  await expectSettled(board);

  // Changing line 4 changes only the bottom of screen 2.
  await admin.apply(HYMNS.with(3, "100"));
  const changed = await board.nextLoop();
  expect(statuses(changed)).toEqual([
    [1, 304],
    [2, 200],
    [3, 304],
  ]);
  expect(redrawn(changed)).toEqual([2]);
  const [before, after] = [posted.displays[1].frame, changed.displays[0].frame];
  expect(Buffer.from(rows(after, TOP)).equals(Buffer.from(rows(before, TOP)))).toBe(true);
  expect(Buffer.from(rows(after, BOTTOM)).equals(Buffer.from(rows(before, BOTTOM)))).toBe(false);
  expectText(after, BOTTOM);
  await expectSettled(board);

  // Clear blanks every screen, once.
  await admin.clear();
  const cleared = await board.nextLoop();
  expect(redrawn(cleared)).toEqual([1, 2, 3]);
  for (const { frame } of cleared.displays) {
    expect(inkIn(frame, { from: 0, to: 680 }).count).toBe(0);
  }
  await expectSettled(board, 1);
});

test("a board that loses power keeps its screens and doesn't download them again", async ({
  admin,
  board,
}) => {
  await admin.apply(HYMNS);
  const first = await board.nextLoop();
  expect(redrawn(first)).toEqual([1, 2, 3]);

  board.powerCycle();
  // Back on, it reports the boot and sends the ETags it saved in flash.
  await expectSettled(board, 2);
  await expect(await admin.boardStatus(board.id)).toContainText("booted just now");

  // E-paper keeps its image without power, so nothing needed redrawing, and
  // the next change still arrives.
  await admin.apply(HYMNS.with(0, "Hymns"));
  const changed = await board.nextLoop();
  expect(redrawn(changed)).toEqual([1]);
});

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
// the server pushes the change over the board's WebSocket, and the board
// downloads and draws only the screens it touches, within a second or two.
// In between, it sends nothing but pings.
import { BOTTOM, inkIn, rows, TOP, WIDTH } from "./frames.ts";
import { type Board, expect, type Loop, PARTIAL_REFRESH, test } from "./fixtures.ts";

const HYMNS = ["Hymn", "123", "Psalm", "23", "Offertory", "456"];

/** The screens redrawn, in order. */
const redrawn = (loop: Loop) => loop.displays.map((d) => d.screen);
const statuses = (loop: Loop) => loop.images.map((i) => [i.screen, i.status]);
/** Whether each redraw was a partial update. */
const partial = (loop: Loop) => loop.displays.map((d) => d.partial);

/** A minute goes by with no downloads and no redraws: the board isn't polling. */
async function expectSettled(board: Board) {
  const quiet = await board.quiet(60_000);
  expect(statuses(quiet), "no downloads while nothing changes").toEqual([]);
  expect(redrawn(quiet)).toEqual([]);
}

/** Text in a band of a screen: some ink, centered across the screen. */
function expectText(frame: Uint8Array, band: typeof TOP) {
  const ink = inkIn(frame, band);
  expect(ink.count).toBeGreaterThan(1000);
  expect(Math.abs(ink.centerX - WIDTH / 2)).toBeLessThan(20);
  return ink;
}

test("hymns typed on the admin page are pushed to the board and drawn once", async ({
  admin,
  board,
}) => {
  await admin.clear();

  // A new board downloads all three (blank) screens, then settles.
  const first = await board.nextUpdate();
  expect(statuses(first)).toEqual([
    [1, 200],
    [2, 200],
    [3, 200],
  ]);
  expect(redrawn(first)).toEqual([1, 2, 3]);
  for (const { frame } of first.displays) {
    expect(inkIn(frame, { from: 0, to: 680 }).count, "a blank screen").toBe(0);
  }
  // Nothing is known about the panels after a boot: full updates
  expect(partial(first)).toEqual([false, false, false]);
  await expectSettled(board);

  // The board shows up on the Hymn Boards page, live on its socket.
  await expect(await admin.boardField(board.id, "Last seen")).toHaveText("just now");
  const status = await admin.boardField(board.id, "Status");
  await expect(status).toContainText("Live");
  if (PARTIAL_REFRESH) {
    await expect(status).toContainText("Partial refresh");
  } else {
    await expect(status).not.toContainText("Partial refresh");
  }

  // New hymns: each screen is redrawn once with its two lines.
  await admin.apply(HYMNS);
  const posted = await board.nextUpdate(30_000);
  expect(statuses(posted)).toEqual([
    [1, 200],
    [2, 200],
    [3, 200],
  ]);
  expect(redrawn(posted)).toEqual([1, 2, 3]);
  // From here on, with partial refresh, the panels change without flashing
  expect(partial(posted)).toEqual(Array(3).fill(PARTIAL_REFRESH));
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

  // Changing line 4 changes only the bottom of screen 2: only it is fetched.
  await admin.apply(HYMNS.with(3, "100"));
  const changed = await board.nextUpdate(30_000);
  expect(statuses(changed)).toEqual([[2, 200]]);
  expect(redrawn(changed)).toEqual([2]);
  expect(partial(changed)).toEqual([PARTIAL_REFRESH]);
  const [before, after] = [posted.displays[1].frame, changed.displays[0].frame];
  expect(Buffer.from(rows(after, TOP)).equals(Buffer.from(rows(before, TOP)))).toBe(true);
  expect(Buffer.from(rows(after, BOTTOM)).equals(Buffer.from(rows(before, BOTTOM)))).toBe(false);
  expectText(after, BOTTOM);
  await expectSettled(board);

  // Clear blanks every screen, once.
  await admin.clear();
  const cleared = await board.nextUpdate(30_000);
  expect(redrawn(cleared)).toEqual([1, 2, 3]);
  expect(partial(cleared)).toEqual(Array(3).fill(PARTIAL_REFRESH));
  for (const { frame } of cleared.displays) {
    expect(inkIn(frame, { from: 0, to: 680 }).count).toBe(0);
  }
  await expectSettled(board);
});

test("a change reaches the board within seconds of Apply", async ({ admin, board }) => {
  await admin.apply(HYMNS);
  await board.nextUpdate();
  await board.quiet(5_000);

  // The simulated clock only runs while the test runs the board, so time the
  // push in simulated time: from Apply to the board asking for the image.
  await admin.apply(HYMNS.with(0, "Psalm"));
  const pushedAt = board.emu.simMs;
  await board.untilSerial("Refreshing screen 1", 5_000);
  const latency = board.emu.simMs - pushedAt;
  expect(latency, `asked for the new image ${latency.toFixed(0)} ms after Apply`).toBeLessThan(
    1_000,
  );
  const changed = await board.nextUpdate(30_000);
  expect(redrawn(changed)).toEqual([1]);
});

test("a board that loses power keeps its screens and doesn't download them again", async ({
  admin,
  board,
}) => {
  await admin.apply(HYMNS);
  const first = await board.nextUpdate();
  expect(redrawn(first)).toEqual([1, 2, 3]);

  board.powerCycle();
  // Back on, it reports the boot and its saved ETags match what the server
  // pushes, so nothing is downloaded.
  await board.untilSerial("WS: live");
  await expectSettled(board);
  await expect(await admin.boardField(board.id, "Booted")).toHaveText("just now");

  // E-paper keeps its image without power, so nothing needed redrawing, and
  // the next change still arrives.
  await admin.apply(HYMNS.with(0, "Hymns"));
  const changed = await board.nextUpdate(30_000);
  expect(redrawn(changed)).toEqual([1]);
});

test("a board cut off from the server catches up on a change made meanwhile", async ({
  admin,
  board,
}) => {
  await admin.apply(HYMNS);
  await board.nextUpdate();
  await expect(await admin.boardField(board.id, "Status")).toContainText("Live");

  // The network drops the board. Its next ping fails and it starts retrying.
  board.setOffline(true);
  await board.untilSerial("WS: socket closed, retrying in", 60_000);
  await expect(await admin.boardField(board.id, "Status")).toContainText("Offline");

  // The hymns change while it's away: nothing reaches it.
  await admin.apply(HYMNS.with(5, "789"));
  const away = await board.quiet(20_000);
  expect(redrawn(away)).toEqual([]);

  // Back on the network, it reconnects, gets the current state and redraws
  // only the screen that changed.
  board.setOffline(false);
  await board.untilSerial("WS: live", 120_000);
  const caughtUp = await board.nextUpdate(30_000);
  expect(statuses(caughtUp)).toEqual([[3, 200]]);
  expect(redrawn(caughtUp)).toEqual([3]);
  expect(board.emu.reboots).toBe(0);
  await expect(await admin.boardField(board.id, "Status")).toContainText("Live");
});

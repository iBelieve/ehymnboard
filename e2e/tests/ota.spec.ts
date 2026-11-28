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

// A release goes out over the air: it's uploaded to the server the way a
// release is published (POST /firmware, as in device/README.md), a board
// running the previous release is told about it over its WebSocket, downloads
// the image for the A/B bootloader's other slot, reboots into it and commits
// it, and the admin page shows the board on the new version.
import { OtaBuild } from "../../device/emulator/src/ota-image.ts";
import { expect, FIRMWARE, publishRelease, test } from "./fixtures.ts";

/**
 * A Firmware cell's text on `version`. A rollback stays noted under the
 * version until a board next installs one, as it may from a run before on
 * a server other than the tests' own.
 */
function onVersion(version: string) {
  return new RegExp(`^${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
}

test("a published release is installed over the air and reported", async ({
  admin,
  board,
  request,
}) => {
  // The same build relabelled as a new release: an image the bootloader
  // accepts (same key) that reports another version. (The board fixture has
  // the server offering the build's own version.)
  const build = new OtaBuild(FIRMWARE);
  const NEXT = build.nextVersion("ota2");
  await admin.apply(["Hymn", "1", "", "", "", "2"]);

  // On the current release, the board stays put and shows the hymns.
  await board.untilSerial(`OTA: firmware is up to date (${build.version})`);
  await board.nextUpdate();
  await expect(await admin.boardField(board.id, "Firmware")).toHaveText(onVersion(build.version), {
    useInnerText: true,
  });
  const shown = board.emu.displays.length;
  expect(shown).toBe(3);

  // A new release is published.
  await publishRelease(request, NEXT, build.bundleFor(NEXT));
  await admin.openBoards();
  await expect(admin.page.getByText(`Latest firmware ${NEXT}`)).toBeVisible();

  // The server pushes the new version to the board at once; it downloads and
  // verifies it, and the bootloader starts it from slot B.
  await board.untilSerial(`OTA: updating from ${build.version} to ${NEXT}`, 30_000);
  await board.untilSerial("OTA: downloaded and verified", 180_000);
  await board.untilSerial(`Firmware version: ${NEXT}`, 60_000);
  await board.untilSerial("OTA: running from slot B, A/B bootloader", 30_000);
  await board.untilSerial("OTA: running newly installed firmware", 30_000);
  // Once its socket is live on the new release, it commits it.
  await board.untilSerial("OTA: firmware is healthy, committing", 120_000);
  await board.untilSerial(`OTA: firmware is up to date (${NEXT})`, 120_000);
  expect(board.emu.reboots, "one reboot, into the new release").toBe(1);

  // The admin shows the board on the new release...
  await expect(await admin.boardField(board.id, "Firmware")).toHaveText(onVersion(NEXT), {
    useInnerText: true,
  });
  // ...and the update kept its saved screens: nothing downloaded or redrawn.
  const after = await board.quiet(60_000);
  expect(after.images).toEqual([]);
  expect(board.emu.displays.length).toBe(shown);

  // It stays on the new release: no second download.
  const downloads = board.emu.net.requests.filter((r) => r.path === "/firmware/image");
  expect(downloads.map((r) => [r.query.target_version, r.query.slot, r.status])).toEqual([
    [NEXT, "b", 200],
  ]);
});

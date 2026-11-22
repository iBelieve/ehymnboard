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
// running the previous release sees it, downloads it, installs it through
// the bootloader, reboots into it and commits it, and the admin page shows
// the board on the new version.
import { OtaBuild } from "../../device/emulator/src/ota-image.ts";
import type { APIRequestContext } from "@playwright/test";
import { expect, FIRMWARE, test } from "./fixtures.ts";

const build = new OtaBuild(FIRMWARE);
// The same build relabelled as a new release: an image the bootloader
// accepts (same key) that reports another version.
const NEXT = build.nextVersion("ota2");

async function publish(request: APIRequestContext, version: string, image: Uint8Array) {
  const response = await request.post("/firmware", {
    multipart: {
      version,
      image: {
        name: "ehymnboard_fota_image_encrypted.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(image),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
}

// Whatever happens, leave the server offering the build under test, so the
// next board to boot isn't updated by surprise.
test.afterEach(async ({ request }) => {
  await publish(request, build.version, build.imageFor(build.version));
});

test("a published release is installed over the air and reported", async ({
  admin,
  board,
  request,
}) => {
  await publish(request, build.version, build.imageFor(build.version));
  await admin.apply(["Hymn", "1", "", "", "", "2"]);

  // On the current release, the board stays put and shows the hymns.
  await board.untilSerial(`OTA: firmware is up to date (${build.version})`);
  await board.nextLoop();
  await expect(await admin.boardStatus(board.id)).toContainText(`firmware ${build.version}`);
  const shown = board.emu.displays.length;
  expect(shown).toBe(3);

  // A new release is published.
  await publish(request, NEXT, build.imageFor(NEXT));
  await admin.open();
  await expect(admin.page.getByText(`Latest firmware ${NEXT}`)).toBeVisible();

  // The board finds it at its next check (every 10 minutes), downloads and
  // verifies it, and the bootloader swaps it in.
  await board.untilSerial(`OTA: updating from ${build.version} to ${NEXT}`, 11 * 60_000);
  await board.untilSerial("OTA: downloaded and verified", 180_000);
  await board.untilSerial("[BOOTLOADER] Swapping images...", 60_000);
  await board.untilSerial(`Firmware version: ${NEXT}`, 60_000);
  await board.untilSerial("OTA: running newly installed firmware", 30_000);
  // Once it has reached the server on the new release, it commits it.
  await board.untilSerial("OTA: firmware is healthy, committing", 120_000);
  await board.untilSerial(`OTA: firmware is up to date (${NEXT})`, 120_000);
  expect(board.emu.reboots, "one reboot, into the new release").toBe(1);

  // The admin shows the board on the new release...
  await expect(await admin.boardStatus(board.id)).toContainText(`firmware ${NEXT}`);
  // ...and the update kept its saved screens: 304s, nothing redrawn.
  const after = await board.nextLoop();
  expect(after.images.map((i) => i.status)).toEqual([304, 304, 304]);
  expect(board.emu.displays.length).toBe(shown);

  // It stays on the new release: no second download.
  await board.nextLoop();
  const downloads = board.emu.net.requests.filter((r) => r.path === "/firmware/image");
  expect(downloads.map((r) => [r.query.target_version, r.status])).toEqual([[NEXT, 200]]);
});

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

// The two actors of every test: an usher on the admin page (a Playwright
// page, driven only through what a person sees and clicks) and a board (the
// real firmware in the emulator, sending its requests to the same server).
import fs from "node:fs";
import path from "node:path";
import {
  type APIRequestContext,
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { Emulator } from "../../device/emulator/src/emulator.ts";
import { toPng } from "./frames.ts";

/** The firmware under test: $FIRMWARE_UF2, or device/build/ehymnboard.uf2. */
export const FIRMWARE =
  process.env.FIRMWARE_UF2 ??
  path.join(import.meta.dirname, "..", "..", "device", "build", "ehymnboard.uf2");

export const LINE_COUNT = 6;

/** Publishes a firmware release the way a release is published (`POST /firmware`). */
export async function publishRelease(
  request: APIRequestContext,
  version: string,
  image: Uint8Array,
) {
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

/** The version and encrypted OTA image of the firmware under test, from its build directory. */
function buildRelease() {
  const dir = path.dirname(FIRMWARE);
  return {
    version: fs.readFileSync(path.join(dir, "firmware_version.txt"), "utf8").trim(),
    image: fs.readFileSync(path.join(dir, "ehymnboard_fota_image_encrypted.bin")),
  };
}

/**
 * The admin page, found by what a person sees on it: six text boxes in
 * order, Apply and Clear buttons, a line per board and a picture of the
 * board. Nothing depends on how the page is built.
 */
export class AdminPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get lines() {
    return this.page.getByRole("textbox");
  }

  async open() {
    await this.page.goto("/");
    await expect(this.lines).toHaveCount(LINE_COUNT);
    // A page that loads its lines with a script may disable the boxes until then.
    await expect(this.lines.last()).toBeEnabled();
  }

  /** Types the six lines and applies them, then checks they were saved. */
  async apply(lines: readonly string[]) {
    await this.open();
    for (const [i, line] of lines.entries()) {
      await this.lines.nth(i).fill(line);
    }
    await this.#submit("Apply");
    await this.expectLines(lines);
  }

  async clear() {
    await this.open();
    await this.#submit("Clear");
    await this.expectLines(Array<string>(LINE_COUNT).fill(""));
  }

  /** After a fresh load, the page shows these lines. */
  async expectLines(lines: readonly string[]) {
    await this.open();
    for (const [i, line] of lines.entries()) {
      await expect(this.lines.nth(i)).toHaveValue(line);
    }
  }

  /** The admin's line for a board, after a fresh load. */
  async boardStatus(id: string) {
    await this.open();
    return this.page.getByText(new RegExp(`${id} \\(last seen`));
  }

  /**
   * The three screens in the page's picture of the board, read back from
   * the images it draws, as 1-bit frames like the ones a panel shows.
   */
  async previewFrames() {
    await this.open();
    const images = this.page.locator("svg image");
    await expect(images).toHaveCount(3);
    // This runs in the page, so it can only use what's in it.
    const frames = await images.evaluateAll((elements: Element[]) =>
      Promise.all(
        elements.map(async (element) => {
          const href = element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "";
          const image = new Image();
          image.src = new URL(href, document.baseURI).href;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("no 2D canvas");
          }
          context.drawImage(image, 0, 0);
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          const bits = Array.from({ length: (canvas.width * canvas.height) / 8 }, () => 0);
          for (let i = 0; i < canvas.width * canvas.height; i++) {
            if (data[i * 4] > 127) {
              bits[i >> 3] |= 0x80 >> (i & 7);
            }
          }
          return bits;
        }),
      ),
    );
    return frames.map((bits) => Uint8Array.from(bits));
  }

  /** Clicks Apply or Clear and waits for the server to take the change. */
  async #submit(button: "Apply" | "Clear") {
    // Whatever request saves the change: a form post or a script's fetch.
    const saved = this.page.waitForResponse((r) => r.request().method() !== "GET");
    await this.page.getByRole("button", { name: button }).click();
    const response = await saved;
    expect(response.status()).toBeLessThan(400);
    // A form post redirects back to the page: let that finish before the
    // next navigation, so it doesn't interrupt it.
    let request = response.request();
    for (let next = request.redirectedTo(); next; next = next.redirectedTo()) {
      request = next;
    }
    await request.response();
    await this.page.waitForLoadState();
  }
}

/** One pass of the firmware's main loop: what it fetched and what it redrew. */
export interface Loop {
  images: { screen: number; status: number | undefined }[];
  displays: { screen: number; frame: Uint8Array }[];
}

/** A board running the firmware under test against the server at `backend`. */
export class Board {
  readonly emu: Emulator;
  #at = 0;

  constructor(backend: string) {
    const verbose = !!process.env.EMULATOR_VERBOSE;
    this.emu = new Emulator({ firmware: FIRMWARE, backend, quiet: !verbose, echo: verbose });
  }

  /** The id the board reports itself as. */
  get id() {
    const id = this.emu.net.requests.find((r) => r.query.device_id)?.query.device_id;
    if (!id) {
      throw new Error("the board hasn't reported to the server yet");
    }
    return id;
  }

  /** Runs until the board next finishes refreshing its screens and goes to sleep. */
  async nextLoop(): Promise<Loop> {
    const requests = this.emu.net.requests.length;
    const displays = this.emu.displays.length;
    this.#at = await this.emu.untilSerial(/Refreshing screens \(loop=\d+/, 120_000, this.#at);
    this.#at = await this.emu.untilSerial("Sleeping for 15 seconds", 120_000, this.#at);
    return {
      images: this.emu.net.requests.slice(requests).flatMap((r) => {
        const screen = /^\/images\/(\d)$/.exec(r.path)?.[1];
        return screen ? [{ screen: Number(screen), status: r.status }] : [];
      }),
      displays: this.emu.displays.slice(displays).map(({ screen, frame }) => ({ screen, frame })),
    };
  }

  /** Runs until the firmware prints `text`, from where the last wait stopped. */
  async untilSerial(text: string | RegExp, ms = 120_000) {
    this.#at = await this.emu.untilSerial(text, ms, this.#at);
  }

  powerCycle() {
    this.emu.powerCycle();
  }

  /** Attaches the serial output, the board's requests and every frame shown. */
  async attachTo(testInfo: TestInfo) {
    await testInfo.attach("serial.log", { body: this.emu.serial, contentType: "text/plain" });
    const requests = this.emu.net.requests
      .map((r) => `${r.raw.split("\r\n")[0]} -> ${r.status ?? "no answer"}`)
      .join("\n");
    await testInfo.attach("requests.log", { body: requests, contentType: "text/plain" });
    for (const [i, d] of this.emu.displays.entries()) {
      await testInfo.attach(`display-${i + 1}-screen-${d.screen}.png`, {
        body: toPng(d.frame),
        contentType: "image/png",
      });
    }
  }
}

/**
 * `admin` is the admin page; `backend` is the server's origin; `board`
 * boots a fresh board (blank flash) per test, and its logs and every frame
 * it showed are attached to the report. Before the board boots, the server
 * is made to offer the firmware under test, so a release left over on the
 * server can't update the board in the middle of a test.
 */
export const test = base.extend<{ admin: AdminPage; backend: string; board: Board }>({
  admin: async ({ page, backend }, use) => {
    // Stay hermetic: the pages load web fonts and scripts from CDNs.
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === backend ? route.continue() : route.abort(),
    );
    await use(new AdminPage(page));
  },
  backend: async ({ baseURL }, use) => {
    if (!baseURL) {
      throw new Error("set E2E_BASE_URL to the server under test");
    }
    await use(new URL(baseURL).origin);
  },
  board: async ({ backend, request }, use, testInfo) => {
    const release = buildRelease();
    await publishRelease(request, release.version, release.image);
    const board = new Board(backend);
    await use(board);
    await board.attachTo(testInfo);
  },
});

export { expect };

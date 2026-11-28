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
  type Response as PlaywrightResponse,
  type TestInfo,
} from "@playwright/test";
import { tunnelTo } from "../../device/emulator/src/backend.ts";
import { Emulator } from "../../device/emulator/src/emulator.ts";
import { toPng } from "./frames.ts";

/** The firmware under test: $FIRMWARE_UF2, or device/build/ehymnboard.uf2. */
export const FIRMWARE =
  process.env.FIRMWARE_UF2 ??
  path.join(import.meta.dirname, "..", "..", "device", "build", "ehymnboard.uf2");

export const LINE_COUNT = 6;

/** A server on this machine, rather than far away (a Cloudflare preview). */
function isLocal(origin: string) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
}

/**
 * Publishes a firmware release the way a release is published (`POST
 * /firmware`): its OTA bundle, both slots' images.
 */
export async function publishRelease(
  request: APIRequestContext,
  version: string,
  bundle: Uint8Array,
) {
  const response = await request.post("/firmware", {
    multipart: {
      version,
      image: {
        name: "ehymnboard_ota_bundle.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(bundle),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/** The version and OTA bundle of the firmware under test, from its build directory. */
function buildRelease() {
  const dir = path.dirname(FIRMWARE);
  return {
    version: fs.readFileSync(path.join(dir, "firmware_version.txt"), "utf8").trim(),
    bundle: fs.readFileSync(path.join(dir, `${path.basename(FIRMWARE, ".uf2")}_ota_bundle.bin`)),
  };
}

/**
 * The admin page, found by what a person sees on it: six text boxes in
 * order, Apply and Clear buttons, a picture of the board, and a "Hymn
 * Boards" link to a table row per board. Nothing depends on how the page is
 * built.
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

  /** The Hymn Boards page, after a fresh load, reached from the board's menu. */
  async openBoards() {
    await this.open();
    await this.page.getByRole("link", { name: "Hymn Boards" }).click();
    await expect(this.page.getByRole("heading", { name: "Hymn Boards" })).toBeVisible();
  }

  /** A board's row on the Hymn Boards page, after a fresh load. */
  async #boardRow(id: string) {
    await this.openBoards();
    return this.page.getByRole("row").filter({ hasText: id });
  }

  /** One column of a board's row on the Hymn Boards page, by its heading. */
  async boardField(id: string, column: "Status" | "Last seen" | "Booted" | "Firmware") {
    const row = await this.#boardRow(id);
    await expect(row).toBeVisible();
    const headings = await this.page.getByRole("columnheader").allTextContents();
    expect(headings).toContain(column);
    // In page order, counting a row header (the board's name, say) as a column too
    return row.getByRole("rowheader").or(row.getByRole("cell")).nth(headings.indexOf(column));
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
    // A form post redirects back to the page: note the pages it loads, so
    // the next navigation doesn't cut that reload off.
    const pages: unknown[] = [];
    const onResponse = (r: PlaywrightResponse) => {
      if (r.request().isNavigationRequest() && r.request().method() === "GET") {
        pages.push(r);
      }
    };
    this.page.on("response", onResponse);
    try {
      // Whatever request saves the change: a form post or a script's fetch.
      const saved = this.page.waitForResponse((r) => r.request().method() !== "GET");
      await this.page.getByRole("button", { name: button }).click();
      const response = await saved;
      expect(response.status()).toBeLessThan(400);
      if (response.status() >= 300) {
        await expect
          .poll(() => pages.length, { message: "page reloaded after saving" })
          .toBeGreaterThan(0);
        await this.page.waitForLoadState();
      }
    } finally {
      this.page.off("response", onResponse);
    }
  }
}

/** What the board fetched and redrew over a stretch of time. */
export interface Loop {
  images: { screen: number; status: number | undefined }[];
  displays: { screen: number; frame: Uint8Array }[];
}

/**
 * A board running the firmware under test against the server at `backend`:
 * its WebSocket and image downloads go to the server's real HTTP port.
 */
export class Board {
  readonly emu: Emulator;
  #at = 0;
  #requests = 0;
  #displays = 0;
  #offline = false;

  constructor(backend: string) {
    const verbose = !!process.env.EMULATOR_VERBOSE;
    // A server far away (a Cloudflare preview) takes a few hundred ms to
    // answer, which the default hold of the board's clock doesn't cover
    const toServer = tunnelTo(backend, isLocal(backend) ? {} : { holdMs: 3_000 });
    this.emu = new Emulator({
      firmware: FIRMWARE,
      backend,
      quiet: !verbose,
      echo: verbose,
      // While offline, the network refuses the board's sockets
      tunnel: (req) => {
        const handler = toServer(req);
        return handler && this.#offline ? (socket) => socket.destroy() : handler;
      },
    });
  }

  /** The id the board reports itself as. */
  get id() {
    const id = this.emu.net.requests.find((r) => r.query.device_id)?.query.device_id;
    if (!id) {
      throw new Error("the board hasn't reported to the server yet");
    }
    return id;
  }

  /**
   * Runs until the board next redraws what the server pushed and saves it.
   * Returns what it fetched and drew since the last call (or `quiet`).
   */
  async nextUpdate(ms = 120_000): Promise<Loop> {
    this.#at = await this.emu.untilSerial("State saved to flash", ms, this.#at);
    return this.#since();
  }

  /** Runs for `ms` of simulated time; returns what the board fetched and drew meanwhile. */
  async quiet(ms = 60_000): Promise<Loop> {
    this.#since();
    await this.emu.runFor(ms);
    this.#at = this.emu.serial.length;
    return this.#since();
  }

  #since(): Loop {
    const loop = {
      images: this.emu.net.requests.slice(this.#requests).flatMap((r) => {
        const screen = /^\/images\/(\d)$/.exec(r.path)?.[1];
        return screen ? [{ screen: Number(screen), status: r.status }] : [];
      }),
      displays: this.emu.displays
        .slice(this.#displays)
        .map(({ screen, frame }) => ({ screen, frame })),
    };
    this.#requests = this.emu.net.requests.length;
    this.#displays = this.emu.displays.length;
    return loop;
  }

  /**
   * Cuts the board off from the server (its socket drops and reconnects are
   * refused), or lets it back on.
   */
  setOffline(offline: boolean) {
    this.#offline = offline;
    if (offline) {
      // Forgets every connection, as a router restart would
      this.emu.net.reset();
    }
  }

  /** Runs until the firmware prints `text`, from where the last wait stopped. */
  async untilSerial(text: string | RegExp, ms = 120_000) {
    this.#at = await this.emu.untilSerial(text, ms, this.#at);
  }

  powerCycle() {
    this.emu.powerCycle();
  }

  /** Unplugs the board for good: its connections to the server drop. */
  unplug() {
    this.emu.net.reset();
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
 * it showed are attached to the report. Before the board boots, and again
 * after the test, the server is made to offer the firmware under test, so
 * a release left over on the server can't update a board by surprise.
 */
export const test = base.extend<{ admin: AdminPage; backend: string; board: Board }>({
  // Signed in with the browser's session (see signIn.setup.ts), as the page
  // is. Its cookie is Secure, so away from this machine it's only sent over
  // https, which the browser upgrades a preview's http:// URL to itself.
  request: async ({ context, backend, playwright }, use) => {
    if (isLocal(backend)) {
      await use(context.request);
      return;
    }
    const request = await playwright.request.newContext({
      baseURL: backend.replace(/^http:/, "https:"),
      storageState: await context.storageState(),
    });
    await use(request);
    await request.dispose();
  },
  admin: async ({ page, backend }, use) => {
    // Stay hermetic: the pages load web fonts and scripts from CDNs. The
    // browser may upgrade the server to https itself (*.workers.dev is on
    // the HSTS preload list).
    const origins = new Set([backend, backend.replace(/^http:/, "https:")]);
    await page.route("**/*", (route) =>
      origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
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
    await publishRelease(request, release.version, release.bundle);
    const board = new Board(backend);
    await use(board);
    // Gone, as a board that lost power is: the next test's board is new
    board.unplug();
    await board.attachTo(testInfo);
    // Leave the server offering the build under test, not a release a test
    // published, for whatever checks in next.
    await publishRelease(request, release.version, release.bundle);
  },
});

export { expect };

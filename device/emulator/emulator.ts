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

// Puts it all together: the emulated board, the fake AP's LAN and a mock of
// the hymn board server, plus helpers for tests to drive and observe them.
import fs from "node:fs";
import { Board, type BoardEvents } from "./board.ts";
import type { AccessPoint } from "./fake-cyw43.ts";
import { type HttpRequest, type HttpResponse, VirtualNetwork } from "./virtual-net.ts";

export const SERVER_HOST = "api.hymnboard.sonrise.io";
export const IMAGE_BYTES = 81600;

const BOOTROM = new URL("./bootrom-b1.bin", import.meta.url);

function elfFor(uf2: string, pioBus: boolean | undefined) {
  const elf = uf2.replace(/\.uf2$/, ".elf");
  return !pioBus && elf !== uf2 && fs.existsSync(elf) ? fs.readFileSync(elf) : undefined;
}

/** A recognizable image for a screen: every byte is (screen * 16 + version). */
export function testImage(screen: number, version: number) {
  return new Uint8Array(IMAGE_BYTES).fill((screen * 16 + version) & 0xff);
}

/**
 * The hymn board server as the firmware sees it: /images/N with Etag/304,
 * and the two healthchecks. `override` lets a test answer a request itself.
 */
export class MockServer {
  images = new Map(
    [1, 2, 3].map((s): [number, { etag: string; body: Uint8Array }] => [
      s,
      { etag: `v1-${s}`, body: testImage(s, 1) },
    ]),
  );
  override: ((req: HttpRequest) => HttpResponse | undefined) | null = null;

  setImage(screen: number, version: number) {
    this.images.set(screen, { etag: `v${version}-${screen}`, body: testImage(screen, version) });
  }

  handle(req: HttpRequest): HttpResponse {
    const custom = this.override?.(req);
    if (custom) {
      return custom;
    }
    if (req.host !== SERVER_HOST) {
      return { status: 404 };
    }
    const match = /^\/images\/(\d+)$/.exec(req.path);
    if (match) {
      const image = this.images.get(Number(match[1]));
      if (!image) {
        return { status: 404 };
      }
      if (req.query.etag === image.etag) {
        return { status: 304 };
      }
      return { status: 200, headers: { Etag: image.etag }, body: image.body };
    }
    if (req.path === "/device_booted" || req.path === "/device_healthy") {
      return { status: 204 };
    }
    return { status: 404 };
  }
}

export interface EmulatorOptions {
  firmware: string;
  /** Defaults to one WPA2 network matching secrets.example.h. */
  aps?: AccessPoint[];
  quiet?: boolean;
  trace?: boolean;
  /** Copies the firmware's serial output to stdout. */
  echo?: boolean;
  /**
   * The firmware's .elf next to its .uf2 enables the fast WiFi bus path;
   * pioBus forces the real PIO bus driver instead.
   */
  pioBus?: boolean;
}

export type Display = BoardEvents["display"] & { atMs: number };

export class Emulator {
  readonly logLines: string[] = [];
  readonly server = new MockServer();
  readonly board: Board;
  readonly net: VirtualNetwork;
  readonly displays: Display[] = [];
  reboots = 0;

  constructor(opts: EmulatorOptions) {
    const log = (msg: string) => {
      this.logLines.push(msg);
      if (!opts.quiet) {
        console.log(msg);
      }
    };
    const stamp = () => this.board.simMs.toFixed(0).padStart(7);
    this.board = new Board({
      firmware: fs.readFileSync(opts.firmware),
      elf: elfFor(opts.firmware, opts.pioBus),
      bootrom: fs.readFileSync(BOOTROM),
      aps: opts.aps ?? [
        { ssid: "SSID_1", password: "PASSPHRASE_1", bssid: [2, 0x11, 0x22, 0x33, 0x44, 0x55] },
      ],
      trace: opts.trace,
      log: (msg) => log(`[cyw43 ${stamp()}ms] ${msg}`),
    });
    this.net = new VirtualNetwork({
      after: (ms, fn) => this.board.after(ms, fn),
      send: (frame) => this.board.chip.sendEthernet(frame),
      dns: { [SERVER_HOST]: true },
      http: (req) => this.server.handle(req),
      log: (msg) => log(`[net   ${stamp()}ms] ${msg}`),
    });
    this.board.chip.onEthernetFromHost = (frame) => this.net.receive(frame);
    this.board.chip.onLinkChange = (ap) => {
      if (!ap) {
        this.net.reset();
      }
    };
    this.board.on("display", (d) => {
      this.displays.push({ ...d, atMs: this.board.simMs });
      log(`[panel ${stamp()}ms] screen ${d.screen} refreshed (${d.frame.length} bytes)`);
    });
    this.board.on("reboot", () => {
      this.reboots++;
      log(`[board ${stamp()}ms] watchdog reset`);
    });
    if (opts.echo) {
      this.board.on("serial", (text) => process.stdout.write(text));
    }
  }

  get serial() {
    return this.board.serial;
  }

  get simMs() {
    return this.board.simMs;
  }

  /** Runs for `ms` of simulated time. */
  run(ms: number) {
    this.board.run(ms);
  }

  /**
   * Runs until the serial output (after `fromIndex`) contains `text` (a string
   * or RegExp). Returns the index just past the match; throws after `ms`.
   */
  waitForSerial(text: string | RegExp, ms: number, fromIndex = 0) {
    let found = -1;
    const search = () => {
      if (typeof text === "string") {
        const i = this.serial.indexOf(text, fromIndex);
        found = i < 0 ? -1 : i + text.length;
      } else {
        const m = new RegExp(text.source, text.flags.replace("g", "") + "g");
        m.lastIndex = fromIndex;
        const r = m.exec(this.serial);
        found = r ? r.index + r[0].length : -1;
      }
      return found >= 0;
    };
    if (!this.board.run(ms, search)) {
      const tail = this.serial.slice(-2000);
      throw new Error(
        `no ${String(text)} on serial after ${ms} ms of simulated time; last output:\n${tail}`,
      );
    }
    return found;
  }

  /** Runs until a condition holds; throws after `ms`. */
  waitFor(what: string, condition: () => boolean, ms: number) {
    if (!this.board.run(ms, condition)) {
      throw new Error(
        `timed out after ${ms} ms of simulated time waiting for ${what}; last output:\n${this.serial.slice(-2000)}`,
      );
    }
  }

  /** Drops the WiFi link, as if the AP went away. */
  dropLink() {
    this.board.chip.setLinkDown();
  }
}

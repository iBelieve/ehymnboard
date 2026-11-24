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
import path from "node:path";
import { forwardTo, isUpgrade, tunnelTo } from "./backend.ts";
import { Board, type BoardEvents } from "./board.ts";
import type { AccessPoint } from "./fake-cyw43.ts";
import { MockSocket } from "./mock-ws.ts";
import { type TestCert, TlsServer } from "./tls-server.ts";
import {
  type HttpRequest,
  type HttpResponse,
  type NetworkOptions,
  VirtualNetwork,
  type VirtualSocket,
} from "./virtual-net.ts";

export const SERVER_HOST = "hymnboard.sonrise.io";
export const IMAGE_BYTES = 81600;

const BOOTROM = new URL("./bootrom-b1.bin", import.meta.url);

/** One TLS server (and its worker thread) for every emulator in the process. */
let sharedTls: TlsServer | undefined;
/** How much simulated time runs between event-loop turns while a socket is open. */
const STREAM_SLICE_MS = 50;

/**
 * pico_fota_bootloader's UF2 from the same build: an OTA build's firmware
 * can't boot without it.
 */
function bootloaderFor(uf2: string) {
  const bootloader = path.join(
    path.dirname(uf2),
    "lib",
    "pico_fota_bootloader",
    "pico_fota_bootloader.uf2",
  );
  return fs.existsSync(bootloader) ? fs.readFileSync(bootloader) : undefined;
}

function elfFor(uf2: string, pioBus: boolean | undefined) {
  const elf = uf2.replace(/\.uf2$/, ".elf");
  return !pioBus && elf !== uf2 && fs.existsSync(elf) ? fs.readFileSync(elf) : undefined;
}

/** A recognizable image for a screen: every byte is (screen * 16 + version). */
export function testImage(screen: number, version: number) {
  return new Uint8Array(IMAGE_BYTES).fill((screen * 16 + version) & 0xff);
}

/** A firmware update the server offers: its version and encrypted OTA image. */
export interface FirmwareUpdate {
  version: string;
  image: Uint8Array;
}

/** Close code for a socket that another one from the same board replaced. */
export const CLOSE_REPLACED = 4000;

/**
 * The hymn board server as the firmware sees it: the WebSocket at /ws that
 * pushes each board's state, /images/N with Etag/304, the boot healthcheck
 * and, once `firmware` is set, an OTA update. `override` lets a test answer
 * a request itself.
 */
export class MockServer {
  images = new Map(
    [1, 2, 3].map((s): [number, { etag: string; body: Uint8Array }] => [
      s,
      { etag: `v1-${s}`, body: testImage(s, 1) },
    ]),
  );
  override: ((req: HttpRequest) => HttpResponse | undefined) | null = null;
  firmware: FirmwareUpdate | null = null;
  /** Every board WebSocket, oldest first, closed ones included. */
  readonly sockets: MockSocket[] = [];
  /** The status /ws answers upgrades with: anything but 101 refuses them. */
  upgradeStatus = 101;
  /** Answer the board's "ping" messages (off: a server that stopped answering). */
  answerPings = true;
  /** Send the state when a socket opens (off: a socket that never goes live). */
  sendStateOnOpen = true;

  setImage(screen: number, version: number) {
    this.images.set(screen, { etag: `v${version}-${screen}`, body: testImage(screen, version) });
    this.pushState();
  }

  /** Offers firmware (or none) and tells the boards at once. */
  setFirmware(firmware: FirmwareUpdate | null) {
    this.firmware = firmware;
    this.pushState();
  }

  /** The state message the server sends a board. */
  stateMessage() {
    const etags = [1, 2, 3].map((s) => this.images.get(s)?.etag ?? "-");
    return `state 1 ${etags.join(" ")} ${this.firmware?.version ?? "-"}`;
  }

  /** The open sockets. */
  get openSockets() {
    return this.sockets.filter((s) => s.open);
  }

  /** Sends the current state on every open socket. */
  pushState() {
    for (const socket of this.openSockets) {
      socket.sendText(this.stateMessage());
    }
  }

  /** The `tunnel` for a VirtualNetwork: /ws upgrades become MockSockets. */
  tunnel(req: HttpRequest) {
    if (!isUpgrade(req) || req.host !== SERVER_HOST || this.override?.(req)) {
      return undefined;
    }
    return (raw: VirtualSocket) => {
      const socket = new MockSocket(raw, {
        upgrade: (up) => (up.path !== "/ws" ? 404 : up.query.device_id ? this.upgradeStatus : 400),
        open: (opened) => this.#opened(opened),
        message: (from, text) => {
          if (text === "ping" && this.answerPings) {
            from.sendText("pong");
          }
        },
      });
      this.sockets.push(socket);
    };
  }

  #opened(socket: MockSocket) {
    const board = socket.request?.query.device_id;
    for (const other of this.openSockets) {
      if (other !== socket && other.request?.query.device_id === board) {
        other.close(CLOSE_REPLACED, "replaced");
      }
    }
    if (this.sendStateOnOpen) {
      socket.sendText(this.stateMessage());
    }
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
    if (req.path === "/device_booted") {
      return { status: 204 };
    }
    if (req.path.startsWith("/firmware/")) {
      return this.handleFirmware(req);
    }
    return { status: 404 };
  }

  /** Like the real server: every board not on `firmware.version` installs it. */
  handleFirmware(req: HttpRequest): HttpResponse {
    const firmware = this.firmware;
    if (req.path === "/firmware/latest") {
      if (!firmware || req.query.version === firmware.version) {
        return { status: 204 };
      }
      return { status: 200, headers: { "Content-Type": "text/plain" }, body: firmware.version };
    }
    if (req.path === "/firmware/image") {
      if (!firmware) {
        return { status: 404 };
      }
      if (req.query.target_version !== firmware.version) {
        return { status: 409 };
      }
      return {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
        body: firmware.image,
      };
    }
    return { status: 404 };
  }
}

export interface EmulatorOptions {
  firmware: string;
  /**
   * A real server to send the board's requests to (`http://host:port`)
   * instead of the mock `server`. Drive the board with the async methods
   * (`runFor`, `untilSerial`, `until`): they stop the simulated clock while
   * the server answers.
   */
  backend?: string;
  /**
   * Hands long-lived connections (WebSocket upgrades) to something other
   * than `backend` or the mock server's /ws, such as the Autobahn suite.
   * Use the async run methods if it talks to a real server.
   */
  tunnel?: NetworkOptions["tunnel"];
  /** Host names the LAN resolves, besides the hymn board server. */
  hosts?: string[];
  /**
   * The certificate the router's TLS server shows on port 443, whatever name
   * the board asks for (default: the right one for the name). The firmware
   * must be built with -DEHYMNBOARD_TEST_ROOT_CA=ON to trust any of them.
   */
  tlsCert?: TestCert;
  /**
   * pico_fota_bootloader's UF2, flashed first. Defaults to the one in the
   * firmware's build directory, if there is one.
   */
  bootloader?: string;
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
  readonly #quiet: boolean;

  constructor(opts: EmulatorOptions) {
    this.#quiet = !!opts.quiet;
    const log = (msg: string) => this.#log(msg);
    const stamp = () => this.#stamp();
    this.board = new Board({
      firmware: fs.readFileSync(opts.firmware),
      bootloader: opts.bootloader ? fs.readFileSync(opts.bootloader) : bootloaderFor(opts.firmware),
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
      dns: Object.fromEntries([SERVER_HOST, ...(opts.hosts ?? [])].map((h) => [h, true])),
      http: opts.backend ? forwardTo(opts.backend) : (req) => this.server.handle(req),
      tunnel:
        opts.tunnel ?? (opts.backend ? tunnelTo(opts.backend) : (req) => this.server.tunnel(req)),
      tls: (sharedTls ??= new TlsServer()),
      log: (msg) => log(`[net   ${stamp()}ms] ${msg}`),
    });
    this.net.tlsCert = opts.tlsCert;
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

  #log(msg: string) {
    this.logLines.push(msg);
    if (!this.#quiet) {
      console.log(msg);
    }
  }

  #stamp() {
    return this.board.simMs.toFixed(0).padStart(7);
  }

  get serial() {
    return this.board.serial;
  }

  get simMs() {
    return this.board.simMs;
  }

  /** Runs for `ms` of simulated time. */
  run(ms: number) {
    this.#runSync(ms, () => false);
  }

  /**
   * Runs until the serial output (after `fromIndex`) contains `text` (a string
   * or RegExp). Returns the index just past the match; throws after `ms`.
   */
  waitForSerial(text: string | RegExp, ms: number, fromIndex = 0) {
    const { search, found } = this.#serialSearch(text, fromIndex);
    if (!this.#runSync(ms, search)) {
      throw this.#serialTimeout(text, ms);
    }
    return found();
  }

  /** Runs until a condition holds; throws after `ms`. */
  waitFor(what: string, condition: () => boolean, ms: number) {
    if (!this.#runSync(ms, condition)) {
      throw this.#timeout(what, ms);
    }
  }

  /** `run` for a `backend`: the clock stops while the server answers. */
  async runFor(ms: number) {
    await this.#runAsync(ms, () => false);
  }

  /** `waitForSerial` for a `backend`. */
  async untilSerial(text: string | RegExp, ms: number, fromIndex = 0) {
    const { search, found } = this.#serialSearch(text, fromIndex);
    if (!(await this.#runAsync(ms, search))) {
      throw this.#serialTimeout(text, ms);
    }
    return found();
  }

  /** `waitFor` for a `backend`. */
  async until(what: string, condition: () => boolean, ms: number) {
    if (!(await this.#runAsync(ms, condition))) {
      throw this.#timeout(what, ms);
    }
  }

  #runSync(ms: number, stop: () => boolean) {
    const done = this.board.run(ms, () => this.net.pending > 0 || stop());
    if (this.net.pending > 0) {
      throw new Error("a request is waiting for the backend: use the async run methods");
    }
    return done;
  }

  /**
   * Runs for up to `ms` of simulated time until `stop()`, pausing the clock
   * whenever a request is waiting for the backend, so a slow server never
   * looks slow to the firmware. While a long-lived connection is open it
   * runs in short slices, letting the event loop deliver what the server
   * sends meanwhile.
   */
  async #runAsync(ms: number, stop: () => boolean) {
    const end = this.simMs + ms;
    for (;;) {
      await this.net.settled();
      if (stop()) {
        return true;
      }
      const left = end - this.simMs;
      if (left <= 0) {
        return stop();
      }
      const slice = this.net.tunnels > 0 ? Math.min(left, STREAM_SLICE_MS) : left;
      this.board.run(slice, () => this.net.pending > 0 || stop());
      if (this.net.pending === 0 && this.net.tunnels === 0 && slice === left) {
        return stop();
      }
      if (this.net.pending === 0) {
        // Let socket events in
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  #serialSearch(text: string | RegExp, fromIndex: number) {
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
    return { search, found: () => found };
  }

  #serialTimeout(text: string | RegExp, ms: number) {
    return new Error(
      `no ${String(text)} on serial after ${ms} ms of simulated time; last output:\n${this.serial.slice(-2000)}`,
    );
  }

  #timeout(what: string, ms: number) {
    return new Error(
      `timed out after ${ms} ms of simulated time waiting for ${what}; last output:\n${this.serial.slice(-2000)}`,
    );
  }

  /** Unplugs the board and plugs it back in. */
  powerCycle() {
    this.#log(`[board ${this.#stamp()}ms] power cycle`);
    this.board.powerCycle();
  }

  /** Drops the WiFi link, as if the AP went away. */
  dropLink() {
    this.board.chip.setLinkDown();
  }
}

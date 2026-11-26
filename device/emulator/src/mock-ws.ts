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

// The server end of a WebSocket (RFC 6455) over a tunnelled VirtualSocket,
// just enough for the mock server: the upgrade, text messages, ping/pong and
// the closing handshake. The firmware's client is checked against the real
// thing (the Autobahn suite); this only has to be correct for well-behaved
// clients, and strict enough to notice a client that isn't.
import { createHash } from "node:crypto";
import type { VirtualSocket } from "./virtual-net.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function acceptFor(key: string) {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

/** An unmasked server frame. */
function serverFrame(opcode: number, payload: Uint8Array, fin = true) {
  const n = payload.length;
  const head = n < 126 ? 2 : n < 0x10000 ? 4 : 10;
  const out = new Uint8Array(head + n);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (n < 126) {
    out[1] = n;
  } else if (n < 0x10000) {
    out[1] = 126;
    out[2] = n >> 8;
    out[3] = n & 0xff;
  } else {
    out[1] = 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(n));
  }
  out.set(payload, head);
  return out;
}

function closePayload(code: number, reason = "") {
  const text = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + text.length);
  out[0] = code >> 8;
  out[1] = code & 0xff;
  out.set(text, 2);
  return out;
}

export interface UpgradeRequest {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface MockSocketHandlers {
  /** Decides the upgrade: a status other than 101 refuses it. */
  upgrade: (req: UpgradeRequest) => number;
  open?: (socket: MockSocket) => void;
  message?: (socket: MockSocket, text: string) => void;
  closed?: (socket: MockSocket) => void;
}

/** One board's WebSocket, as the mock server sees it. */
export class MockSocket {
  request: UpgradeRequest | null = null;
  /** Every text message the board sent. */
  readonly received: string[] = [];
  /** The close code the board sent, if it sent one. */
  closeCode: number | undefined;
  /** Answer pings with pongs (off: a stalled server). */
  answerPings = true;
  open = false;
  readonly #socket: VirtualSocket;
  readonly #handlers: MockSocketHandlers;
  #buffer = new Uint8Array(0);
  #head = "";
  #closeSent = false;
  #fragments: Uint8Array[] = [];

  constructor(socket: VirtualSocket, handlers: MockSocketHandlers) {
    this.#socket = socket;
    this.#handlers = handlers;
    socket.onData = (data) => this.#receive(data);
    socket.onEnd = () => this.#socket.end();
    socket.onClose = () => this.#gone();
  }

  get closed() {
    return this.#socket.closed;
  }

  sendText(text: string) {
    this.#send(OP_TEXT, new TextEncoder().encode(text));
  }

  /** Starts the closing handshake. */
  close(code: number, reason = "") {
    if (!this.#closeSent && this.open) {
      this.#closeSent = true;
      this.#send(OP_CLOSE, closePayload(code, reason));
    }
  }

  /** Drops the TCP connection with a reset, as a crashed server would. */
  drop() {
    this.#socket.destroy();
  }

  #send(opcode: number, payload: Uint8Array) {
    if (this.open && !this.#socket.closed) {
      this.#socket.write(serverFrame(opcode, payload));
    }
  }

  #receive(data: Uint8Array) {
    const all = new Uint8Array(this.#buffer.length + data.length);
    all.set(this.#buffer);
    all.set(data, this.#buffer.length);
    this.#buffer = all;
    if (!this.request && !this.#upgrade()) {
      return;
    }
    while (this.open && this.#frame()) {
      // one frame at a time
    }
  }

  /** Answers the upgrade once its head is in. False until then, or if refused. */
  #upgrade() {
    this.#head += String.fromCharCode(...this.#buffer);
    this.#buffer = new Uint8Array(0);
    const end = this.#head.indexOf("\r\n\r\n");
    if (end < 0) {
      return false;
    }
    const [requestLine, ...lines] = this.#head.slice(0, end).split("\r\n");
    const rest = this.#head.slice(end + 4);
    const target = requestLine.split(" ")[1] ?? "";
    const [path, qs = ""] = target.split("?");
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    this.request = { path, query: Object.fromEntries(new URLSearchParams(qs)), headers };

    const key = headers["sec-websocket-key"];
    const wellFormed =
      headers.upgrade?.toLowerCase() === "websocket" &&
      /\bupgrade\b/i.test(headers.connection ?? "") &&
      headers["sec-websocket-version"] === "13" &&
      key !== undefined;
    const status = wellFormed ? this.#handlers.upgrade(this.request) : 400;
    if (status !== 101) {
      this.#socket.write(
        new TextEncoder().encode(
          `HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        ),
      );
      this.#socket.end();
      return false;
    }
    this.#socket.write(
      new TextEncoder().encode(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
      ),
    );
    this.open = true;
    this.#buffer = Uint8Array.from(rest, (ch) => ch.charCodeAt(0));
    this.#handlers.open?.(this);
    return true;
  }

  /** Takes one whole frame off the buffer, if there is one. */
  #frame() {
    const b = this.#buffer;
    if (b.length < 2) {
      return false;
    }
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    if ((b[1] & 0x80) === 0) {
      throw new Error("the board sent an unmasked frame");
    }
    let length = b[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) {
        return false;
      }
      length = (b[2] << 8) | b[3];
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) {
        return false;
      }
      length = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(2));
      offset = 10;
    }
    if (b.length < offset + 4 + length) {
      return false;
    }
    const mask = b.subarray(offset, offset + 4);
    const payload = b.slice(offset + 4, offset + 4 + length);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i & 3];
    }
    this.#buffer = b.subarray(offset + 4 + length);
    this.#handle(opcode, fin, payload);
    return true;
  }

  #handle(opcode: number, fin: boolean, payload: Uint8Array) {
    if (opcode === OP_PING) {
      if (this.answerPings) {
        this.#send(OP_PONG, payload);
      }
      return;
    }
    if (opcode === OP_PONG) {
      return;
    }
    if (opcode === OP_CLOSE) {
      this.closeCode = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
      if (!this.#closeSent) {
        this.#closeSent = true;
        this.#send(OP_CLOSE, payload.subarray(0, 2));
      }
      this.open = false;
      // The server closes the TCP connection first (RFC 6455 section 7.1.1)
      this.#socket.end();
      return;
    }
    this.#fragments.push(payload);
    if (!fin) {
      return;
    }
    const whole = Buffer.concat(this.#fragments);
    this.#fragments = [];
    const text = new TextDecoder("utf-8", { fatal: true }).decode(whole);
    this.received.push(text);
    this.#handlers.message?.(this, text);
  }

  #gone() {
    this.open = false;
    this.#handlers.closed?.(this);
  }
}

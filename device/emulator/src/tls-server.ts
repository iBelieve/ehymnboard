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

// The router's TLS server, as Cloudflare's edge is to a real board: it ends
// the board's TLS on port 443 and hands the plain HTTP (and WebSocket) bytes
// on. It's Node's own TLS, so the firmware's mbedTLS meets OpenSSL, as it
// would Cloudflare's servers. Node's TLS is asynchronous and the emulator's
// network isn't, so OpenSSL runs in a worker thread and each call here waits
// for it (Atomics.wait), which keeps the simulated clock out of it.
//
// The certificates come from device/certs/test (make-test-certs.sh): firmware
// built with -DEHYMNBOARD_TEST_ROOT_CA=ON trusts their root.
import fs from "node:fs";
import path from "node:path";
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";

const CERTS = path.join(import.meta.dirname, "..", "..", "certs", "test");

/**
 * A test certificate: `server` (ECDSA, like Cloudflare's), `server-rsa`
 * (RSA, like Let's Encrypt's), `wrong-host` (a valid chain for another name),
 * `untrusted` (the right name, from a CA the firmware doesn't trust) or
 * `autobahn` (for autobahn.test).
 */
export type TestCert = "server" | "server-rsa" | "wrong-host" | "untrusted" | "autobahn";

const KEYS: Record<TestCert, string> = {
  server: "server.key",
  "server-rsa": "server-rsa.key",
  "wrong-host": "server.key",
  untrusted: "server.key",
  autobahn: "server.key",
};

/** The certificate the server shows for each name the board asks for (SNI). */
const BY_SNI: Record<string, TestCert> = { "autobahn.test": "autobahn" };

export interface TlsWorkerData {
  port: MessagePort;
  signal: SharedArrayBuffer;
  certs: Record<string, { cert: string; key: string }>;
}

export type TlsRequest =
  | { op: "open"; id: number; cert?: TestCert; bySni?: Record<string, TestCert> }
  | { op: "receive" | "send"; id: number; data: Uint8Array }
  | { op: "end" | "close"; id: number };

export interface TlsReply {
  id: number;
  /** Bytes for the board */
  out: Uint8Array;
  /** What the board sent, decrypted */
  plain: Uint8Array;
  /** The server finished its side (close_notify sent) */
  ended: boolean;
  /** Why the handshake or connection failed */
  error?: string;
  /** The name the board asked for (SNI) */
  servername?: string;
  /** Whether the board resumed an earlier session */
  resumed?: boolean;
  cipher?: string;
}

function loadCerts() {
  const certs: TlsWorkerData["certs"] = {};
  for (const [name, key] of Object.entries(KEYS)) {
    certs[name] = {
      cert: fs.readFileSync(path.join(CERTS, `${name}.pem`), "utf8"),
      key: fs.readFileSync(path.join(CERTS, key), "utf8"),
    };
  }
  return certs;
}

/** One TLS connection's server end. */
export interface TlsSession {
  /** Bytes from the board: what to send back, and what they decrypt to. */
  receive(data: Uint8Array): TlsReply;
  /** Encrypts bytes for the board. */
  send(data: Uint8Array): TlsReply;
  /** Sends close_notify. */
  end(): TlsReply;
  /** Forgets the connection. */
  close(): void;
}

export class TlsServer {
  readonly #worker: Worker;
  readonly #port: MessagePort;
  readonly #signal = new Int32Array(new SharedArrayBuffer(4));
  #nextId = 1;

  constructor() {
    const channel = new MessageChannel();
    const data: TlsWorkerData = {
      port: channel.port2,
      signal: this.#signal.buffer,
      certs: loadCerts(),
    };
    this.#worker = new Worker(new URL("./tls-worker.ts", import.meta.url), {
      workerData: data,
      transferList: [channel.port2],
    });
    // Never what keeps a test run alive
    this.#worker.unref();
    this.#port = channel.port1;
  }

  /** A new connection, showing `cert` whatever name the board asks for, if given. */
  open(cert?: TestCert): TlsSession {
    const id = this.#nextId++;
    this.#call({ op: "open", id, cert, bySni: BY_SNI });
    return {
      receive: (data) => this.#call({ op: "receive", id, data }),
      send: (data) => this.#call({ op: "send", id, data }),
      end: () => this.#call({ op: "end", id }),
      close: () => {
        this.#call({ op: "close", id });
      },
    };
  }

  /** Stops the worker. */
  async stop() {
    await this.#worker.terminate();
  }

  #call(req: TlsRequest): TlsReply {
    Atomics.store(this.#signal, 0, 0);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin
    this.#port.postMessage(req);
    // OpenSSL answers in well under a second; a minute means the worker died
    if (Atomics.wait(this.#signal, 0, 0, 60_000) === "timed-out") {
      throw new Error("the TLS worker didn't answer");
    }
    const message = receiveMessageOnPort(this.#port);
    if (!message) {
      throw new Error("the TLS worker answered nothing");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tls-worker.ts only sends TlsReply
    return message.message as TlsReply;
  }
}

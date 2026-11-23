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

// The TLS server's worker thread (see tls-server.ts): Node's own TLS (OpenSSL)
// runs here, on its event loop, while the emulator's thread waits for each
// answer, so the simulated clock never sees it run.
import { Duplex } from "node:stream";
import tls from "node:tls";
import { workerData } from "node:worker_threads";
import type { TlsReply, TlsRequest, TlsWorkerData } from "./tls-server.ts";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what tls-server.ts passes
const { port, signal, certs } = workerData as TlsWorkerData;
const flag = new Int32Array(signal);

const contexts = new Map(
  Object.entries(certs).map(([name, pem]) => [name, tls.createSecureContext(pem)]),
);

function context(name: string) {
  const found = contexts.get(name);
  if (!found) {
    throw new Error(`no test certificate ${name}`);
  }
  return found;
}

/** What a connection has done since the last look. */
interface Activity {
  out: Buffer[];
  plain: Buffer[];
  ended: boolean;
  error: string | undefined;
  /** Whether anything happened since the last look, for `settle` */
  busy: boolean;
}

/** One connection: the board's side is `raw`, the server's is `socket`. */
type Session = Activity & { raw: Duplex; socket: tls.TLSSocket };

const sessions = new Map<number, Session>();

function open(id: number, cert: string | undefined, bySni: Record<string, string>) {
  const activity: Activity = { out: [], plain: [], ended: false, error: undefined, busy: false };
  const raw = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      activity.out.push(chunk);
      activity.busy = true;
      done();
    },
    final(done) {
      activity.ended = true;
      activity.busy = true;
      done();
    },
  });
  const socket = new tls.TLSSocket(raw, {
    isServer: true,
    secureContext: context(cert ?? "server"),
    // A fixed certificate (cert) overrides the name the board asks for
    SNICallback: (name, done) => {
      done(null, context(cert ?? bySni[name] ?? "server"));
    },
  });
  const session: Session = Object.assign(activity, { raw, socket });
  session.socket.on("data", (data: Buffer) => {
    session.plain.push(data);
    session.busy = true;
  });
  session.socket.on("error", (e: Error) => {
    session.error ??= e.message;
    session.busy = true;
  });
  session.socket.on("end", () => {
    session.socket.end();
  });
  sessions.set(id, session);
}

/** Waits until OpenSSL has done all it will with what it was given. */
async function settle(session: Session) {
  let quiet = 0;
  for (let i = 0; i < 200 && quiet < 3; i++) {
    session.busy = false;
    await new Promise((resolve) => setImmediate(resolve));
    quiet = session.busy ? 0 : quiet + 1;
  }
}

function reply(id: number, session: Session | undefined): TlsReply {
  if (!session) {
    return { id, out: new Uint8Array(0), plain: new Uint8Array(0), ended: true };
  }
  const out = Buffer.concat(session.out);
  const plain = Buffer.concat(session.plain);
  session.out = [];
  session.plain = [];
  const socket = session.socket;
  return {
    id,
    out: new Uint8Array(out),
    plain: new Uint8Array(plain),
    ended: session.ended,
    error: session.error,
    servername: typeof socket.servername === "string" ? socket.servername : undefined,
    resumed: socket.isSessionReused(),
    cipher: socket.getCipher()?.name,
  };
}

async function handle(req: TlsRequest): Promise<TlsReply> {
  if (req.op === "open") {
    open(req.id, req.cert, req.bySni ?? {});
    return reply(req.id, sessions.get(req.id));
  }
  const session = sessions.get(req.id);
  if (!session) {
    return reply(req.id, undefined);
  }
  if (req.op === "receive") {
    session.raw.push(Buffer.from(req.data));
  } else if (req.op === "send") {
    session.socket.write(Buffer.from(req.data));
  } else if (req.op === "end") {
    session.socket.end();
  } else {
    session.socket.destroy();
    session.raw.destroy();
    sessions.delete(req.id);
    return reply(req.id, undefined);
  }
  await settle(session);
  return reply(req.id, session);
}

/** Answers a request, then wakes the emulator's thread waiting for it. */
async function answer(req: TlsRequest) {
  let result: TlsReply;
  try {
    result = await handle(req);
  } catch (e) {
    result = {
      id: req.id,
      out: new Uint8Array(0),
      plain: new Uint8Array(0),
      ended: true,
      error: String(e),
    };
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin
  port.postMessage(result);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

port.on("message", (req: TlsRequest) => {
  void answer(req);
});

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

// The board's requests forwarded to a real HTTP server (here a node:http
// one standing in for the hymn board server), as the full-stack e2e tests do.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { type Emulator, IMAGE_BYTES, SERVER_HOST, testImage } from "../src/emulator.ts";
import { tunnelTo } from "../src/backend.ts";
import { MockSocket } from "../src/mock-ws.ts";
import type { VirtualSocket } from "../src/virtual-net.ts";
import { boot } from "./helpers.ts";

/** Upgraded sockets, which outlive server.close() and would keep the tests running. */
const upgraded = new Set<net.Socket>();

/** Closes a test server and every connection to it. */
function shutDown(server: http.Server) {
  for (const socket of upgraded) {
    socket.destroy();
  }
  upgraded.clear();
  server.closeAllConnections();
  server.close();
}

/** A real TCP socket as the VirtualSocket a MockSocket drives. */
function adapt(socket: net.Socket): VirtualSocket {
  const adapted: VirtualSocket = {
    write: (data) => void socket.write(data),
    end: () => void socket.end(),
    destroy: () => void socket.destroy(),
    onData: null,
    onEnd: null,
    onClose: null,
    holdMs: 0,
    get closed() {
      return socket.destroyed;
    },
  };
  socket.on("data", (data: Buffer) => adapted.onData?.(new Uint8Array(data)));
  socket.on("end", () => adapted.onEnd?.());
  socket.on("close", () => adapted.onClose?.());
  socket.on("error", () => undefined);
  return adapted;
}

/**
 * Serves the board's WebSocket on `server`: sends `state()` when it opens
 * and answers pings. Returns the open sockets, to push more states.
 */
function acceptSockets(server: http.Server, state: () => string, hosts?: Set<string | undefined>) {
  const sockets: MockSocket[] = [];
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    upgraded.add(socket);
    hosts?.add(req.headers.host);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    const raw = adapt(socket);
    const mock = new MockSocket(raw, {
      upgrade: () => 101,
      open: (opened) => opened.sendText(state()),
      message: (from, text) => text === "ping" && from.sendText("pong"),
    });
    sockets.push(mock);
    raw.onData?.(new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`));
  });
  return sockets;
}

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("the test server has no port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

/**
 * Pushes a state that names a new image for screen 1 the server doesn't
 * have yet: the board asks with its ETag, gets a 304 and redraws nothing.
 */
async function assertPushedStateGets304(emu: Emulator, sockets: MockSocket[], others: string) {
  const at = emu.serial.length;
  sockets.at(-1)?.sendText(`state 1 newer-1 ${others} -`);
  await emu.untilSerial("No change for screen 1", 10_000, at);
  const images = emu.net.requests.filter((r) => r.path.startsWith("/images/"));
  assert.deepEqual(
    images.map((r) => [r.path, r.status]),
    [
      ["/images/1", 200],
      ["/images/2", 200],
      ["/images/3", 200],
      ["/images/1", 304],
    ],
  );
  assert.equal(emu.displays.length, 3);
}

test("forwards requests to a real server and shows what it sends back", async () => {
  const hosts = new Set<string | undefined>();
  const { server, url } = await serve((req, res) => {
    hosts.add(req.headers.host);
    const screen = /^\/images\/(\d)\?/.exec(req.url ?? "")?.[1];
    if (!screen) {
      res.writeHead(204).end();
      return;
    }
    const etag = `real-${screen}`;
    if (new URL(req.url ?? "", url).searchParams.get("etag") === etag) {
      res.writeHead(304).end();
      return;
    }
    // A slow server: the board's clock stops while it waits.
    const body = testImage(Number(screen), 7);
    setTimeout(
      () => res.writeHead(200, { Etag: etag, "Content-Length": body.length }).end(body),
      50,
    );
  });
  try {
    const sockets = acceptSockets(server, () => "state 1 real-1 real-2 real-3 -", hosts);
    const emu = boot({ backend: url });
    await emu.untilSerial(
      "State saved to flash",
      60_000,
      await emu.untilSerial("WS: live", 30_000),
    );
    assert.deepEqual(
      emu.displays.map((d) => d.screen),
      [1, 2, 3],
    );
    for (const d of emu.displays) {
      assert.equal(d.frame.length, IMAGE_BYTES);
      assert.deepEqual(d.frame, testImage(d.screen, 7));
    }
    await emu.until(
      "the shown message",
      () => sockets[0]?.received.includes("shown real-1 real-2 real-3") ?? false,
      1_000,
    );
    await assertPushedStateGets304(emu, sockets, "real-2 real-3");
    // A minute of pings over the real socket keeps it up
    await emu.runFor(60_000);
    assert.equal(sockets.filter((s) => s.open).length, 1);
    assert.ok(sockets[0].received.filter((m) => m === "ping").length >= 2);
    assert.deepEqual([...hosts], [SERVER_HOST], "the Host header is passed on unchanged");
  } finally {
    shutDown(server);
  }
});

test("passes the server's framing through: lwIP's client doesn't decode chunked bodies", async () => {
  // Without a Content-Length, node:http sends the image chunked. The board
  // gets the chunk sizes in its image, so a server must not stream images.
  const { server, url } = await serve((req, res) => {
    if (!req.url?.startsWith("/images/")) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { Etag: "chunked" }).end(testImage(1, 1));
  });
  acceptSockets(server, () => "state 1 chunked chunked chunked -");
  try {
    const emu = boot({ backend: url });
    await emu.untilSerial(`Image is the wrong size: ${IMAGE_BYTES + 14} bytes received`, 30_000);
    assert.equal(emu.displays.length, 0);
  } finally {
    shutDown(server);
  }
});

test("frames answers by Content-Length and status when the server keeps the connection open", async () => {
  const body = testImage(1, 3);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("data", (data) => {
      const request = String(data);
      let head = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
      if (request.includes("etag=kept-open")) {
        // A 304 may carry the entity's Content-Length but has no body.
        head = `HTTP/1.1 304 Not Modified\r\nEtag: kept-open\r\nContent-Length: ${body.length}\r\n\r\n`;
      } else if (request.startsWith("GET /images/")) {
        head = `HTTP/1.1 200 OK\r\nEtag: kept-open\r\nContent-Length: ${body.length}\r\n\r\n`;
        socket.write(head);
        socket.write(body);
        return;
      }
      socket.write(head);
      // ...and never closes, ignoring Connection: Close.
    });
  });
  // The socket comes from a separate http server: this one is raw TCP
  const ws = await serve((_req, res) => res.writeHead(404).end());
  const boardSockets = acceptSockets(ws.server, () => "state 1 kept-open kept-open kept-open -");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const emu = boot({ backend: `http://127.0.0.1:${address.port}`, tunnel: tunnelTo(ws.url) });
    await emu.untilSerial(
      "State saved to flash",
      60_000,
      await emu.untilSerial("WS: live", 30_000),
    );
    assert.deepEqual(emu.displays[0].frame, body);
    await assertPushedStateGets304(emu, boardSockets, "kept-open kept-open");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    shutDown(ws.server);
  }
});

test("a server that refuses the connection looks like a reset to the board", async () => {
  const { server, url } = await serve(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  const emu = boot({ backend: url });
  await emu.untilSerial("WS: socket closed, retrying in", 30_000);
  assert.equal(emu.displays.length, 0);
});

test("the synchronous run methods refuse to wait for a real server", async () => {
  const { server, url } = await serve((_req, res) => {
    res.writeHead(204).end();
  });
  try {
    const emu = boot({ backend: url });
    assert.throws(() => emu.waitForSerial("never printed", 30_000), /use the async run methods/);
    await emu.net.settled();
  } finally {
    shutDown(server);
  }
});

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
import { test } from "node:test";
import { IMAGE_BYTES, SERVER_HOST, testImage } from "../src/emulator.ts";
import { boot } from "./helpers.ts";

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("the test server has no port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
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
    const emu = boot({ backend: url });
    const at = await emu.untilSerial("State saved to flash", 30_000);
    assert.deepEqual(
      emu.displays.map((d) => d.screen),
      [1, 2, 3],
    );
    for (const d of emu.displays) {
      assert.equal(d.frame.length, IMAGE_BYTES);
      assert.deepEqual(d.frame, testImage(d.screen, 7));
    }
    // The second loop sends the ETags back and gets 304s.
    const asleep = await emu.untilSerial("Sleeping for 15 seconds", 30_000, at);
    await emu.untilSerial("Sleeping for 15 seconds", 30_000, asleep);
    const images = emu.net.requests.filter((r) => r.path.startsWith("/images/"));
    assert.deepEqual(
      images.map((r) => r.status),
      [200, 200, 200, 304, 304, 304],
    );
    assert.deepEqual([...hosts], [SERVER_HOST], "the Host header is passed on unchanged");
  } finally {
    server.close();
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
  try {
    const emu = boot({ backend: url });
    await emu.untilSerial(`Image is the wrong size: ${IMAGE_BYTES + 14} bytes received`, 30_000);
    assert.equal(emu.displays.length, 0);
  } finally {
    server.close();
  }
});

test("a server that refuses the connection looks like a reset to the board", async () => {
  const { server, url } = await serve(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  const emu = boot({ backend: url });
  await emu.untilSerial(/Fetch image HTTP request completed with result: [1-9]/, 30_000);
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
    server.close();
  }
});

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

// Sends the board's HTTP requests on to a real hymn board server (Flask in
// server/, or its replacement) over a real TCP connection, and hands the
// answer back byte for byte, so the firmware parses exactly what that
// server sends: its status line, header casing, framing and body.
import net from "node:net";
import type { HttpRequest, HttpResponse } from "./virtual-net.ts";

/** How long, in real time, a server gets to answer before the board sees a reset. */
const ANSWER_TIMEOUT_MS = 30_000;

/**
 * Forwards each request, unchanged (Host header and all), to the server at
 * `baseUrl` (http only). The firmware only sends GETs and asks for
 * `Connection: Close`, so the answer is everything the server sends before
 * it closes, or up to its Content-Length if it keeps the connection open.
 */
export function forwardTo(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:") {
    throw new Error(`${baseUrl}: the board only speaks plain HTTP`);
  }
  const host = url.hostname;
  const port = Number(url.port || 80);
  return (req: HttpRequest) => exchange(host, port, req.raw);
}

/** The length of a complete response in `bytes`, once its head and Content-Length body are in. */
function completeLength(bytes: Buffer) {
  const headEnd = bytes.indexOf("\r\n\r\n");
  if (headEnd < 0) {
    return undefined;
  }
  const head = bytes.subarray(0, headEnd).toString("latin1");
  const length = /^content-length:\s*(\d+)\s*$/im.exec(head)?.[1];
  const total = length === undefined ? undefined : headEnd + 4 + Number(length);
  return total !== undefined && bytes.length >= total ? total : undefined;
}

function exchange(host: string, port: number, request: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const done = (bytes: Buffer) => {
      resolve({ raw: new Uint8Array(bytes) });
      socket.destroy();
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(ANSWER_TIMEOUT_MS, () => {
      socket.destroy(new Error(`no answer from ${host}:${port} in ${ANSWER_TIMEOUT_MS} ms`));
    });
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const length = completeLength(received);
      if (length !== undefined) {
        done(received.subarray(0, length));
      }
    });
    socket.on("error", reject);
    socket.on("close", (hadError) => {
      if (!hadError) {
        done(received);
      }
    });
  });
}

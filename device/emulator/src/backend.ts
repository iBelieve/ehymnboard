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

// Sends the board's HTTP requests on to a real hymn board server (web/, or
// any replacement) over a real TCP connection, and hands the
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

/**
 * Where a response ends, from its head: right after the head for a status
 * with no body (1xx, 204, 304, whatever Content-Length says), after
 * Content-Length bytes otherwise, or unknown (read until the server closes).
 */
function responseLength(head: string) {
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
  if ((status >= 100 && status < 200) || status === 204 || status === 304) {
    return 0;
  }
  const length = /^content-length:\s*(\d+)\s*$/im.exec(head)?.[1];
  return length === undefined ? undefined : Number(length);
}

function exchange(host: string, port: number, request: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    // Once the head is in: how many bytes the whole response is, if known.
    let total: number | undefined;
    let headSeen = false;
    const done = () => {
      const all = Buffer.concat(chunks, received);
      resolve({ raw: new Uint8Array(total === undefined ? all : all.subarray(0, total)) });
      socket.destroy();
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(ANSWER_TIMEOUT_MS, () => {
      socket.destroy(new Error(`no answer from ${host}:${port} in ${ANSWER_TIMEOUT_MS} ms`));
    });
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (!headSeen) {
        const sofar = Buffer.concat(chunks, received);
        const headEnd = sofar.indexOf("\r\n\r\n");
        if (headEnd < 0) {
          return;
        }
        headSeen = true;
        const body = responseLength(sofar.subarray(0, headEnd).toString("latin1"));
        total = body === undefined ? undefined : headEnd + 4 + body;
      }
      if (total !== undefined && received >= total) {
        done();
      }
    });
    socket.on("error", reject);
    socket.on("close", (hadError) => {
      if (!hadError) {
        done();
      }
    });
  });
}

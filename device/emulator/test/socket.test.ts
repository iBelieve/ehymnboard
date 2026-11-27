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

// The board's WebSocket to the server: how it keeps it up, notices when it's
// dead, backs off, and catches up on what changed while it was down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_REPLACED, type Emulator, testImage } from "../src/emulator.ts";
import { boot, count, waitForFirstImages } from "./helpers.ts";

/** Boots and waits until the first images are on the panels and the server knows. */
function bootLive() {
  const emu = boot();
  const at = waitForFirstImages(emu);
  emu.waitFor(
    "the shown message",
    () => emu.server.sockets[0]?.received.some((m) => m.startsWith("shown ")) ?? false,
    1_000,
  );
  return { emu, at };
}

/** The delays the board said it would wait before each reconnect. */
function retryDelays(emu: Emulator, from = 0) {
  return [...emu.serial.slice(from).matchAll(/WS: (?:socket closed, )?retrying in (\d+)ms/g)].map(
    (m) => Number(m[1]),
  );
}

test("reconnects after the server closes the socket, and catches up on what changed", () => {
  const { emu, at } = bootLive();
  const [first] = emu.server.sockets;

  // A restart (1012) while the lines change: the board only hears about the
  // new image once it's back.
  first.close(1012, "restarting");
  emu.waitFor("the socket to close", () => first.closed, 2_000);
  assert.equal(first.closeCode, 1012, "the board echoes the close code");
  emu.server.upgradeStatus = 503;
  emu.server.setImage(3, 2);
  emu.waitFor("two refused attempts", () => emu.server.sockets.length >= 3, 30_000);
  assert.equal(emu.displays.length, 3, "nothing to redraw while down");

  emu.server.upgradeStatus = 101;
  const back = emu.serial.length;
  emu.waitForSerial(
    "State saved to flash",
    60_000,
    emu.waitForSerial("New image for screen 3", 60_000, emu.waitForSerial("WS: live", 120_000, at)),
  );
  assert.equal(emu.displays.length, 4);
  assert.equal(emu.displays[3].screen, 3);
  assert.equal(emu.server.openSockets.length, 1);
  assert.equal(count(emu, "Rebooted due to watchdog"), 0);

  // Each failed attempt waited longer than the last, with jitter
  const delays = retryDelays(emu, at).slice(0, 3);
  assert.equal(delays.length, 3, `three retries before ${back}`);
  assert.ok(delays[0] >= 500 && delays[0] <= 1_500, `first retry ${delays[0]} ms`);
  assert.ok(delays[1] >= 1_000 && delays[1] <= 3_000, `second retry ${delays[1]} ms`);
  assert.ok(delays[2] >= 2_000 && delays[2] <= 6_000, `third retry ${delays[2]} ms`);
});

test("drops a socket whose server stopped answering pings, and reconnects", () => {
  const { emu, at } = bootLive();
  const [first] = emu.server.sockets;
  emu.server.answerPings = false;

  const dead = emu.waitForSerial("WS: socket is dead, dropping it", 60_000, at);
  emu.server.answerPings = true;
  emu.waitForSerial("WS: live", 10_000, dead);
  const pingsBefore = first.received.filter((m) => m === "ping").length;
  assert.ok(pingsBefore >= 1);
  assert.equal(emu.server.openSockets.length, 1);
  assert.notEqual(emu.server.openSockets[0], first);
  assert.equal(emu.displays.length, 3, "nothing redrawn: the state didn't change");
});

test("a socket that never gets its state is given up on after 30 s", () => {
  const emu = boot();
  emu.server.sendStateOnOpen = false;
  // The 30 s cover the whole connection, the TLS handshake included
  const connecting = emu.waitForSerial("WS: connecting...", 30_000);
  const opened = emu.simMs;
  const at = emu.waitForSerial("WS: connected, waiting for the board state", 10_000, connecting);
  const dead = emu.waitForSerial("WS: socket is dead, dropping it", 40_000, at);
  assert.ok(emu.simMs - opened >= 29_000, `gave up after ${(emu.simMs - opened).toFixed(0)} ms`);

  emu.server.sendStateOnOpen = true;
  emu.waitForSerial("State saved to flash", 60_000, emu.waitForSerial("WS: live", 10_000, dead));
  assert.equal(emu.displays.length, 3);
});

test("a socket replaced by a newer one from the same board just reconnects", () => {
  const { emu, at } = bootLive();
  const [first] = emu.server.sockets;
  first.close(CLOSE_REPLACED, "replaced");
  emu.waitForSerial("WS: live", 10_000, emu.waitForSerial("WS: socket closed", 5_000, at));
  assert.equal(first.closeCode, CLOSE_REPLACED);
  assert.equal(emu.server.openSockets.length, 1);
});

test("a server that crashes mid-socket (a reset) is retried", () => {
  const { emu, at } = bootLive();
  emu.server.sockets[0].drop();
  emu.waitForSerial("WS: live", 10_000, emu.waitForSerial("WS: socket closed", 5_000, at));
  assert.equal(emu.server.openSockets.length, 1);
});

test("refused with 403 (an unknown board), it backs off up to a minute, then reboots after 3", () => {
  const emu = boot();
  emu.server.upgradeStatus = 403;
  const at = emu.waitForSerial("No live socket for >3 minutes, rebooting to recover", 240_000);
  const delays = retryDelays(emu);
  assert.ok(delays.length >= 5 && delays.length <= 12, `${delays.length} attempts in 3 minutes`);
  assert.ok(Math.max(...delays) <= 90_000, "no wait over 60 s plus jitter");
  for (let i = 1; i < 4; i++) {
    assert.ok(delays[i] > delays[i - 1] / 2, "backoff grows (within jitter)");
  }
  assert.equal(emu.displays.length, 0, "never live, so nothing drawn");

  // Rebooted through the watchdog; once the server takes the board, it works
  emu.server.upgradeStatus = 101;
  emu.waitFor("a watchdog reset", () => emu.reboots === 1, 60_000);
  emu.waitForSerial("State saved to flash", 60_000, emu.waitForSerial("WS: live", 60_000, at));
  const booted = emu.net.requests.filter((r) => r.path === "/device_booted").at(-1);
  assert.equal(booted?.query.watchdog_caused_reboot, "1");
});

test("a failed image download is retried 15 s later while the socket stays up", () => {
  const emu = boot();
  emu.server.override = (req) => (req.path === "/images/2" ? { status: 500 } : undefined);
  const at = emu.waitForSerial("Refreshing screen 2 failed", 40_000);
  assert.match(emu.serial, /Fetch image HTTP request failed with status code: 500/);
  emu.waitForSerial("State saved to flash", 30_000, at);
  assert.match(emu.serial, /- Screen 2 Etag: \r?\n/, "no ETag saved for the failed screen");
  const socket = emu.server.sockets[0];
  // The server hears what the panels really show: screen 2 has nothing yet
  emu.waitFor("shown", () => socket.received.includes("shown v1-1 - v1-3"), 1_000);

  emu.server.override = null;
  const failedAt = emu.simMs;
  const retried = emu.waitForSerial("New image for screen 2", 30_000, at);
  assert.ok(emu.simMs - failedAt >= 10_000, "waits before retrying");
  emu.waitForSerial("State saved to flash", 30_000, retried);
  assert.deepEqual(
    emu.displays.map((d) => d.screen),
    [1, 3, 2],
  );
  const retry = emu.net.requests.filter((r) => r.path === "/images/2").at(-1);
  assert.equal(retry?.query.etag, undefined);
  emu.waitFor("shown", () => socket.received.includes("shown v1-1 v1-2 v1-3"), 1_000);
  assert.equal(emu.server.sockets.length, 1, "the socket stayed up throughout");
});

test("takes state messages as long as the real server's, one after another", () => {
  // The real server's ETags are 40 hex digits, so its state is ~130 bytes:
  // two in a row must each get the whole receive buffer.
  const { emu, at } = bootLive();
  const [socket] = emu.server.sockets;
  for (const screen of [1, 2, 3]) {
    const image = emu.server.images.get(screen);
    assert.ok(image);
    emu.server.images.set(screen, { ...image, etag: String(screen).repeat(40) });
  }
  emu.server.pushState();
  const saved = emu.waitForSerial("State saved to flash", 60_000, at);
  emu.server.pushState();
  emu.run(5_000);
  assert.ok(!emu.serial.includes("WS: socket closed", saved), "the socket stayed up");
  assert.equal(socket.closeCode, undefined);
  assert.equal(emu.server.sockets.length, 1);
});

test("an image without a usable ETag is drawn once, not downloaded again and again", () => {
  const emu = boot();
  emu.server.override = (req) =>
    req.path === "/images/2" ? { status: 200, body: testImage(2, 1) } : undefined;
  const at = waitForFirstImages(emu);
  emu.run(60_000);
  assert.equal(emu.net.requests.filter((r) => r.path === "/images/2").length, 1);
  assert.deepEqual(
    emu.displays.map((d) => d.screen),
    [1, 2, 3],
  );
  assert.equal(count(emu, "State saved to flash"), 1);
  assert.ok(emu.serial.indexOf("Refreshing screen 2", at) < 0, "no second download");
});

test("downloads that keep failing for 3 minutes reboot the board, though the socket is up", () => {
  const emu = boot();
  emu.server.override = (req) => (req.path === "/images/2" ? { status: 500 } : undefined);
  const at = emu.waitForSerial("Refreshing screen 2 failed", 40_000);
  const failedAt = emu.simMs;
  emu.waitForSerial("Image downloads failing for >3 minutes, rebooting to recover", 240_000, at);
  const after = emu.simMs - failedAt;
  assert.ok(after >= 170_000 && after <= 200_000, `rebooted ${(after / 1000).toFixed(0)} s in`);
  assert.equal(emu.server.openSockets.length, 1, "the socket was up all along");
  // reset_pico() waits 30 s before the watchdog fires
  emu.waitFor("a watchdog reset", () => emu.reboots === 1, 40_000);
});

test("a download that stops being wanted no longer counts as failing", () => {
  const { emu, at } = bootLive();
  emu.server.override = (req) => (req.path === "/images/2" ? { status: 500 } : undefined);
  emu.server.setImage(2, 2);
  emu.waitForSerial("Refreshing screen 2 failed", 10_000, at);
  // The admin puts the old lines back before the retry
  emu.server.setImage(2, 1);
  emu.run(240_000);
  assert.equal(emu.reboots, 0);
  assert.ok(!emu.serial.includes("Image downloads failing"));
});

test("a download the state message stops wanting while it fails doesn't count as failing", () => {
  // The new state arrives while the download is under way, so the board
  // takes it in between the failed download and deciding what's failing
  const { emu, at } = bootLive();
  emu.server.override = (req) => {
    if (req.path !== "/images/2") {
      return undefined;
    }
    emu.server.setImage(2, 1);
    return { status: 500 };
  };
  emu.server.setImage(2, 2);
  emu.waitForSerial("Refreshing screen 2 failed", 10_000, at);
  emu.run(240_000);
  assert.equal(emu.reboots, 0);
  assert.ok(!emu.serial.includes("Image downloads failing"));
});

test("a failed download the state message stops wanting doesn't hold up a screen it now wants", () => {
  // The state that arrives during screen 3's failed download puts its old
  // lines back and changes screen 1, which this round has already passed
  const { emu, at } = bootLive();
  emu.server.override = (req) => {
    if (req.path !== "/images/3") {
      return undefined;
    }
    emu.server.setImage(3, 1);
    emu.server.setImage(1, 2);
    return { status: 500 };
  };
  const before = emu.net.requests.length;
  emu.server.setImage(3, 2);
  const failed = emu.waitForSerial("Refreshing screen 3 failed", 10_000, at);
  // Right away, not after the 15 s a download that's still failing waits
  emu.waitForSerial("New image for screen 1", 10_000, failed);
  const since = emu.net.requests.slice(before).map((r) => r.path);
  assert.deepEqual(since, ["/images/3", "/images/1"], "screen 3 isn't tried again");
});

test("keeps pinging while it downloads screens one after another", () => {
  // Three downloads that each time out: the socket mustn't go quiet for
  // the whole update (a proxy closes it after a minute without traffic)
  const { emu, at } = bootLive();
  const socket = emu.server.sockets[0];
  const pings = () => socket.received.filter((m) => m === "ping").length;
  emu.server.override = (req) => (req.path.startsWith("/images/") ? { stall: true } : undefined);
  for (const screen of [1, 2, 3]) {
    emu.server.setImage(screen, 2);
  }
  const first = emu.waitForSerial("Refreshing screen 1", 5_000, at);
  const before = pings();
  emu.waitForSerial("Refreshing screen 3", 120_000, first);
  assert.ok(pings() > before, "a ping between downloads");
  emu.waitForSerial("Refreshing screen 3 failed", 60_000, first);
  assert.equal(emu.server.sockets.length, 1, "the socket stayed up");
});

test("redraws every screen with a full update when the server asks, without saving to flash", () => {
  const { emu, at } = bootLive();
  const [socket] = emu.server.sockets;
  const requests = emu.net.requests.length;
  const shown = socket.received.filter((m) => m.startsWith("shown ")).length;
  const saves = count(emu, "State saved to flash");
  const flashWrites = emu.board.flashWrites;

  socket.sendText("redraw");
  const asked = emu.waitForSerial("Server asked for every screen to be redrawn", 5_000, at);
  emu.waitFor("three more displays", () => emu.displays.length === 6, 60_000);

  // Downloaded again without the ETag, so the server sends each image again
  const since = emu.net.requests.slice(requests);
  assert.deepEqual(
    since.map((r) => [r.path, r.query.etag]),
    [
      ["/images/1", undefined],
      ["/images/2", undefined],
      ["/images/3", undefined],
    ],
  );
  // The same images, each with the full update (0xF7)
  assert.deepEqual(
    emu.displays.slice(3).map((d) => [d.screen, d.updateControl]),
    [
      [1, 0xf7],
      [2, 0xf7],
      [3, 0xf7],
    ],
  );
  for (const d of emu.displays.slice(3)) {
    assert.deepEqual(d.frame, emu.displays[d.screen - 1].frame, `screen ${d.screen}`);
  }
  // Nothing changed, so nothing to save; the server hears what's shown
  emu.waitFor(
    "the shown message",
    () => socket.received.filter((m) => m.startsWith("shown ")).length > shown,
    5_000,
  );
  assert.equal(count(emu, "State saved to flash"), saves);
  assert.equal(emu.board.flashWrites, flashWrites);
  assert.equal(socket.received.at(-1), "shown v1-1 v1-2 v1-3");

  // And it's done: no more downloads
  emu.run(60_000);
  assert.equal(emu.net.requests.length, requests + 3);
  assert.ok(emu.serial.indexOf("Refreshing screen", asked) >= 0);
});

test("a redraw whose download fails is tried again", () => {
  const { emu } = bootLive();
  const [socket] = emu.server.sockets;
  let fail = true;
  emu.server.override = (req) => {
    if (req.path === "/images/2" && fail) {
      fail = false;
      return { status: 500 };
    }
    return undefined;
  };
  socket.sendText("redraw");
  const failed = emu.waitForSerial("Refreshing screen 2 failed", 60_000);
  // Only screen 2 again, after the retry delay
  emu.waitForSerial("New image for screen 2", 30_000, failed);
  emu.waitFor("screen 2's redraw", () => emu.displays.length === 6, 10_000);
  assert.deepEqual(
    emu.displays.slice(3).map((d) => d.screen),
    [1, 3, 2],
  );
  assert.equal(emu.reboots, 0);
});

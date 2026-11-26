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

// Remote diagnostics (device/src/diagnostics.h): what the board tells the
// server about itself on the requests it makes anyway.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Emulator } from "../src/emulator.ts";
import { boot, bootReports, waitForFirstImages } from "./helpers.ts";

const FLASH_START = 0x10000000;
const FLASH_END = 0x10200000;

/** The query of the board's latest /ws upgrade. */
function lastConnect(emu: Emulator) {
  const query = emu.server.sockets.at(-1)?.request?.query;
  assert.ok(query, "a socket");
  return query;
}

/** Waits for a new socket after `count` and for it to go live; returns the serial index. */
function waitForNewSocket(emu: Emulator, count: number, from: number) {
  emu.waitFor("a new socket", () => emu.server.sockets.length > count, 120_000);
  return emu.waitForSerial("WS: live", 30_000, from);
}

test("reports why it booted, its signal and uptime, and its health hourly and on request", () => {
  const emu = boot({
    aps: [{ ssid: "SSID_1", password: "PASSPHRASE_1", bssid: [2, 1, 2, 3, 4, 5], rssi: -67 }],
  });
  waitForFirstImages(emu);

  const booted = bootReports(emu)[0]?.query;
  assert.ok(booted);
  assert.equal(booted.reset, "power_on");
  assert.equal(booted.reset_phase, undefined, "nothing recorded on a power-on");
  assert.equal(booted.rssi, "-67");
  assert.match(booted.uptime ?? "", /^\d+$/);

  const ws = lastConnect(emu);
  assert.equal(ws.rssi, "-67");
  assert.match(ws.uptime ?? "", /^\d+$/);
  assert.equal(ws.drop, undefined, "no socket before this one");
  assert.equal(ws.fails, undefined);

  // The first version check comes once the socket is live
  emu.waitFor(
    "a version check",
    () => emu.net.requests.some((r) => r.path === "/firmware/latest"),
    30_000,
  );
  const health = emu.net.requests.find((r) => r.path === "/firmware/latest")?.query;
  assert.ok(health);
  assert.equal(health.rssi, "-67");
  const heapFree = Number(health.heap_free);
  const heapMin = Number(health.heap_min);
  assert.ok(heapFree > 10_000 && heapFree < 264 * 1024, `heap_free ${health.heap_free}`);
  assert.ok(heapMin > 0 && heapMin <= heapFree, `heap_min ${health.heap_min}`);
  for (const counter of ["drops", "connect_fails", "pong_timeouts", "image_fails", "wifi_drops"]) {
    assert.equal(health[counter], "0", counter);
  }
  assert.equal(health.tls_oom, "0");

  // The admin's "Refresh now"
  const socket = emu.server.sockets.at(-1);
  assert.ok(socket);
  socket.sendText("diag");
  emu.waitFor("the diag answer", () => socket.received.some((m) => m.startsWith("diag ")), 5_000);
  const answer = socket.received.find((m) => m.startsWith("diag "));
  assert.match(
    answer ?? "",
    /^diag uptime=\d+ rssi=-67 heap_free=\d+ heap_min=\d+ drops=0 connect_fails=0 pong_timeouts=0 image_fails=0 wifi_drops=0 tls_oom=0$/,
  );
});

test("tells the server why its last socket ended and what failed since", () => {
  const emu = boot();
  let at = waitForFirstImages(emu);

  // The server closes it
  emu.run(5_000);
  emu.server.sockets[0].close(4001, "no ping");
  at = waitForNewSocket(emu, 1, at);
  let ws = lastConnect(emu);
  assert.equal(ws.drop, "server_close");
  assert.equal(ws.drop_detail, "4001");
  assert.ok(Number(ws.drop_up) >= 5, `up ${ws.drop_up} s`);
  assert.equal(ws.fails, undefined);

  // The server stops answering pings, then refuses two upgrades
  emu.server.answerPings = false;
  at = emu.waitForSerial("WS: socket is dead, dropping it", 60_000, at);
  emu.server.answerPings = true;
  emu.server.upgradeStatus = 503;
  const count = emu.server.sockets.length;
  emu.waitFor("two refused attempts", () => emu.server.sockets.length >= count + 2, 30_000);
  emu.server.upgradeStatus = 101;
  at = waitForNewSocket(emu, count + 2, at);
  ws = lastConnect(emu);
  assert.equal(ws.drop, "pong_timeout");
  assert.equal(ws.drop_detail, "0");
  assert.ok(Number(ws.fails) >= 2, `${ws.fails} failures`);
  assert.equal(ws.fail, "handshake");
  assert.equal(ws.fail_detail, "503");

  // The counters since boot
  emu.server.sockets.at(-1)?.sendText("diag");
  emu.waitFor(
    "the diag answer",
    () => emu.server.sockets.at(-1)?.received.some((m) => m.startsWith("diag ")) ?? false,
    5_000,
  );
  const answer = emu.server.sockets.at(-1)?.received.find((m) => m.startsWith("diag ")) ?? "";
  assert.match(answer, / drops=2 /);
  assert.match(answer, / pong_timeouts=1 /);
  assert.match(answer, / connect_fails=\d+ /);
  assert.ok(Number(/connect_fails=(\d+)/.exec(answer)?.[1]) >= 2, answer);
});

test("a crash reboots at once and tells the server where it happened", () => {
  const emu = boot();
  waitForFirstImages(emu);
  emu.run(2_000);

  emu.hardFault();
  emu.waitFor("a watchdog reset", () => emu.reboots === 1, 1_000);
  emu.waitFor("the boot report", () => bootReports(emu).length === 2, 60_000);

  const report = bootReports(emu)[1].query;
  assert.equal(report.reset, "crash");
  assert.equal(report.reset_phase, "running");
  const pc = Number(report.reset_detail);
  assert.ok(pc >= FLASH_START && pc < FLASH_END, `pc 0x${pc.toString(16)} in flash`);
  assert.ok(Number(report.reset_extra) !== 0, "and lr");
  assert.ok(Number(report.reset_uptime) >= 5, `after ${report.reset_uptime} s`);
  assert.match(emu.serial, /Reset reason: crash \(while running, after \d+ s, detail 0x1/);
});

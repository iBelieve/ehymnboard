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

// Runs the firmware's WebSocket client (the ehymnboard_autobahn build) in
// the emulator against the Autobahn test suite's fuzzingserver, then checks
// the suite's verdict on every case. See README.md.
//
// Usage: node autobahn/run.ts [<ehymnboard_autobahn.uf2>] [--server http://127.0.0.1:9001]
//          [--reports autobahn/reports]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { tunnelTo } from "../src/backend.ts";
import { Emulator } from "../src/emulator.ts";

const HERE = import.meta.dirname;
const AGENT = "ehymnboard";
// Simulated time for the whole run (about 30 minutes for sections 1-7)
const RUN_MS = 3 * 60 * 60 * 1000;
// Real time a single case may take before the run is called stuck
const CASE_TIMEOUT_MS = 60_000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string", default: "http://127.0.0.1:9001" },
    reports: { type: "string", default: path.join(HERE, "reports") },
  },
});
const firmware = positionals[0] ?? path.join(HERE, "..", "..", "build", "ehymnboard_autobahn.uf2");

const emu = new Emulator({
  firmware,
  hosts: ["autobahn.test"],
  // Every connection the board makes is a WebSocket to the fuzzingserver.
  // It checks the Host header's port against its own URL's (80), not the
  // published one, so the board's own Host goes through.
  tunnel: tunnelTo(values.server, "autobahn.test"),
  quiet: true,
});
let lastProgress = Date.now();
emu.board.on("serial", (text) => {
  for (const line of text.split("\n")) {
    if (line.startsWith("AUTOBAHN")) {
      console.log(line);
      lastProgress = Date.now();
    }
  }
});
const stuck = setInterval(() => {
  if (Date.now() - lastProgress > CASE_TIMEOUT_MS) {
    console.log(`stuck: no progress in ${CASE_TIMEOUT_MS / 1000} s; last output:`);
    console.log(emu.serial.slice(-2000));
    process.exit(1);
  }
}, 1_000);

const t0 = Date.now();
await emu.untilSerial(/AUTOBAHN (DONE|FAILED)/, RUN_MS);
clearInterval(stuck);
console.log(
  `ran ${(emu.simMs / 1000).toFixed(0)} s simulated in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
);
if (emu.serial.includes("AUTOBAHN FAILED")) {
  process.exit(1);
}

// The suite's verdict on each case, from its report index
const index: unknown = JSON.parse(
  fs.readFileSync(path.join(values.reports, "clients", "index.json"), "utf8"),
);
const agent: unknown =
  typeof index === "object" && index !== null
    ? Object.entries(index).find(([k]) => k === AGENT)?.[1]
    : undefined;
const results =
  typeof agent === "object" && agent !== null
    ? Object.entries(agent).map(([id, result]: [string, unknown]) => {
        const r = typeof result === "object" && result !== null ? result : {};
        const field = (key: string) => {
          const value: unknown = Object.entries(r).find(([k]) => k === key)?.[1];
          return typeof value === "string" ? value : "MISSING";
        };
        return { id, behavior: field("behavior"), behaviorClose: field("behaviorClose") };
      })
    : [];

/** OK, NON-STRICT and INFORMATIONAL are passes in the suite's own terms. */
function passes(verdict: string) {
  return ["OK", "NON-STRICT", "INFORMATIONAL"].includes(verdict);
}

const counts = new Map<string, number>();
const bad = [];
for (const { id, behavior, behaviorClose } of results) {
  counts.set(behavior, (counts.get(behavior) ?? 0) + 1);
  // For the case and for how the connection closed
  if (!passes(behavior) || !passes(behaviorClose)) {
    bad.push(`${id}: ${behavior} (close: ${behaviorClose})`);
  }
}
console.log(`${results.length} cases: ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}`);
if (results.length === 0 || bad.length > 0) {
  console.log(bad.join("\n"));
  process.exit(1);
}

/*
 * eHymnBoard full-stack end-to-end tests
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

// Full-stack end-to-end tests: the real firmware in the emulator talks to a
// running hymn board server while a browser drives its admin page. Without
// E2E_BASE_URL, the tests start the server themselves (see README.md).
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

/** The session signIn.setup.ts saves, which every test starts with. */
export const SIGNED_IN = path.join(import.meta.dirname, ".auth", "signed-in.json");

const executablePath = process.env.E2E_CHROMIUM_EXECUTABLE;
// The server under test: the one E2E_BASE_URL names, or else web/'s build,
// run here by `wrangler dev` (the Workers runtime under Miniflare, as on
// Cloudflare) with empty data each run and the emulated board allowed.
const ownServer = process.env.E2E_BASE_URL === undefined;
// Not 8787, `wrangler dev`'s default, or 8788, `wrangler pages dev`'s: a
// Worker another project runs on its default port would take this one
const port = 8790;
// signIn.setup.ts creates the first account on a server of our own with
// this setup password
if (ownServer) {
  process.env.E2E_SETUP_PASSWORD ??= "e2e-setup";
}
const vars = {
  BETTER_AUTH_SECRET: "e2e-only-secret-of-at-least-32-characters",
  SETUP_PASSWORD: process.env.E2E_SETUP_PASSWORD,
  EXTRA_DEVICE_IDS: "0000000000000000",
  // Production's wrangler.jsonc turns these on: never ping the real boards' checks
  HEALTHCHECKS: "off",
};
const state = ".wrangler/e2e-state";
// The Flagship app the Worker is bound to: `wrangler dev` evaluates its flags
// against a local store, in `state`, which starts empty (so every flag off)
const flagshipApp = /"app_id":\s*"([^"]+)"/.exec(
  readFileSync(path.join(import.meta.dirname, "../web/wrangler.jsonc"), "utf8"),
)?.[1];
if (!flagshipApp) {
  throw new Error("no Flagship app_id in web/wrangler.jsonc");
}
/** `value` as one sh word, whatever it holds (the command runs in a shell). */
function shellWord(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
const serverCommand = [
  "pnpm run build",
  `rm -rf ${state}`,
  // Partial refresh on for every board, as it will be in production: the
  // tests then run the Flagship flag, the state's "partial" and the
  // firmware's partial updates end to end (see tests/fixtures.ts)
  `pnpm exec wrangler flagship flags create ${flagshipApp} partial-refresh --default on --local --persist-to ${state}`,
  [
    // No --config: wrangler follows .wrangler/deploy/config.json to the
    // Worker the build just wrote, whatever wrangler.jsonc names it
    "pnpm exec wrangler dev",
    `--ip 127.0.0.1 --port ${port} --persist-to ${state}`,
    ...Object.entries(vars).map(([name, value]) => `--var ${shellWord(`${name}:${value ?? ""}`)}`),
  ].join(" "),
].join(" && ");

export default defineConfig({
  testDir: "tests",
  // One server holds one set of lines, so tests take turns.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 5 * 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  webServer: ownServer
    ? {
        command: serverCommand,
        cwd: "../web",
        url: `http://127.0.0.1:${port}/ok`,
        // A server already on the port could be anything, with any data
        reuseExistingServer: false,
        // The build, then wrangler's start
        timeout: 120_000,
        // Its log, in CI only, where a failure has no other server log
        stdout: process.env.CI ? "pipe" : "ignore",
        stderr: "pipe",
        gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      }
    : undefined,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: "sign in", testMatch: "signIn.setup.ts" },
    { name: "e2e", dependencies: ["sign in"], use: { storageState: SIGNED_IN } },
  ],
});

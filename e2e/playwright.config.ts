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
import { defineConfig } from "@playwright/test";

const executablePath = process.env.E2E_CHROMIUM_EXECUTABLE;
// The server under test: the one E2E_BASE_URL names, or else web/'s build,
// run here by `wrangler dev` (the Workers runtime under Miniflare, as on
// Cloudflare) with empty data each run and the emulated board allowed.
const ownServer = process.env.E2E_BASE_URL === undefined;
const port = 8787;
const username = process.env.E2E_USERNAME ?? (ownServer ? "e2e" : undefined);
const password = process.env.E2E_PASSWORD ?? (ownServer ? "e2e-password" : undefined);
const vars = {
  BASIC_AUTH_USERNAME: username,
  BASIC_AUTH_PASSWORD: password,
  EXTRA_DEVICE_IDS: "0000000000000000",
  // Production's wrangler.jsonc turns these on: never ping the real boards' checks
  HEALTHCHECKS: "off",
};
const state = ".wrangler/e2e-state";
const serverCommand = [
  "pnpm run build",
  `rm -rf ${state}`,
  [
    "pnpm exec wrangler dev --config dist/hymnboard/wrangler.json",
    `--ip 127.0.0.1 --port ${port} --persist-to ${state}`,
    ...Object.entries(vars).map(([name, value]) => `--var ${name}:${value ?? ""}`),
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
    httpCredentials: username && password ? { username, password, send: "always" } : undefined,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
});

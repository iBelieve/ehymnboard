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
// running hymn board server while a browser drives its admin page. See
// README.md for how to point it at a server.
import { defineConfig } from "@playwright/test";

const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
const executablePath = process.env.E2E_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "tests",
  // One server holds one set of lines, so tests take turns.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 5 * 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8000",
    httpCredentials: username && password ? { username, password, send: "always" } : undefined,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
});

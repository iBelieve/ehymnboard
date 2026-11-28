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

// Signs in once through the admin page, as a person would, and saves the
// session for every test (playwright.config.ts). On a server with no
// accounts yet, it first creates one with the server's setup password.
import { expect, test as setup } from "@playwright/test";
import { SIGNED_IN } from "../playwright.config.ts";

const email = process.env.E2E_EMAIL ?? "e2e@example.com";
const password = process.env.E2E_PASSWORD ?? "e2e-password";
const setupPassword = process.env.E2E_SETUP_PASSWORD;

setup("sign in", async ({ page, baseURL }) => {
  // Stay hermetic, as the tests do (fixtures.ts)
  const origin = new URL(baseURL!).host;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).host === origin ? route.continue() : route.abort(),
  );
  await page.goto("/");
  const signIn = page.getByRole("button", { name: "Sign in" });
  const create = page.getByRole("button", { name: "Create account" });
  await expect(signIn.or(create)).toBeVisible();

  if (await create.isVisible()) {
    if (!setupPassword) {
      throw new Error("The server has no accounts yet: set E2E_SETUP_PASSWORD to create one");
    }
    await page.getByLabel("Setup password").fill(setupPassword);
    await page.getByLabel("Your name").fill("End-to-end tests");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("New password").fill(password);
    await create.click();
  } else {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await signIn.click();
  }

  await expect(page.getByRole("button", { name: "Apply" })).toBeVisible();
  await page.context().storageState({ path: SIGNED_IN });
});

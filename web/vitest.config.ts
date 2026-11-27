import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/render.test.ts", "test/prettyDate.test.ts", "test/redraw.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                BETTER_AUTH_SECRET: "a test secret of at least 32 characters",
                SETUP_PASSWORD: "setup-secret",
                EXTRA_DEVICE_IDS: "0000000000000000, 1111111111111111",
                HEALTHCHECKS: "on",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          // Loading Better Auth takes a few seconds
          // the first time in each file (the bundled Worker doesn't).
          testTimeout: 20_000,
          hookTimeout: 20_000,
          include: [
            "test/worker.test.ts",
            "test/migrations.test.ts",
            "test/websocket.test.ts",
            "test/accounts.test.ts",
            "test/account-migrations.test.ts",
          ],
        },
      },
    ],
  },
});

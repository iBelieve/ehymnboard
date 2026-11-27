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
                BASIC_AUTH_USERNAME: "admin",
                BASIC_AUTH_PASSWORD: "secret",
                EXTRA_DEVICE_IDS: "0000000000000000, 1111111111111111",
                HEALTHCHECKS: "on",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker.test.ts", "test/migrations.test.ts", "test/websocket.test.ts"],
        },
      },
    ],
  },
});

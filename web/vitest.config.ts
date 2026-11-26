import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `pnpm run test:coverage`: Istanbul, since the Workers pool can't
    // collect V8 coverage. Fallow's health check reads coverage-final.json
    // for each function's CRAP score.
    coverage: {
      provider: "istanbul",
      include: ["src/**", "selfhost/**", "test/**/*.{ts,tsx}"],
      reporter: ["json", "text-summary"],
    },
    projects: [
      {
        test: {
          name: "node",
          include: [
            "test/render.test.ts",
            "test/prettyDate.test.ts",
            "test/selfhost-assets.test.ts",
          ],
          environment: "node",
        },
      },
      {
        // The React admin, in a fake DOM.
        test: {
          name: "client",
          include: ["test/client/*.test.tsx"],
          environment: "happy-dom",
          setupFiles: ["test/client/setup.ts"],
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

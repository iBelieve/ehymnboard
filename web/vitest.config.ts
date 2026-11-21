import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "render", include: ["test/render.test.ts"], environment: "node" },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { BASIC_AUTH_USERNAME: "admin", BASIC_AUTH_PASSWORD: "secret" },
            },
          }),
        ],
        test: { name: "worker", include: ["test/worker.test.ts"] },
      },
    ],
  },
});

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEV_VARS = {
  HEALTHCHECKS: "off",
  BETTER_AUTH_SECRET: "only for pnpm dev, never a real deploy's secret",
  SETUP_PASSWORD: "dev",
};

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // wrangler.jsonc's HEALTHCHECKS=on is production's: `pnpm dev` turns it
    // off, so local requests never ping the boards' real healthchecks.io
    // checks. Only for serve, so the build, and what it deploys, keeps it.
    // `pnpm dev` also gets its own secrets (its accounts are only on this
    // machine): the setup password is "dev".
    cloudflare(command === "serve" ? { config: { vars: DEV_VARS } } : {}),
  ],
  // The Docker image's port when PORT isn't set, and the e2e tests' default.
  // (Not 5000: macOS's AirPlay Receiver listens there.)
  server: { port: 8000, strictPort: true },
  build: {
    // The admin bundles opentype.js and the font for its live preview.
    chunkSizeWarningLimit: 800,
  },
}));

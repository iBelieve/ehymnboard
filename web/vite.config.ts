import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // wrangler.jsonc's HEALTHCHECKS=on is production's: `pnpm dev` turns it
    // off, so local requests never ping the boards' real healthchecks.io
    // checks. Only for serve, so the build, and what it deploys, keeps it.
    cloudflare(command === "serve" ? { config: { vars: { HEALTHCHECKS: "off" } } } : {}),
  ],
  // `pnpm dev`'s port (not 5000: macOS's AirPlay Receiver listens there)
  server: { port: 8000, strictPort: true },
  build: {
    // The admin bundles opentype.js and the font for its live preview.
    chunkSizeWarningLimit: 800,
  },
}));

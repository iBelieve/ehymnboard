import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // The same port as the Docker image and the e2e tests' default. (Not 5000:
  // macOS's AirPlay Receiver listens there.)
  server: { port: 8000, strictPort: true },
  build: {
    // The admin bundles opentype.js and the font for its live preview.
    chunkSizeWarningLimit: 800,
  },
});

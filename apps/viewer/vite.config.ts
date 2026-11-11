import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Viewer dev/build config. The v1 RunResult fixtures remain static assets under
 * public/, written by scripts/generateFixture.mts when it is run by hand,
 * fetched over HTTP by the v1 archive route. The workbench routes talk to the
 * platform server through the /api dev proxy below (apps/server binds
 * 127.0.0.1:8787). SSE passes through the proxy as plain
 * HTTP/1.1 streaming. Nothing here computes a balance-sheet number; the bundle
 * is a pure reader.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
  preview: { port: 4173, strictPort: true },
});

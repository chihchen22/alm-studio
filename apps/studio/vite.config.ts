import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Studio dev/build config (S1). Pure reader over the platform API; /api proxies to apps/server on 8787 (127.0.0.1). */
export default defineConfig({
  plugins: [react()],
  base: "/studio/",
  server: { host: "127.0.0.1", port: 5180, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } } },
  preview: { port: 4180, strictPort: true },
});

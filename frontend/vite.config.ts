/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wails from "@wailsio/runtime/plugins/vite";

const src = fileURLToPath(new URL("./src", import.meta.url));
const bindings = fileURLToPath(new URL("./bindings/toolbox", import.meta.url));

export default defineConfig({
  server: {
    // Dev-only server, loopback only (see docs/DECISIONS.md).
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@bindings": bindings,
      "@": src,
    },
  },
  plugins: [react(), wails("./bindings")],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // user-event flows take ~2 s alone and exceed the 5 s default under a full parallel run
    testTimeout: 15000,
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});

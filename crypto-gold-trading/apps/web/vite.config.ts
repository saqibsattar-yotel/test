import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { apiGate, createDevLogger, resolveApiTarget, targetAuthority } from "./dev/api-gate";

const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig(({ command }) => {
  // The dev proxy follows the API server's PORT / HOST from the root env files instead of a hardcoded address.
  const api = resolveApiTarget(repoRoot);
  const authority = targetAuthority(api);
  const devServer = command === "serve" && !process.env.VITEST;
  return {
    // The gate holds /api requests while the API server boots or restarts (see dev/api-gate.ts).
    plugins: [react(), ...(devServer ? [apiGate(api, { repoRoot })] : [])],
    // Routine proxy disconnects (API restart, tab reload) become one-line warnings instead of stack traces.
    ...(devServer ? { customLogger: createDevLogger() } : {}),
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
    server: {
      port: 5173,
      proxy: {
        "/api": { target: `http://${authority}`, changeOrigin: true },
        "/ws": { target: `ws://${authority}`, ws: true },
      },
    },
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
  };
});

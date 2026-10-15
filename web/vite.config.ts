import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// base "./" lets the same build run from the Go binary (served at /) and from
// GitHub Pages (served under /sqlmal/).
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:8484" } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});

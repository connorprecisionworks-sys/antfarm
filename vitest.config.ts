import { defineConfig } from "vitest/config";

// Vitest runs the pure relay reducer tests. The reducer is plain TS (no JSX,
// no DOM, no Tauri), so a node environment is enough — no React plugin needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

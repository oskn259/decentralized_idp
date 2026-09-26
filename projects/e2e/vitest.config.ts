import { defineConfig } from "vitest/config";

/** One file, its tests in order: the later ones take nodes down. Chromium takes a moment to start. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

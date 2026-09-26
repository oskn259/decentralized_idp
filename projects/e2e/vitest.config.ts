import { defineConfig } from "vitest/config";

/** One file, its tests in order: the later ones stop containers. `docker compose up --build` can take minutes. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
});

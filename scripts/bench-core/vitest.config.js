import { defineConfig } from "vitest/config";

// The native core's benchmark (core.bench.js): not a test, and not part of
// `npm test`. Run with `npm run bench:core`.
export default defineConfig({
  test: {
    include: ["scripts/bench-core/core.bench.js"],
    testTimeout: 600_000,
    setupFiles: ["./test/setup/happy-dom-patches.js"],
  },
});

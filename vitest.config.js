import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    testTimeout: 30000, // WASM boot + meshing
    setupFiles: ["./test/setup/happy-dom-patches.js", "./test/setup/full-core.js"],
  },
});

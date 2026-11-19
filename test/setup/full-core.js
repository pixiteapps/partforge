// The native core's full build (the k.implicit engine) loads on demand (core.js
// loadFullCore). Tests run with it loaded, as a worker building an organic part does;
// test/core-split.test.js covers a realm that has only the base build.
import { loadFullCore } from "../../src/framework/core/core.js";

await loadFullCore();

// A kernel boot that fails once must not fail the worker for good. The WASM fetch
// behind a boot can be cut off mid-download ("WebAssembly compilation aborted:
// Network error: Response body loading was aborted"), and the worker used to keep
// that rejected boot and hand it to every later job, so retrying could never help
// (feedback #222: six applies, one error). Manifold-only, so the two-backends-
// one-process rule holds.
import { afterEach, expect, test, vi } from "vitest";

let failures = 0;
vi.mock("manifold-3d", async (importOriginal) => {
  const real = await importOriginal();
  return {
    default: (...args) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error("WebAssembly compilation aborted: Network error"));
      }
      return real.default(...args);
    },
  };
});

import { runWorker } from "../src/framework/worker.js";

const part = {
  defaults: {}, views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (k) => k.cylinder({ r: 5, h: 10 }) } },
};

afterEach(() => { delete globalThis.self; delete globalThis.postMessage; failures = 0; });

function start() {
  const posts = [];
  globalThis.self = { name: "manifold", navigator: { userAgent: "node" } };
  globalThis.postMessage = (m) => posts.push(m);
  runWorker(part);
  return posts;
}

const generate = () => self.onmessage({ data: { type: "generate", subparts: ["a"], view: "v", params: {} } });
const waitFor = (posts, type) => vi.waitFor(() => {
  const m = posts.find((p) => p.type === type);
  expect(m).toBeTruthy();
  return m;
}, { timeout: 20_000 });

test("a failed eager boot still posts ready, so the host's first build reports the failure", async () => {
  failures = 2; // the eager boot and the first job's retry
  const posts = start();
  await waitFor(posts, "ready");
  generate();
  const err = await waitFor(posts, "error");
  expect(err.message).toMatch(/Network error/);
});

test("the next job boots the kernel again after a failed boot, and builds", async () => {
  failures = 2;
  const posts = start();
  await waitFor(posts, "ready");
  generate();
  await waitFor(posts, "error");
  generate();
  const meshes = await waitFor(posts, "meshes");
  expect(meshes.meshes.length).toBeGreaterThan(0);
});

// mount's gate opens on the FIRST ready from either worker, and the occt worker posts
// its ready at once, so a real host's first generate reaches the manifold worker while
// the eager boot is still in flight. That boot failing is not this job's own attempt.
test("a job already waiting when the eager boot fails boots again instead of inheriting the failure", async () => {
  failures = 1;
  const posts = start();
  generate(); // before ready, exactly as mount sends it
  const meshes = await waitFor(posts, "meshes");
  expect(meshes.meshes.length).toBeGreaterThan(0);
  expect(posts.some((p) => p.type === "error")).toBe(false);
});

test("a job waiting on the eager boot still reports a failure when its own boot fails too", async () => {
  failures = 2;
  const posts = start();
  generate();
  const err = await waitFor(posts, "error");
  expect(err.message).toMatch(/Network error/);
});

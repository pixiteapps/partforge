import { expect, test } from "vitest";
import { createCaptureBuild } from "../../src/framework/capture-build.js";

test("request resolves with the meshes from the matching capture-meshes reply", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  const p = cb.request({ subparts: ["a", "b"], view: "assembly", params: {}, backend: "manifold" });

  expect(sent).toHaveLength(1);
  const { jobId, type } = sent[0];
  expect(type).toBe("capture-generate");

  const meshes = [{ name: "a" }, { name: "b" }];
  const consumed = cb.handleMessage({ type: "capture-meshes", jobId, meshes });
  expect(consumed).toBe(true);
  await expect(p).resolves.toEqual(meshes);
});

test("handleMessage ignores non-capture and unknown-jobId messages", () => {
  const cb = createCaptureBuild({ send: () => {} });
  expect(cb.handleMessage({ type: "meshes", meshes: [] })).toBe(false);
  expect(cb.handleMessage({ type: "capture-meshes", jobId: 999, meshes: [] })).toBe(false);
});

test("an error reply for a pending capture job resolves request() to null", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  const p = cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });
  const { jobId } = sent[0];

  const consumed = cb.handleMessage({ type: "error", jobId, message: "derive blew up" });
  expect(consumed).toBe(true);
  await expect(p).resolves.toBeNull();
});

test("a needs-occt reply for a pending capture job resolves request() to null", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  const p = cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });
  const { jobId } = sent[0];

  const consumed = cb.handleMessage({ type: "needs-occt", jobId });
  expect(consumed).toBe(true);
  await expect(p).resolves.toBeNull();
});

// Fix round (task-9 review): needs-import-mesh MUST be claimed here for the
// capture job's own jobId, not left to fall through to mount's live-loop
// crossover case — this capture job never went through the regen loop, so a
// live-crossover reading of this reply would call loop.buildDone() for a
// build the live loop never dispatched.
test("a needs-import-mesh reply for a pending capture job resolves request() to null", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  const p = cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });
  const { jobId } = sent[0];

  const consumed = cb.handleMessage({ type: "needs-import-mesh", jobId, subparts: ["a"] });
  expect(consumed).toBe(true);
  await expect(p).resolves.toBeNull();
});

test("capture jobIds are namespaced strings, so they can't collide with export-controller's numeric jobIds", () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });

  const { jobId } = sent[0];
  expect(typeof jobId).toBe("string");
  expect(jobId).toMatch(/^cap-/);
  // An export-style numeric jobId of the same ordinal must not match — a
  // shared-key collision would let one channel's reply settle the other's promise.
  expect(cb.handleMessage({ type: "capture-meshes", jobId: 1, meshes: [] })).toBe(false);
});

test("dispose() settles any outstanding request() to null instead of leaving it pending forever", async () => {
  const cb = createCaptureBuild({ send: () => {} });
  const p = cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });
  cb.dispose();
  await expect(p).resolves.toBeNull();
});

// Review fix 3: a request() made AFTER dispose (the workers are already terminated, so a send
// would post into the void and hang forever) must resolve null without sending anything —
// captureView's documented "disposed runtime resolves null".
test("request() after dispose resolves null and does not send", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });
  cb.dispose();

  await expect(cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" })).resolves.toBeNull();
  expect(sent).toHaveLength(0);
});

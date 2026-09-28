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
  // The other correlated channels on the same worker keep their replies:
  // export-controller's "export-"/"warm-" ids and mount's tessellate-imports "tess-N".
  expect(cb.handleMessage({ type: "error", message: "x", jobId: "export-1-1" })).toBe(false);
  expect(cb.handleMessage({ type: "error", message: "x", jobId: "warm-1-1" })).toBe(false);
  expect(cb.handleMessage({ type: "error", message: "x", jobId: "tess-1" })).toBe(false);
});

// The ids are what keep one mount's replies from settling another's capture on
// a worker the host kept across mounts (see mount-capture-view.test.js).
test("two capture builds never mint the same jobId", () => {
  const sent = [];
  const first = createCaptureBuild({ send: (msg) => sent.push(msg) });
  const second = createCaptureBuild({ send: (msg) => sent.push(msg) });
  for (const cb of [first, second, first, second]) {
    cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });
  }
  const ids = sent.map((m) => m.jobId);
  expect(new Set(ids).size).toBe(ids.length);
});

// A capture-generate runs to completion, so a disposed build's job still
// answers, on whichever build is listening now. That reply must not settle the
// later build's capture with pre-edit meshes, and it must not fall through to
// mount's switch, which reads an "error" as a failed build.
test("a disposed capture build's late replies neither settle a later build's capture nor fall through", async () => {
  const sentA = [];
  const a = createCaptureBuild({ send: (msg) => sentA.push(msg) });
  const stale = a.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });
  a.dispose();
  await expect(stale).resolves.toBeNull();
  const staleJobId = sentA[0].jobId;

  const sentB = [];
  const b = createCaptureBuild({ send: (msg) => sentB.push(msg) });
  let settled = false;
  const retry = b.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" })
    .then((meshes) => { settled = true; return meshes; });

  for (const type of ["capture-meshes", "error", "needs-occt", "needs-import-mesh"]) {
    expect(b.handleMessage({ type, jobId: staleJobId, meshes: [{ name: "before-the-edit" }], message: "stale" })).toBe(true);
  }
  await Promise.resolve();
  expect(settled).toBe(false);

  const meshes = [{ name: "after-the-edit" }];
  expect(b.handleMessage({ type: "capture-meshes", jobId: sentB[0].jobId, meshes })).toBe(true);
  await expect(retry).resolves.toEqual(meshes);
});

test("a reply to a capture this build already settled is claimed and dropped", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });
  const p = cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });
  const { jobId } = sent[0];
  expect(cb.handleMessage({ type: "capture-meshes", jobId, meshes: [] })).toBe(true);
  await p;
  expect(cb.handleMessage({ type: "error", jobId, message: "late" })).toBe(true);
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

test("capture jobIds are namespaced strings, so they can't collide with another channel's jobIds", () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  cb.request({ subparts: ["a"], view: "assembly", params: {}, backend: "manifold" });

  const { jobId } = sent[0];
  expect(jobId).toMatch(/^cap-\d+-1$/);
  // A bare numeric jobId of the same ordinal must not match — a shared-key
  // collision would let one channel's reply settle the other's promise.
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

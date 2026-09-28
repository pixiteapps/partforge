// test/export-controller.test.js
import { expect, test, vi } from "vitest";
import { createExportController, backendForFormat } from "../src/framework/export-controller.js";

test("backendForFormat: step always routes to occt regardless of the default", () => {
  expect(backendForFormat("step", () => "manifold")).toBe("occt");
  expect(backendForFormat("step", () => "occt")).toBe("occt");
});

test("backendForFormat: every other format defers to the default backend", () => {
  expect(backendForFormat("stl", () => "manifold")).toBe("manifold");
  expect(backendForFormat("3mf", () => "occt")).toBe("occt");
});

function setup(overrides = {}) {
  const sent = [];
  const ctl = createExportController({
    send: (msg, backend) => sent.push({ msg, backend }),
    currentView: () => "all",
    title: () => "My Part",
    defaultBackend: () => "manifold",
    currentParams: () => ({ foo: 1 }),
    ...overrides,
  });
  return { ctl, sent };
}

test("STL export sends jobId + explicit parts on the default backend", () => {
  const { ctl, sent } = setup();
  ctl.exportParts({ parts: ["a", "b"], format: "stl", onProgress: vi.fn() });
  expect(sent).toHaveLength(1);
  expect(sent[0].backend).toBe("manifold");
  expect(sent[0].msg).toMatchObject({ type: "export-stl", parts: ["a", "b"], view: "all", name: "My Part" });
  expect(sent[0].msg.jobId).toMatch(/^export-\d+-\d+$/);
});

test("the sent message carries the live params from currentParams()", () => {
  const { ctl, sent } = setup({ currentParams: () => ({ facets: 7, twist: true }) });
  ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
  expect(sent[0].msg.params).toEqual({ facets: 7, twist: true });
});

test("dispose rejects every pending export", async () => {
  const { ctl } = setup();
  const done = ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
  ctl.dispose("viewer disposed");
  await expect(done).rejects.toThrow("viewer disposed");
});

test("STEP export routes to occt", () => {
  const { ctl, sent } = setup();
  ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() });
  expect(sent[0].backend).toBe("occt");
  expect(sent[0].msg.type).toBe("export-step");
});

test("progress is routed to onProgress; download resolves + hits the sink", async () => {
  const { ctl, sent } = setup();
  const onProgress = vi.fn();
  const sink = vi.fn();
  const done = ctl.exportParts({ parts: ["a"], format: "stl", onProgress });
  const { jobId } = sent[0].msg;
  expect(ctl.handleMessage({ type: "progress", phase: "building A", jobId }, sink)).toBe(true);
  expect(onProgress).toHaveBeenCalledWith("building A");
  ctl.handleMessage({ type: "download-parts", parts: [{ name: "a", data: new Uint8Array([1]).buffer }], ext: "stl", mime: "model/stl", jobId }, sink);
  await expect(done).resolves.toBeUndefined();
  expect(sink).toHaveBeenCalledTimes(1);
});

// meta.title is untrusted (hosts run LLM-generated and user-supplied parts), and
// it names the zip the browser saves.
test("the zip name is slugged from an untrusted title", () => {
  const cases = [["My Part", "my-part.zip"], ["../../evil", "evil.zip"], ["…", "parts.zip"], [undefined, "parts.zip"]];
  for (const [title, expected] of cases) {
    const { ctl, sent } = setup({ title: () => title });
    const sink = vi.fn();
    ctl.exportParts({ parts: ["a", "b"], format: "stl", onProgress: vi.fn() });
    const { jobId } = sent[0].msg;
    ctl.handleMessage({
      type: "download-parts", ext: "stl", mime: "model/stl", jobId,
      parts: [{ name: "a", data: new Uint8Array([1]).buffer }, { name: "b", data: new Uint8Array([2]).buffer }],
    }, sink);
    expect(sink.mock.calls[0][0].filename, `title ${title}`).toBe(expected);
  }
});

test("error rejects the pending export", async () => {
  const { ctl, sent } = setup();
  const done = ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
  const { jobId } = sent[0].msg;
  ctl.handleMessage({ type: "error", message: "boom", jobId }, vi.fn());
  await expect(done).rejects.toThrow("boom");
});

// Fix round (task-9 review): needs-import-mesh MUST be claimed here for the
// export job's own jobId, not left to fall through to mount's live-loop
// crossover case — this export job never went through the regen loop, so a
// live-crossover reading of this reply would call loop.buildDone() for a
// build the live loop never dispatched. v1 behavior: fail the export cleanly.
test("needs-import-mesh rejects the pending export with a clear message", async () => {
  const { ctl, sent } = setup();
  const done = ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
  const { jobId } = sent[0].msg;
  const consumed = ctl.handleMessage({ type: "needs-import-mesh", jobId, subparts: ["a"] }, vi.fn());
  expect(consumed).toBe(true);
  await expect(done).rejects.toThrow(/STEP import needs tessellation/);
});

test("messages without a matching jobId are not consumed", () => {
  const { ctl } = setup();
  expect(ctl.handleMessage({ type: "meshes", jobId: undefined }, vi.fn())).toBe(false);
  expect(ctl.handleMessage({ type: "download", jobId: 999 }, vi.fn())).toBe(false);
  // The other correlated channels on the same worker keep their replies:
  // capture-build's "cap-N" and mount's tessellate-imports "tess-N".
  expect(ctl.handleMessage({ type: "error", message: "x", jobId: "cap-1" }, vi.fn())).toBe(false);
  expect(ctl.handleMessage({ type: "error", message: "x", jobId: "tess-1" }, vi.fn())).toBe(false);
});

// The ids are what keep one mount's replies from settling another's export on
// a worker the host kept across mounts (see export-mount-wiring.test.js).
test("two controllers never mint the same jobId", () => {
  const first = setup();
  const second = setup();
  for (const { ctl } of [first, second]) {
    ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
    ctl.warmKernel();
  }
  const ids = [...first.sent, ...second.sent].map((s) => s.msg.jobId);
  expect(new Set(ids).size).toBe(ids.length);
});

test("a reply to a job this controller already settled is claimed and dropped", async () => {
  const { ctl, sent } = setup();
  const sink = vi.fn();
  const done = ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() });
  const { jobId } = sent[0].msg;
  const reply = { type: "download", data: new ArrayBuffer(1), filename: "t.step", mime: "application/step", jobId };
  expect(ctl.handleMessage(reply, sink)).toBe(true);
  await done;
  expect(ctl.handleMessage({ ...reply, data: new ArrayBuffer(1) }, sink)).toBe(true);
  expect(sink).toHaveBeenCalledTimes(1);
});

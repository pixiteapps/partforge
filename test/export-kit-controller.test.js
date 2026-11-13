// exportKit: one `export-kit` worker job per call, its `kit` reply handed to the host's
// onKit sink (deliverKit) once, and the job's id claimed like every other export's.
import { expect, test, vi } from "vitest";
import { createExportController } from "../src/framework/export-controller.js";

function setup(overrides = {}) {
  const sent = [];
  const ctl = createExportController({
    send: (msg, backend) => sent.push({ msg, backend }),
    currentView: () => "all",
    title: () => "My Part",
    defaultBackend: () => "manifold",
    currentParams: () => ({ t: 3 }),
    ...overrides,
  });
  return { ctl, sent };
}

const entries = [
  { path: "print/a.stl", kind: "model-stl", data: new Uint8Array([1]) },
  { path: "README.txt", kind: "text", data: new Uint8Array([2]) },
];

test("exportKit sends one export-kit message on the default backend", () => {
  const { ctl, sent } = setup();
  const sections = { "3d": { parts: ["a"], options: { format: "stl" } } };
  ctl.exportKit({ sections, sets: 2, onProgress: vi.fn() });
  expect(sent).toHaveLength(1);
  expect(sent[0].backend).toBe("manifold");
  expect(sent[0].msg).toEqual({ type: "export-kit", jobId: sent[0].msg.jobId, sections, sets: 2,
    view: "all", params: { t: 3 }, name: "My Part", quality: "print" });
  expect(sent[0].msg.jobId).toMatch(/^export-\d+-\d+$/);
});

test("a STEP 3D section routes the whole kit to occt", () => {
  const { ctl, sent } = setup();
  ctl.exportKit({ sections: { laser: { parts: ["p"] }, "3d": { parts: ["a"], options: { format: "step" } } } });
  expect(sent[0].backend).toBe("occt");
  ctl.exportKit({ sections: { laser: { parts: ["p"] } } });
  expect(sent[1].backend).toBe("manifold");
});

test("a kit reply calls the sink once and resolves; progress reaches onProgress", async () => {
  const { ctl, sent } = setup();
  const onProgress = vi.fn();
  const onKit = vi.fn();
  const onDownload = vi.fn();
  const done = ctl.exportKit({ sections: { "3d": { parts: ["a"] } }, onProgress });
  const { jobId } = sent[0].msg;
  expect(ctl.handleMessage({ type: "progress", phase: "building A", jobId }, onDownload, onKit)).toBe(true);
  expect(onProgress).toHaveBeenCalledWith("building A");
  expect(ctl.handleMessage({ type: "kit", jobId, name: "my-part", entries }, onDownload, onKit)).toBe(true);
  await expect(done).resolves.toBeUndefined();
  expect(onKit).toHaveBeenCalledTimes(1);
  expect(onKit).toHaveBeenCalledWith({ entries, name: "my-part" });
  expect(onDownload).not.toHaveBeenCalled();
});

test("an error reply rejects the kit", async () => {
  const { ctl, sent } = setup();
  const done = ctl.exportKit({ sections: { "3d": { parts: ["a"] } } });
  ctl.handleMessage({ type: "error", jobId: sent[0].msg.jobId, message: "cut kit options: no" }, vi.fn(), vi.fn());
  await expect(done).rejects.toThrow("cut kit options: no");
});

test("a kit reply for a controller job id nobody is waiting on is claimed and dropped", () => {
  const { ctl } = setup();
  const onKit = vi.fn();
  expect(ctl.handleMessage({ type: "kit", jobId: "export-999-1", name: "x", entries }, vi.fn(), onKit)).toBe(true);
  expect(onKit).not.toHaveBeenCalled();
});

test("dispose rejects a pending kit", async () => {
  const { ctl } = setup();
  const done = ctl.exportKit({ sections: { "3d": { parts: ["a"] } } });
  ctl.dispose("viewer disposed");
  await expect(done).rejects.toThrow("viewer disposed");
});

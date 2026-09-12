// The validating probe: run a part's build() with NO geometry kernel, recording op
// names and routing options-form calls through the same op-options normalizers the
// real backends use — so `k.cylinder({ radius: 5 })` is caught in microseconds with
// the existing did-you-mean message instead of after an 11 MB WASM boot.
import { expect, test } from "vitest";
import { createValidatingProbe, runValidatingProbe, ProbeRunawayError, MAX_PROBE_OPS }
  from "../src/framework/geometry/probe.js";
import { createProbeKernel } from "../src/framework/geometry/probe.js";
import { detectBackend } from "../src/framework/backend-select.js";

const partWith = (build) => ({
  defaults: {}, views: { main: {} },
  parts: { body: { views: ["main"], build } },
});

test("a valid build records calls and reports no issues", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ r: 5, h: 10 })), {}, {});
  expect(r.issues).toEqual([]);
  expect(r.throws).toEqual([]);
  expect(r.calls.map((c) => c.op)).toContain("cylinder");
});

test("an unknown kernel op is reported", () => {
  const r = runValidatingProbe(partWith((k) => k.cylindre({ r: 5, h: 10 })), {}, {});
  expect(r.issues).toContainEqual(expect.objectContaining({ kind: "unknown-op", scope: "kernel", op: "cylindre" }));
});

test("an unknown solid op is reported", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ r: 5, h: 10 }).tranlsate([1, 0, 0])), {}, {});
  expect(r.issues).toContainEqual(expect.objectContaining({ kind: "unknown-op", scope: "solid", op: "tranlsate" }));
});

test("an unknown option key is reported with the existing did-you-mean text", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ radius: 5, h: 10 })), {}, {});
  const issue = r.issues.find((i) => i.kind === "invalid-options");
  expect(issue.op).toBe("cylinder");
  expect(issue.message).toMatch(/did you mean r\?/);
});

test("a missing required option is reported", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ r: 5 })), {}, {});
  expect(r.issues.find((i) => i.kind === "invalid-options").message).toMatch(/h is required/);
});

test("a legacy positional call is recorded but not argument-validated", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder(5, 5, 10)), {}, {});
  expect(r.calls.map((c) => c.op)).toContain("cylinder");
  expect(r.issues).toEqual([]);
});

test("a throwing build is captured per sub-part instead of being swallowed", () => {
  const r = runValidatingProbe(partWith(() => { throw new Error("bad maths"); }), {}, {});
  expect(r.throws).toHaveLength(1);
  expect(r.throws[0]).toMatchObject({ subpart: "body", message: "bad maths" });
});

test("a runaway loop trips the op ceiling instead of hanging", () => {
  const r = runValidatingProbe(partWith((k) => { for (;;) k.box({ size: [1, 1, 1] }); }), {}, {}, { maxOps: 500 });
  expect(r.runaway).toBe(true);
  expect(r.calls.length).toBeLessThanOrEqual(501);
});

// Query calls (boundingBox/volume/toMesh/toSTL/toIndexedMesh/toSTEP/cleanup) used to
// bypass onCall's counter entirely — a query-only loop never tripped MAX_PROBE_OPS
// and hung forever, wedging the CLI and `measure` rather than just a terminable
// worker. This must be bounded exactly like any other op.
test("a query-only runaway loop trips the op ceiling instead of hanging", () => {
  const r = runValidatingProbe(
    partWith((k) => { const s = k.box({ size: [1, 1, 1] }); let _v = 0; for (;;) _v += s.volume(); }),
    {}, {}, { maxOps: 500 },
  );
  expect(r.runaway).toBe(true);
  expect(r.calls.length).toBeLessThanOrEqual(501);
});

test("MAX_PROBE_OPS is the documented ceiling", () => {
  expect(MAX_PROBE_OPS).toBe(100000);
});

test("the probe throws ProbeRunawayError past the ceiling", () => {
  const probe = createValidatingProbe({ maxOps: 2 });
  expect(() => { for (let i = 0; i < 5; i++) probe.kernel.box({ size: [1, 1, 1] }); })
    .toThrow(ProbeRunawayError);
});

test("recorded args are stable across two runs of the same pure build", () => {
  const build = (k, p) => k.cylinder({ r: p.r ?? 5, h: 10 }).translate([1, 2, 3]);
  const a = runValidatingProbe(partWith(build), { r: 5 }, {});
  const b = runValidatingProbe(partWith(build), { r: 5 }, {});
  expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
});

test("an impure build produces differing recordings", () => {
  const build = (k) => k.cylinder({ r: Math.random(), h: 10 });
  const a = runValidatingProbe(partWith(build), {}, {});
  const b = runValidatingProbe(partWith(build), {}, {});
  expect(JSON.stringify(a.calls)).not.toBe(JSON.stringify(b.calls));
});

test("a handle nested inside an options object records no toJSON op and no unknown-op issue", () => {
  const build = (k) => k.extrude({ profile: k.shape2d([[0, 0], [1, 0], [1, 1]]), h: 5 });
  const r = runValidatingProbe(partWith(build), {}, {});
  expect(r.calls.map((c) => c.op)).not.toContain("toJSON");
  expect(r.issues.filter((i) => i.kind === "unknown-op")).toEqual([]);
});

test("determinism holds when a build nests a handle inside an options object", () => {
  const build = (k) => k.extrude({ profile: k.shape2d([[0, 0], [1, 0], [1, 1]]), h: 5 });
  const a = runValidatingProbe(partWith(build), {}, {});
  const b = runValidatingProbe(partWith(build), {}, {});
  expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
});

// The pre-existing probe API must be untouched — detectBackend and the panel's
// relevance analysis both depend on it.
test("createProbeKernel still records op names for backend detection", () => {
  const { kernel, used } = createProbeKernel();
  kernel.cylinder({ r: 1, h: 1 }).fillet({ r: 1 });
  expect(used.has("cylinder")).toBe(true);
  expect(used.has("fillet")).toBe(true);
});

test("detectBackend still routes an OCCT-only op to occt", () => {
  expect(detectBackend(partWith((k) => k.box({ size: [1, 1, 1] }).shell({ t: 0.5, open: { dir: "Z" } })))).toBe("occt");
  expect(detectBackend(partWith((k) => k.box({ size: [1, 1, 1] })))).toBe("manifold");
});

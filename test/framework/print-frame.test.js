// @vitest-environment node
import { describe, expect, test } from "vitest";
import { printFrameMatrix } from "../../src/framework/materials/print-frame.js";
import { composePose } from "../../src/framework/geometry/pose.js";
import { probeSubPartPose } from "../../src/framework/pose-probe-core.js";
import { resolveParams } from "../../src/framework/part-model.js";
import lattice from "../fixtures/lattice-lid-part.js";

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

const box = (k) => k.box({ size: [10, 20, 30] });

test("no place() → identity", () => {
  expect(close(printFrameMatrix({ build: box }, { view: "v", p: {}, d: {} }), I)).toBe(true);
});

test("display stood up, export lying flat → display Z maps onto export's lateral axis", () => {
  const sp = {
    build: box,
    place: (s, { purpose }) => (purpose === "export" ? s.rotate(90, [0, 0, 0], [1, 0, 0]) : s),
  };
  const m = printFrameMatrix(sp, { view: "v", p: {}, d: {} });
  // A display-frame point 1mm up (+Z) is, in the export frame, rotated 90° about X: (0,-1,0).
  const q = apply(m, [0, 0, 1]);
  expect(q.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, -1, 0]);
});

test("identical display and export pose → identity even with a place()", () => {
  const sp = { build: box, place: (s) => s.translate([5, 0, 0]) };
  expect(close(printFrameMatrix(sp, { view: "v", p: {}, d: {} }), I)).toBe(true);
});

test("an untrusted probe falls back to identity", () => {
  const sp = { build: (k) => { const b = box(k); b.boundingBox(); return b; }, place: (s) => s.rotate(90, [0, 0, 0], [1, 0, 0]) };
  expect(close(printFrameMatrix(sp, { view: "v", p: {}, d: {} }), I)).toBe(true);
});

test("multiply order: display translate + export rotate → distinguishes E·D⁻¹ from D⁻¹·E", () => {
  const sp = {
    build: box,
    place: (s, { purpose }) =>
      purpose === "export"
        ? s.rotate(90, [0, 0, 0], [0, 0, 1]) // export: rotate 90° about Z
        : s.translate([10, 0, 0]),            // display: translate [10, 0, 0]
  };
  const m = printFrameMatrix(sp, { view: "v", p: {}, d: {} });
  // E·D⁻¹·[0,1,0]: E = rotate(90° Z), D⁻¹ = translate([-10,0,0])
  // E·D⁻¹ = [[0,-1,0,0], [1,0,0,-10], [0,0,1,0], [0,0,0,1]] (row-major)
  // Apply: [0, -1, 0, -10] · [0,1,0]ᵀ = [-1, -10, 0]
  // If swapped to D⁻¹·E: [[1,0,0,-10], [0,1,0,0], [0,0,1,0], [0,0,0,1]]·[[0,-1,0,0], [1,0,0,0], [0,0,1,0], [0,0,0,1]]
  // = [[0,-1,0,-10], [-1,0,0,0], [0,0,1,0], [0,0,0,1]] (wrong!)
  const q = apply(m, [0, 1, 0]);
  expect(q.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-1, -10, 0]);
});

describe("canonical deliveries (place-only pose)", () => {
  const at = (openAngle) => resolveParams(lattice, { ...lattice.defaults, openAngle });
  const insert = lattice.parts.insert;

  test("fixture as-is, frame canonical → composePose(place-scope export pose), non-identity", () => {
    const { p, d } = at(90);
    const exp = probeSubPartPose(insert, { view: "assembly", purpose: "export", p, d }, { scope: "place" });
    expect(exp.trusted).toBe(true);
    const m = printFrameMatrix(insert, { view: "assembly", p, d, frame: "canonical" });
    expect(close(m, composePose(exp.pose))).toBe(true);
    expect(close(m, I)).toBe(false);
  });

  test("a place that is identity on export → canonical frame is identity", () => {
    const { p, d } = at(90);
    const sp = { ...insert, place: (s, ctx) => (ctx.purpose === "export" ? s : insert.place(s, ctx)) };
    expect(close(printFrameMatrix(sp, { view: "assembly", p, d, frame: "canonical" }), I)).toBe(true);
  });

  test("canonical with an untrusted export place → identity", () => {
    const sp = { build: box, place: (s, ctx) => { if (ctx.purpose === "export") s.boundingBox(); return s.rotate(90, [0, 0, 0], [1, 0, 0]); } };
    expect(close(printFrameMatrix(sp, { view: "v", p: {}, d: {}, frame: "canonical" }), I)).toBe(true);
  });

  test("posed keeps the E·D⁻¹ rule, with frame given or omitted", () => {
    const sp = { build: box, place: (s, { purpose }) => (purpose === "export" ? s.rotate(90, [0, 0, 0], [1, 0, 0]) : s) };
    const omitted = printFrameMatrix(sp, { view: "v", p: {}, d: {} });
    const posed = printFrameMatrix(sp, { view: "v", p: {}, d: {}, frame: "posed" });
    expect(close(omitted, posed)).toBe(true);
    expect(apply(posed, [0, 0, 1]).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, -1, 0]);
  });
});

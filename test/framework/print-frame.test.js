// @vitest-environment node
import { expect, test } from "vitest";
import { printFrameMatrix } from "../../src/framework/materials/print-frame.js";

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

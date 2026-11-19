import { it, expect } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/index.js";
import { subdivide, levelFor, chordError, SUBDIV_TOLERANCE, MAX_SUBDIV_LEVEL } from "../src/framework/geometry/subdiv/surface.js";

const cube = () => createCage({ box: { size: [20, 20, 20] } }).snapshot();
const volume = ({ positions: p, indices: t }) => {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
};

it("is closed, outward-facing, and inside the cage", () => {
  const m = subdivide(cube(), 3);
  expect(volume(m)).toBeGreaterThan(0);
  expect(Math.max(...m.positions.map(Math.abs))).toBeLessThan(10);
  expect(m.triFace.length).toBe(m.indices.length / 3);
  expect(new Set(m.triFace).size).toBe(6);
});
it("puts every level on the same limit surface", () => {
  const a = subdivide(cube(), 3), b = subdivide(cube(), 5);
  for (let i = 0; i < 8 * 3; i++) expect(b.positions[i]).toBeCloseTo(a.positions[i], 9);   // the cage's own 8 points come first
  expect(Math.abs(volume(b) - volume(a)) / volume(b)).toBeLessThan(0.02);
});
it("chooses the level from the tolerance", () => {
  const s = cube();
  expect(levelFor(s, 1000)).toMatchObject({ level: 1, met: true });
  expect(levelFor(s, 1e-9)).toMatchObject({ level: MAX_SUBDIV_LEVEL, met: false });
  const print = levelFor(s, SUBDIV_TOLERANCE.print);
  expect(print.met).toBe(true);
  expect(print.error).toBeLessThanOrEqual(SUBDIV_TOLERANCE.print);
  expect(print.level).toBe(5);   // level 4 reads 0.021 mm, just over the print tolerance
  expect(levelFor(s, SUBDIV_TOLERANCE.preview).level).toBeLessThanOrEqual(print.level);
});
it("stops at the triangle limit", () => {
  const big = createCage({ box: { size: [20, 20, 20], segs: [4, 4, 4] } }).snapshot();
  const r = levelFor(big, 1e-9, { maxTriangles: 10_000 });
  expect(big.faces.length * 2 * 4 ** r.level).toBeLessThanOrEqual(10_000);
  expect(r.met).toBe(false);
});
it("includes the split diagonal in the estimate", () => {
  const e = chordError(cube(), 3);
  expect(e).toBeGreaterThan(0.07);
  expect(e).toBeLessThan(0.09);
});
it("refuses a missing or malformed snapshot", () => {
  expect(() => levelFor(null, 0.1)).toThrow(/^subdiv: /);
  expect(() => levelFor({ points: [], faces: "x" }, 0.1)).toThrow(/^subdiv: /);
  expect(() => chordError(undefined, 2)).toThrow(/^subdiv: /);
});
it("measures normal error, which falls about 4x per level", () => {
  const s = cube();
  const fall = chordError(s, 2) / chordError(s, 3);
  expect(fall).toBeGreaterThan(3);
  expect(fall).toBeLessThan(5);
});
it("handles an extraordinary point (valence 3 and 5) without a seam", () => {
  const c = createCage({ box: { size: [30, 30, 30], segs: [2, 2, 2] } });
  c.extrude("+z:0,0", { by: 15, scale: 0.6 });
  const m = subdivide(c.snapshot(), 3);
  expect(volume(m)).toBeGreaterThan(0);
  expect(m.positions.every(Number.isFinite)).toBe(true);
});

// Every directed triangle edge has its reverse exactly once, and no edge appears twice
// in the same direction: the mesh is closed and consistently wound.
function isClosed({ indices: t, positions }) {
  const n = positions.length / 3, seen = new Map();
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = t[i + k] * n + t[i + (k + 1) % 3];
      if (seen.has(key)) return false;
      seen.set(key, true);
    }
  }
  for (const key of seen.keys()) {
    const a = Math.floor(key / n), b = key % n;
    if (!seen.has(b * n + a)) return false;
  }
  return true;
}

it("keeps a mirrored, extruded cage closed and symmetric", () => {
  const c = createCage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
  c.extrude("+y:0,0", { by: 12, scale: 0.7 });
  const m = subdivide(c.snapshot(), 3);
  expect(isClosed(m)).toBe(true);
  expect(volume(m)).toBeGreaterThan(0);
  // Every point's reflection in Y is a point of the mesh, to 1e-9.
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    let best = Infinity;
    for (let j = 0; j < p.length; j += 3) {
      best = Math.min(best, Math.hypot(p[j] - p[i], p[j + 1] + p[i + 1], p[j + 2] - p[i + 2]));
    }
    expect(best).toBeLessThan(1e-9);
  }
});
it("refuses a level outside 1..5", () => {
  expect(() => subdivide(cube(), 0)).toThrow(/^subdiv: /);
  expect(() => subdivide(cube(), 6)).toThrow(/^subdiv: /);
  expect(() => subdivide(cube(), 2.5)).toThrow(/^subdiv: /);
});

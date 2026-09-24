import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { auditNormals, filletedBoxTruth } from "./helpers/normal-truth.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("sphere: analytic radial normals everywhere and ZERO edge segments", () => {
  const m = k.sphere({ r: 10 }).toMesh();
  expect(m.normals.length).toBe(m.positions.length);
  for (let i = 0; i < m.positions.length; i += 3) {
    const L = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]) || 1;
    const dot = (m.positions[i] * m.normals[i] + m.positions[i + 1] * m.normals[i + 1] + m.positions[i + 2] * m.normals[i + 2]) / L;
    expect(dot).toBeGreaterThan(0.999); // normal ∥ radius — smooth by construction
  }
  expect(m.edges.length).toBe(0); // seam meridian + pole edges all filtered
});

// Parity twin of mesh-fillet-normals.test.js: the B-rep fillet's analytic normals
// meet the same 0.1° bar the Manifold band now does, on the same box.
test("filleted box: every face, band and corner vertex within 0.1° of the analytic normal", () => {
  const { worst, at, judged } = auditNormals(k.box({ size: [30, 30, 12] }).fillet({ r: 3 }).toMesh(), filletedBoxTruth);
  expect(judged).toBeGreaterThan(500);
  expect(worst, `worst at ${at}`).toBeLessThan(0.1);
});

test("box: exactly 12 sharp edges, one straight segment each", () => {
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).toMesh();
  expect(m.edges.length).toBe(12 * 6);
});

test("internal spherical void adds no edge lines (phantom-sphere-edge regression)", () => {
  const solid = k.box({ min: [0, 0, 0], max: [20, 20, 20] })
    .cut(k.sphere({ r: 5 }).translate([10, 10, 10]));
  expect(solid.toMesh().edges.length).toBe(12 * 6); // the void's sphere face contributes nothing
});

test("fillet blend boundaries draw no lines; chamfer boundaries do", () => {
  const f = k.box({ min: [0, 0, 0], max: [20, 20, 20] }).fillet({ r: 3, edges: { dir: "Z" } }).toMesh();
  const c = k.box({ min: [0, 0, 0], max: [20, 20, 20] }).chamfer({ d: 3, edges: { dir: "Z" } }).toMesh();
  expect(f.edges.length).toBeGreaterThan(0);          // the unfilleted horizontal edges (+ sharp cap-transition arcs) remain
  // Isolate the vertical seams (the ONLY full-height, i.e. dz≈20, straight
  // runs — the horizontal cap edges/cuts/arcs all sit at a constant z). A raw
  // edges.length comparison is NOT a safe proxy here: fillet's cap-transition
  // is a curved arc that the (correct, and required by this task) finer
  // preview tessellation subdivides into many short segments, which swamps
  // any straight-segment count difference. Filtering to full-height runs
  // removes that tessellation-density confound and isolates exactly the
  // seam behavior this task fixes: fillet's seam is TANGENT (dropped, both
  // adjacent faces meet smoothly), chamfer's is a real dihedral angle (kept).
  const fullHeightSegments = (edges) => {
    let n = 0;
    for (let i = 0; i < edges.length; i += 6) if (Math.abs(edges[i + 2] - edges[i + 5]) > 15) n++;
    return n;
  };
  expect(fullHeightSegments(f.edges)).toBe(0); // fillet's 8 vertical seams are tangent — no lines
  expect(fullHeightSegments(c.edges)).toBe(8); // chamfer's 8 vertical seams are sharp — 2 lines per chamfered edge
});

test("posed toMesh rotates normals with the solid", () => {
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).rotate(45, [0, 0, 0], [0, 0, 1]).toMesh();
  let diagonal = false;
  for (let i = 0; i < m.normals.length; i += 3) {
    expect(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])).toBeCloseTo(1, 3);
    if (Math.abs(Math.abs(m.normals[i]) - Math.SQRT1_2) < 1e-3 &&
        Math.abs(Math.abs(m.normals[i + 1]) - Math.SQRT1_2) < 1e-3) diagonal = true;
  }
  expect(diagonal).toBe(true); // side normals sit at 45° — unrotated normals would stay axis-aligned
});

test("posed toMesh transforms edge segments like positions", () => {
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).translate([100, 0, 0]).toMesh();
  expect(m.edges.length).toBe(12 * 6);
  for (let i = 0; i < m.edges.length; i += 3) expect(m.edges[i]).toBeGreaterThanOrEqual(100);
});

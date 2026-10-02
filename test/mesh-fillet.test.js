// Mesh fillet/chamfer (Manifold backend) — tangent-wedge CSG for straight and
// circular-arc edge chains. Ground truth is analytic throughout:
//   straight fillet: removes (1 − π/4)·r² · L per edge
//   straight chamfer: removes d²/2 · L per edge (exact — no tessellation)
//   circular rim fillet: Pappus — removed area times the path of its centroid
// Watertightness is checked structurally (every welded edge borders 2 triangles).
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { detectSharpEdges, chainEdges } from "../src/framework/geometry/mesh-fillet.js";
import { KernelCapabilityError } from "../src/framework/geometry/errors.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const CORNER = (r) => (1 - Math.PI / 4) * r * r;
// centroid offset of the removed corner region (unit square minus quarter disc),
// measured from the corner along a flank — for Pappus on circular rims
const CORNER_XBAR = (0.5 - (Math.PI / 4) * (1 - 4 / (3 * Math.PI))) / (1 - Math.PI / 4);

function isWatertight({ positions, indices }) {
  const weld = new Map(), wid = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const key = `${Math.round(positions[i * 3] * 1e6)},${Math.round(positions[i * 3 + 1] * 1e6)},${Math.round(positions[i * 3 + 2] * 1e6)}`;
    if (!weld.has(key)) weld.set(key, weld.size);
    wid[i] = weld.get(key);
  }
  const count = new Map();
  for (let t = 0; t < indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const u = wid[indices[t + e]], v = wid[indices[t + ((e + 1) % 3)]];
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
  return [...count.values()].every((n) => n === 2);
}

const W = 40, D = 30, H = 16, R = 3;
const box = () => k.box({ min: [0, 0, 0], max: [W, D, H] });
const relErr = (v, expected) => Math.abs(v - expected) / Math.abs(expected);

function expectSmallCircularBlends(kernel, { filletTol, chamferTol }) {
  const a = 10, r = 0.01, d = 0.1;
  const cyl = kernel.cylinder({ r: a, h: H });
  const filleted = cyl.fillet({ r, edges: { inPlane: "XY", at: H } });
  const filletRemoved = 2 * Math.PI * (a - CORNER_XBAR * r) * CORNER(r);
  expect(filleted.genus(), "fillet genus").toBe(0);
  expect(relErr(cyl.volume() - filleted.volume(), filletRemoved), "fillet volume").toBeLessThan(filletTol);

  const chamfered = cyl.chamfer({ d, edges: { inPlane: "XY", at: H } });
  const chamferRemoved = 2 * Math.PI * (a - d / 3) * (d * d / 2);
  expect(chamfered.genus(), "chamfer genus").toBe(0);
  expect(relErr(cyl.volume() - chamfered.volume(), chamferRemoved), "chamfer volume").toBeLessThan(chamferTol);

  const stepped = kernel.cylinder({ r: a, h: H / 2 })
    .union(kernel.cylinder({ r: 6, h: H / 2 }).at([0, 0, H / 2]));
  const concave = stepped.chamfer({ d, edges: { near: [6, 0, H / 2] } });
  expect(concave.genus(), "concave chamfer genus").toBe(0);
}

describe("chain detection", () => {
  it("chains the 12 sharp edges of a box as straight convex chains", () => {
    const chains = chainEdges(detectSharpEdges(box().toIndexedMesh()));
    expect(chains).toHaveLength(12);
    expect(chains.every((c) => c.kind === "line" && c.convex)).toBe(true);
    const vertical = chains.filter((c) => Math.abs(c.dir[2]) > 0.999);
    expect(vertical).toHaveLength(4);
    expect(vertical.every((c) => Math.abs(c.length - H) < 1e-6)).toBe(true);
  });

  it("detects a bore rim as a single closed circular arc chain", () => {
    const bored = box().cut(k.cylinder({ d: 8, h: H + 2 }).at([W / 2, D / 2, -1]));
    const chains = chainEdges(detectSharpEdges(bored.toIndexedMesh()));
    const arcs = chains.filter((c) => c.kind === "arc");
    expect(arcs).toHaveLength(2); // top and bottom rims of the through-bore
    for (const arc of arcs) {
      expect(arc.closed).toBe(true);
      expect(arc.R).toBeCloseTo(4, 1);
      expect(Math.abs(arc.w[2])).toBeCloseTo(1, 6);
    }
  });

  it("refuses the arc fit for a rim that only APPROXIMATES a circle", () => {
    // an offset outline after simplify(): near-circular to a few µm, but not a circle.
    // The arc chain's revolve tool follows the FITTED circle, so any real deviation
    // becomes tangent-seam jitter along the whole run (measured: a label backing drew
    // hundreds of band-edge lines from two such pseudo-arcs). These rims must fall
    // through to the planar-path rescue, whose sweep follows the true polyline.
    const pts = [];
    const n = 200, R = 8;
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const rr = R + 0.0025 * Math.sin(9 * th + 1); // ±2.5 µm — inside the old 1e-3·R fit
      pts.push([20 + rr * Math.cos(th), 15 + rr * Math.sin(th)]);
    }
    const solid = k.extrude({ profile: pts, h: 8 });
    const chains = chainEdges(detectSharpEdges(solid.toIndexedMesh()));
    expect(chains.filter((c) => c.kind === "arc")).toHaveLength(0);
    expect(chains.filter((c) => c.kind === "planar")).not.toHaveLength(0);
  });
});

describe("straight-edge fillet", () => {
  it("fillets the four vertical edges at the exact rolling-ball volume", () => {
    const out = box().fillet({ r: R, edges: { dir: "Z" } });
    expect(relErr(out.volume(), W * D * H - 4 * CORNER(R) * H)).toBeLessThan(2e-3);
    expect(out.genus()).toBe(0);
    expect(isWatertight(out.toIndexedMesh())).toBe(true);
  });

  it("fillets a single edge picked with near", () => {
    const out = box().fillet({ r: R, edges: { dir: "Z", near: [0, 0, H / 2] } });
    expect(relErr(out.volume(), W * D * H - CORNER(R) * H)).toBeLessThan(2e-3);
    expect(isWatertight(out.toIndexedMesh())).toBe(true);
  });
});

describe("circular-arc fillet (revolve cutters)", () => {
  it("small circular blends preserve topology at preview quality", () => {
    // At r=.01 the preview circle's 0.0037 mm facet sag is a substantial
    // fraction of the feature; topology is exact, feature volume is LOD-bound.
    expectSmallCircularBlends(k, { filletTol: 0.35, chamferTol: 0.1 });
  });

  it("small circular blends preserve topology at print quality", async () => {
    expectSmallCircularBlends(await bootManifoldKernel({ quality: "print" }), { filletTol: 0.1, chamferTol: 0.02 });
  });

  it("fillets a full bore rim at the Pappus torus volume", () => {
    const a = 4, r = 1;
    const bored = box().cut(k.cylinder({ d: 2 * a, h: H + 2 }).at([W / 2, D / 2, -1]));
    const out = bored.fillet({ r, edges: { near: [W / 2 + a, D / 2, H] } });
    const removed = 2 * Math.PI * (a + CORNER_XBAR * r) * CORNER(r);
    const before = bored.volume();
    expect(relErr(before - out.volume(), removed)).toBeLessThan(1e-2);
    // closure via genus, not the 1e-6-weld isWatertight: in-plane rims are now SWEPT
    // along their own polyline (planarizeArc), and swept vertices are not float32-exact
    // the way a posed revolve's were — the strict weld check false-negatives on them
    // (the same reason mesh-fillet-planar.test.js uses genus throughout)
    expect(out.genus()).toBe(1);
  });

  it("fillets a cylinder's top rim (outer closed arc, material inside)", () => {
    const a = 10, r = 2;
    const cyl = k.cylinder({ d: 2 * a, h: H });
    const out = cyl.fillet({ r, edges: { inPlane: "XY", at: H } });
    // Pappus: centroid sits INSIDE the rim now, at a − x̄·r
    const removed = 2 * Math.PI * (a - CORNER_XBAR * r) * CORNER(r);
    expect(relErr(cyl.volume() - out.volume(), removed)).toBeLessThan(1e-2);
    expect(out.genus()).toBe(0); // genus, not isWatertight — swept rim, see bore rim note
  });

  it("matches analytic near points anywhere on a circular edge", () => {
    const a = 10, r = 1;
    const cyl = k.cylinder({ r: a, h: H });
    const filletAt = (deg) => {
      const th = (deg * Math.PI) / 180;
      return cyl.fillet({ r, edges: { near: [a * Math.cos(th), a * Math.sin(th), H] } });
    };
    const reference = filletAt(0);
    for (const deg of [30, 45]) {
      const out = filletAt(deg);
      expect(out.genus(), `${deg}°`).toBe(0);
      expect(out.volume(), `${deg}°`).toBeCloseTo(reference.volume(), 6);
    }
  });

  it("handles the filleted-box sequence with quarter-arc corners cleanly", () => {
    // vertical fillets create quarter-circle rim arcs; the rim fillet must chain
    // them as arcs (4 revolve cutters), not ~29 per-facet prisms each
    let s = box();
    s = s.fillet({ r: R, edges: { dir: "Z" } });
    const chains = chainEdges(detectSharpEdges(s.toIndexedMesh()));
    const rim = chains.filter((c) => c.points.every((p) => Math.abs(p[2] - H) < 1e-4));
    expect(rim.filter((c) => c.kind === "arc")).toHaveLength(4);
    expect(rim.filter((c) => c.kind === "line")).toHaveLength(4);
    for (const c of rim.filter((c) => c.kind === "arc")) expect(c.R).toBeCloseTo(R, 2);
    s = s.fillet({ r: 2, edges: { inPlane: "XY", at: H } });
    s = s.cut(k.cylinder({ d: 8, h: H + 2 }).at([W / 2, D / 2, -1]));
    // OCCT native fillet reference volume for the same geometry: 18158.795
    expect(relErr(s.volume(), 18158.795)).toBeLessThan(2e-3);
    expect(s.genus()).toBe(1); // genus, not isWatertight — swept rim, see bore rim note
  });
});

describe("spherical corner patches", () => {
  it("fillets all 12 box edges with sphere-octant corners, matching roundedBox", () => {
    const r = 3;
    const out = box().fillet(r); // scalar shorthand: all edges
    const reference = k.roundedBox({ size: [W, D, H], round: r });
    expect(relErr(out.volume(), reference.volume())).toBeLessThan(5e-3);
    expect(out.genus()).toBe(0);
    expect(isWatertight(out.toIndexedMesh())).toBe(true);
  });

  it("leaves partial selections mitre-free of corner patches (vertical only)", () => {
    // only 1 selected chain meets each top vertex — no patch, volume unchanged
    // from the straight-edge analytic value
    const out = box().fillet({ r: R, edges: { dir: "Z" } });
    expect(relErr(out.volume(), W * D * H - 4 * CORNER(R) * H)).toBeLessThan(2e-3);
  });
});

describe("concave fillet (union-side filler)", () => {
  const LShape = () => box().union(k.box({ min: [0, 0, H], max: [W / 2, D, 2 * H] }));

  it("fills a reentrant edge with the rolling-ball volume", () => {
    const L = LShape();
    const out = L.fillet({ r: R, edges: { near: [W / 2, D / 2, H] } });
    expect(relErr(out.volume() - L.volume(), CORNER(R) * D)).toBeLessThan(2e-3);
    expect(out.volume()).toBeGreaterThan(L.volume());
    expect(out.genus()).toBe(0);
    expect(isWatertight(out.toIndexedMesh())).toBe(true);
  });
});

describe("chamfer", () => {
  it("chamfers the four vertical edges exactly (no tessellation error)", () => {
    const d = 3;
    const out = box().chamfer({ d, edges: { dir: "Z" } });
    expect(relErr(out.volume(), W * D * H - 4 * (d * d / 2) * H)).toBeLessThan(1e-6);
    expect(isWatertight(out.toIndexedMesh())).toBe(true);
  });

  it("chamfers a concave edge exactly", () => {
    const L = box().union(k.box({ min: [0, 0, H], max: [W / 2, D, 2 * H] }));
    const d = 2;
    const out = L.chamfer({ d, edges: { near: [W / 2, D / 2, H] } });
    expect(relErr(out.volume() - L.volume(), (d * d / 2) * D)).toBeLessThan(1e-6);
    expect(isWatertight(out.toIndexedMesh())).toBe(true);
  });

  it("chamfers a bore rim (closed arc)", () => {
    const a = 4, d = 1;
    const bored = box().cut(k.cylinder({ d: 2 * a, h: H + 2 }).at([W / 2, D / 2, -1]));
    const out = bored.chamfer({ d, edges: { near: [W / 2 + a, D / 2, H] } });
    // Pappus for the removed triangle (area d²/2, centroid d/3 outward from the rim)
    const removed = 2 * Math.PI * (a + d / 3) * (d * d / 2);
    expect(relErr(bored.volume() - out.volume(), removed)).toBeLessThan(1e-2);
    expect(out.genus()).toBe(1); // genus, not isWatertight — swept rim, see bore rim note
  });
});

describe("errors and selectors", () => {
  it("throws UnsupportedEdgeError for empty selections and function selectors", () => {
    expect(() => box().fillet({ r: R, edges: { dir: "Z", near: [999, 999, 999] } }))
      .toThrow(KernelCapabilityError);
    expect(() => box().fillet(R, () => {}))
      .toThrow(/OCCT backend/);
  });

  it("dir never matches arc chains (replicad inDirection parity)", () => {
    const bored = box().cut(k.cylinder({ d: 8, h: H + 2 }).at([W / 2, D / 2, -1]));
    const out = bored.fillet({ r: R, edges: { dir: "Z" } });
    // only the 4 vertical edges filleted; both bore rims untouched
    expect(relErr(bored.volume() - out.volume(), 4 * CORNER(R) * H)).toBeLessThan(2e-3);
  });
});

// A face-plane circular rim whose radius approaches the fillet's own (a boss top rounded
// almost to a dome) used to planarize into the swept tool, whose fold guard then split
// the circle at EVERY vertex once r ≳ 0.82·R. The per-vertex tools' coincident mitre caps
// left a zero-thickness sheet per facet inside the band — drawn by the line overlay as a
// dashed ring around the middle of the fillet, carried into exports — and near r ≈ R the
// result stopped being a valid solid at all (genus 37 at r = 2.9 on R = 3). Such a rim
// stays on the revolve tool, which follows the circle in one piece.
describe("face-plane rim tighter than the planar sweep can follow", () => {
  const R = 3, H = 30;
  // drawn segments lying on the band surface strictly between its two boundary lines
  const bandLines = (out, r) => {
    const { edges } = out.toMesh();
    let n = 0;
    for (let i = 0; i + 5 < edges.length; i += 6) {
      const m = [0, 1, 2].map((j) => (edges[i + j] + edges[i + 3 + j]) / 2);
      const rho = Math.hypot(m[0], m[1]);
      if (m[2] < H - r - 0.05) continue;
      if (Math.abs(Math.hypot(rho - (R - r), m[2] - (H - r)) - r) > 0.05) continue;
      const a = (Math.atan2(m[2] - (H - r), rho - (R - r)) * 180) / Math.PI;
      if (a > 5 && a < 85) n++;
    }
    return n;
  };
  // Pappus: spandrel area (1 − π/4)·r² at centroid radius R − r·(10 − 3π)/(12 − 3π)
  const removed = (r) => (1 - Math.PI / 4) * r * r * 2 * Math.PI * (R - (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI));
  for (const r of [2.5, 2.75]) {
    it(`r = ${r} on R = ${R}: one clean band, exact volume`, () => {
      const cyl = k.cylinder({ r: R, h: H });
      const out = cyl.fillet({ r, edges: { inPlane: "XY", at: H } });
      expect(out.genus()).toBe(0);
      expect(bandLines(out, r)).toBe(0);
      expect(Math.abs(cyl.volume() - out.volume() - removed(r)) / removed(r)).toBeLessThan(0.002);
    });
  }
  it("a radius the revolve cannot fit either refuses rather than building a broken solid", () => {
    const cyl = k.cylinder({ r: R, h: H });
    expect(() => cyl._filletRaw(2.9, { inPlane: "XY", at: H })).toThrow(KernelCapabilityError);
  });
});

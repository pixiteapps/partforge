// Kernel-side half of the *Profile = exact curves rule, on the mesh backend:
//   - a prism of a curve helper is faceted by the kernel per tier (finer at print),
//     where its *Polygon twin keeps the facets it was written with on both tiers;
//   - revolve takes a {start, segments} contour directly (it used to demand a
//     k.shape2d lift first), so a curve helper works everywhere a point list does;
//   - a partial revolve spends the circle count in proportion to its sweep, not a
//     whole circle's worth on a 36° sliver.
// Boots its own wasm (the print-quality-segments idiom) so both tiers share a module.
import { beforeAll, describe, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { SEGS } from "../src/framework/geometry/circle-segs.js";
import { ringSectorPolygon, ringSectorProfile, pathProfile } from "../src/framework/geometry/polygon.js";

let preview, print;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  preview = createManifoldKernel(wasm, { quality: "preview" });
  print = createManifoldKernel(wasm, { quality: "print" });
});

const tris = (solid) => solid.toMesh().triangles;

// Widest angular gap between vertices lying on the circle of radius R about the Z axis.
function maxFacetDeg(solid, R) {
  const { positions } = solid.toMesh();
  const angles = new Set();
  for (let i = 0; i < positions.length; i += 3) {
    const r = Math.hypot(positions[i], positions[i + 1]);
    if (Math.abs(r - R) < 1e-4) angles.add(Math.atan2(positions[i + 1], positions[i]).toFixed(7));
  }
  const sorted = [...angles].map(Number).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i] - sorted[i - 1]);
  return (gap * 180) / Math.PI;
}

describe("a curve helper is faceted by the kernel; its *Polygon twin is not", () => {
  // A 36° bayonet lug at r 28–30 mm — the part behind partforge-cloud feedback #144.
  const lug = (k, pts) => k.prism({ points: pts, h: 2 });

  test("ringSectorPolygon keeps its 9° facets on both tiers", () => {
    expect(maxFacetDeg(lug(preview, ringSectorPolygon(28, 30, 36)), 30)).toBeCloseTo(9, 3);
    expect(maxFacetDeg(lug(print, ringSectorPolygon(28, 30, 36)), 30)).toBeCloseTo(9, 3);
  });

  test("ringSectorProfile facets at the circle rule and gets finer at print", () => {
    const pv = maxFacetDeg(lug(preview, ringSectorProfile(28, 30, 36)), 30);
    const pr = maxFacetDeg(lug(print, ringSectorProfile(28, 30, 36)), 30);
    expect(pv).toBeLessThanOrEqual(360 / SEGS.preview + 1e-6);   // ≈ 3.1° at preview
    expect(pr).toBeLessThan(pv);                                 // refined for export
    // print's chord tolerance: sagitta r·(1 − cos(θ/2)) under 0.01 mm at r = 30
    expect(30 * (1 - Math.cos(((pr / 2) * Math.PI) / 180))).toBeLessThan(0.01);
  });

  test("the curve lug has the exact volume the facets under-fill", () => {
    const exact = 0.5 * (30 ** 2 - 28 ** 2) * ((36 * Math.PI) / 180) * 2;
    const curve = lug(print, ringSectorProfile(28, 30, 36)).volume();
    const facets = lug(print, ringSectorPolygon(28, 30, 36)).volume();
    expect(Math.abs(curve - exact) / exact).toBeLessThan(1e-3);
    expect(facets).toBeLessThan(curve);
  });
});

describe("revolve takes a path contour directly", () => {
  // A lathe profile with a rounded top corner, as a pathProfile contour in [r, z].
  const lathe = () => pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 8])
    .arcTo([8, 10], { r: 2 }).lineTo([0, 10]).close();

  test("a contour revolves exactly as its k.shape2d lift does", () => {
    for (const k of [preview, print]) {
      const direct = k.revolve({ profile: lathe() });
      const lifted = k.revolve({ profile: k.shape2d(lathe()) });
      expect(direct.volume()).toBeCloseTo(lifted.volume(), 9);
      expect(tris(direct)).toBe(tris(lifted));
    }
  });

  test("the positional form lifts too, and degrees still apply", () => {
    const half = preview.revolve(lathe(), { degrees: 180 });
    const full = preview.revolve(lathe());
    expect(half.volume()).toBeCloseTo(full.volume() / 2, 6);
  });
});

describe("a partial revolve spends the circle count in proportion to its sweep", () => {
  // 4-edge profile: 8 triangles per slice, plus 2 × 2 cap triangles on a partial sweep.
  const quad = [[28, 0], [30, 0], [30, 2], [28, 2]];

  test("a full revolve is unchanged", () => {
    expect(tris(preview.revolve({ profile: quad }))).toBe(8 * SEGS.preview);
  });

  test("36° gets ceil(circle × 36/360) slices at preview, not a whole circle's", () => {
    const slices = Math.ceil((SEGS.preview * 36) / 360);   // 12
    expect(tris(preview.revolve({ profile: quad, degrees: 36 }))).toBe(8 * slices + 4);
    expect(maxFacetDeg(preview.revolve({ profile: quad, degrees: 36 }), 30)).toBeLessThanOrEqual(360 / SEGS.preview + 1e-6);
  });

  test("a Shape2D partial revolve scales the same way", () => {
    const slices = Math.ceil((SEGS.preview * 90) / 360);
    expect(tris(preview.revolve({ profile: preview.shape2d(quad), degrees: 90 }))).toBe(8 * slices + 4);
  });

  test("a tiny sweep still gets a valid slice count", () => {
    const s = preview.revolve({ profile: quad, degrees: 1 });
    expect(s.volume()).toBeGreaterThan(0);
  });

  test("an explicit segs override is honoured exactly, never rescaled", () => {
    // mesh-fillet sizes its blend tools itself and relies on the exact count.
    expect(tris(preview.revolve(quad, { degrees: 36, segs: 20 }))).toBe(8 * 20 + 4);
  });
});

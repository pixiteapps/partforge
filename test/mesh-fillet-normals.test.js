// Mesh fillet shading: a Manifold fillet band ships the ANALYTIC normals of its
// rolling-ball surface (blend-surfaces.js), so it shades continuously into the faces
// it is tangent to — no lighting step at the band boundary, between band facets, or
// where three bands meet at a box corner — while real edges stay hard.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { invertAffine, runEvaluator, surfaceNormal, mapSurface } from "../src/framework/geometry/blend-surfaces.js";
import { auditNormals, coincidentSpread, filletedBoxTruth } from "./helpers/normal-truth.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const box = () => k.box({ size: [30, 30, 12] }).fillet({ r: 3 });
const withHole = () => box().cut(k.cylinder({ r: 5, h: 20 }).translate([0, 0, -4]));

describe("filleted box shades with the true rolling-ball normals", () => {
  test("every face, band and corner vertex is within 0.1° of the analytic normal", () => {
    // before: 9° at the corners and ~2.4° at the band's tangent boundary
    const { worst, at, judged } = auditNormals(box().toMesh(), filletedBoxTruth);
    expect(judged).toBeGreaterThan(2000);
    expect(worst, `worst at ${at}`).toBeLessThan(0.1);
  });

  test("coincident vertices on tangent-continuous joins agree within 0.1°", () => {
    // fillet↔face and fillet↔fillet facet seams, and fillet↔sphere at the corners
    const { smooth } = coincidentSpread(box().toMesh());
    expect(smooth).toBeLessThan(0.1);
  });

  test("the micro-ledges where a corner sphere meets its edge bands shade with the band", () => {
    // the corner patch is buried a hair on purpose, leaving a step ≤ 12 µm tall whose
    // triangles face 90° off the band; auditNormals skips them as geometry, so judge
    // every corner here against the band's truth instead — a ledge shaded with its
    // own facet drew a hairline around every corner on mirror materials
    const m = box().toMesh(), P = m.positions, N = m.normals;
    let ledges = 0;
    for (let t = 0; t < m.triangles; t++) {
      const o = t * 9;
      const g = [0, 1, 2].map((j) => (P[o + j] + P[o + 3 + j] + P[o + 6 + j]) / 3);
      const u = [0, 1, 2].map((j) => P[o + 3 + j] - P[o + j]), v = [0, 1, 2].map((j) => P[o + 6 + j] - P[o + j]);
      const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const tg = filletedBoxTruth(g), cr = Math.hypot(...f);
      if (!tg || !(cr > 0) || (f[0] * tg[0] + f[1] * tg[1] + f[2] * tg[2]) / cr > 0.5) continue; // ledges only
      ledges++;
      for (let c = 0; c < 3; c++) {
        const i = o + c * 3, tn = filletedBoxTruth([P[i], P[i + 1], P[i + 2]].map((q, j) => q + 1e-2 * (g[j] - q)));
        if (tn) expect(N[i] * tn[0] + N[i + 1] * tn[1] + N[i + 2] * tn[2]).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
      }
    }
    expect(ledges).toBeGreaterThan(100); // the fixture still has them — else this test proves nothing
  });

  test("a cut hole's rim stays hard", () => {
    const m = withHole().toMesh();
    const { worst } = auditNormals(m, filletedBoxTruth);
    expect(worst).toBeLessThan(0.1);
    // on the rim (ρ = 5, top and bottom faces) the face side is exactly vertical and
    // the bore side exactly horizontal — nothing averaged across the 90° edge
    const onRim = (x) => Math.abs(Math.hypot(x[0], x[1]) - 5) < 1e-3 && (x[2] < 1e-3 || x[2] > 12 - 1e-3);
    const { hardPairs } = coincidentSpread(m, { where: onRim });
    expect(hardPairs).toBeGreaterThan(20);
    const P = m.positions, N = m.normals;
    let rimCorners = 0;
    for (let c = 0; c < m.triangles * 3; c++) {
      if (!onRim([P[c * 3], P[c * 3 + 1], P[c * 3 + 2]])) continue;
      rimCorners++;
      const nz = Math.abs(N[c * 3 + 2]);
      expect(Math.min(nz, Math.hypot(N[c * 3], N[c * 3 + 1])), `rim normal ${[N[c * 3], N[c * 3 + 1], N[c * 3 + 2]]}`).toBeLessThan(0.002);
    }
    expect(rimCorners).toBeGreaterThan(40);
  });

  test("the analytic normals survive label() and a later pose", () => {
    // label() re-stamps surface ids and rotate() moves the run transforms; both
    // must carry the band descriptors along (the box is symmetric under the turn)
    const m = box().label("body").rotate(90, [0, 0, 0], [0, 0, 1]).toMesh();
    expect(auditNormals(m, filletedBoxTruth).worst).toBeLessThan(0.1);
  });
});

test("a bore-rim fillet (planar arc chain) shades as the smooth torus it samples", () => {
  // bore r = 5 through a 12 mm plate, top rim rounded r = 1.5: ball centres on the
  // circle ρ = 6.5, z = 10.5 — the band's polyline azimuth must NOT shade faceted
  const s = k.box({ size: [30, 30, 12] }).cut(k.cylinder({ r: 5, h: 20 }).translate([0, 0, -4]))
    .fillet({ r: 1.5, edges: { inPlane: "XY", at: 12, near: [5, 0] } });
  const { worst, judged } = auditNormals(s.toMesh(), (x) => {
    const rho = Math.hypot(x[0], x[1]);
    if (rho > 6.6 || x[2] < 10.4) return null;
    const d = [x[0] - (6.5 * x[0]) / rho, x[1] - (6.5 * x[1]) / rho, x[2] - 10.5];
    const L = Math.hypot(...d);
    return d.map((q) => q / L);
  });
  expect(judged).toBeGreaterThan(1000);
  expect(worst).toBeLessThan(0.1);
});

test("a concave (filler) fillet shades with its cylinder's normals", () => {
  const L = k.union([k.box({ min: [0, 0, 0], max: [20, 10, 10] }), k.box({ min: [0, 0, 0], max: [10, 10, 20] })]);
  const { worst, judged } = auditNormals(L.fillet({ r: 2, edges: { dir: "Y", near: [10, 5, 10] } }).toMesh(), (x) => {
    if (x[0] < 9.999 || x[2] < 9.999 || x[0] > 12.001 || x[2] > 12.001 || x[1] < 0.001 || x[1] > 9.999) return null;
    const d = [12 - x[0], 0, 12 - x[2]], l = Math.hypot(...d);
    return d.map((q) => q / l);
  });
  expect(judged).toBeGreaterThan(20);
  expect(worst).toBeLessThan(0.1);
});

describe("blend-surfaces (pure)", () => {
  test("invertAffine inverts a posed, scaled, mirrored 3×4", () => {
    // column-major: X → 2·Y, Y → −X, Z → −Z (mirror), then translate
    const M = [0, 2, 0, -1, 0, 0, 0, 0, -1, 3, -4, 5];
    const inv = invertAffine(M);
    const ap = (A, p) => [0, 1, 2].map((r) => A[r] * p[0] + A[3 + r] * p[1] + A[6 + r] * p[2] + A[9 + r]);
    const p = [0.3, -1.7, 2.2];
    ap(inv, ap(M, p)).forEach((q, i) => expect(q).toBeCloseTo(p[i], 12));
  });

  test("runEvaluator follows a non-uniform affine (inverse-transpose normals)", () => {
    // unit cylinder about Z, stretched ×2 along X: the image is an elliptic cylinder
    // x²/4 + y² = 1, whose normal at (2cosθ, sinθ) is ∝ (cosθ/2, sinθ)
    const ev = runEvaluator({ kind: "line", p: [0, 0, 0], d: [0, 0, 1] }, [2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const th = 0.7, n = ev([2 * Math.cos(th), Math.sin(th), 5]);
    const want = [Math.cos(th) / 2, Math.sin(th), 0], L = Math.hypot(...want);
    n.forEach((q, i) => expect(q).toBeCloseTo(want[i] / L, 12));
  });

  test("circle spines give torus normals; a descriptor maps rigidly", () => {
    const torus = { kind: "circle", c: [0, 0, 1], a: [0, 0, 1], R: 4 };
    const n = surfaceNormal(torus, [5, 0, 2]); // spine point (4,0,1)
    n.forEach((q, i) => expect(q).toBeCloseTo([1, 0, 1][i] / Math.SQRT2, 12));
    const moved = mapSurface(torus, [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0]); // +10 X
    surfaceNormal(moved, [15, 0, 2]).forEach((q, i) => expect(q).toBeCloseTo(n[i], 12));
  });
});

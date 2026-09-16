// The mesh backend's print tier sizes circles by chord tolerance, not by a flat count.
//
// Before this rule the print kernel meshed EVERY circle at 480 segments whatever its
// radius: a 0.75 mm rivet sphere became 115,200 triangles (chord sagitta 1.6e-5 mm,
// a thousandth of anything a printer resolves), and a part carrying 176 of them —
// 20 M triangles of rivets before any boolean, on a body whose whole unioned preview
// was 530k — trapped the WASM kernel with "memory access out of bounds" on its first
// STL export, on a fresh 4 GB instance. The rule here is the
// one `roundAllSegs` and mesh-fillet's `blendSegs` already use: the fewest segments
// that keep the sagitta under the tier's tolerance, floored at the preview count so
// an export is never coarser than the preview the user approved, and capped at the
// old flat count so large circles keep exactly the density they had.
//
// Boots its own wasm instance (the mesh-roundall idiom) because the print-quality
// kernel is not what bootManifoldKernel returns and both tiers must share one
// module to prove the comparison is apples to apples.
import { beforeAll, describe, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { circleSegs, SEGS, SAGITTA_TOL, doubleCurvatureSegs, DOUBLE_CURVATURE_FLOOR, DOUBLE_CURVATURE_SAGITTA_TOL } from "../src/framework/geometry/circle-segs.js";
import { sampleArc, sampleBezier, tessellateContour } from "../src/framework/geometry/profile.js";
import { roundedBoxArcSamples } from "../src/framework/geometry/rounded-solids.js";

let preview, print;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  preview = createManifoldKernel(wasm, { quality: "preview" });
  print = createManifoldKernel(wasm, { quality: "print" });
});

const tris = (solid) => solid.toMesh().triangles;
const sagitta = (r, n) => r * (1 - Math.cos(Math.PI / n));

// A full circle of radius r as two three-point arcs — the contour form roundedProfile
// and pathProfile().arcTo emit, with no helper in between.
const circleContour = (r) => ({
  start: [r, 0],
  segments: [{ to: [-r, 0], via: [0, r] }, { to: [r, 0], via: [0, -r] }],
});

// A quarter circle of radius r as a cubic Bézier (the standard kappa fit).
const quarterCubic = (r) => {
  const kappa = 0.5522847498;
  return [[r, 0], [r, r * kappa], [r * kappa, r], [0, r]];
};

describe("circleSegs", () => {
  test("the preview tier is flat: every radius gets the preview count", () => {
    for (const r of [0.01, 0.75, 20, 136, 1000, Infinity]) expect(circleSegs(r, "preview")).toBe(SEGS.preview);
  });

  test("the print tier is the fewest segments under the tolerance, floored at preview and capped at the old count", () => {
    expect(SAGITTA_TOL.print).toBe(0.01);
    expect(circleSegs(0.75, "print")).toBe(SEGS.preview);   // a rivet: never coarser than the preview
    expect(circleSegs(19.5, "print")).toBe(SEGS.preview);   // 99 would hold 0.01 mm, but the preview floor wins
    expect(circleSegs(27, "print")).toBe(SEGS.preview);     // the radius where 116 meets the tolerance exactly
    expect(circleSegs(50, "print")).toBe(158);              // above the floor: the fewest that hold 0.01 mm
    expect(circleSegs(500, "print")).toBe(SEGS.print);      // a metre-scale circle keeps the old flat count
  });

  test("print sizing holds the tolerance wherever it is below the cap", () => {
    let prev = 0;
    for (let r = 0.05; r <= 600; r *= 1.07) {
      const n = circleSegs(r, "print");
      expect(n).toBeGreaterThanOrEqual(SEGS.preview);
      expect(n).toBeLessThanOrEqual(SEGS.print);
      expect(n).toBeGreaterThanOrEqual(prev);            // monotone in r
      if (n < SEGS.print) expect(sagitta(r, n)).toBeLessThanOrEqual(SAGITTA_TOL.print + 1e-12);
      prev = n;
    }
  });

  test("a degenerate radius takes the floor rather than throwing or returning NaN", () => {
    for (const r of [0, -1, NaN, undefined, null]) expect(circleSegs(r, "print")).toBe(SEGS.preview);
    expect(circleSegs(Infinity, "print")).toBe(SEGS.print);
  });

  test("an unknown tier behaves as preview", () => {
    expect(circleSegs(300, "nonsense")).toBe(SEGS.preview);
  });
});

describe("doubleCurvatureSegs", () => {
  // A doubly-curved surface spends the per-circle count squared (Manifold.sphere is
  // 8·(n/4)² triangles; a lathe's profile arcs multiply its sweep; a rounded box's
  // corners are sphere octants), so that family is sized by tolerance on BOTH tiers.
  test("the preview tier holds its sagitta between the floor and the flat cap", () => {
    expect(DOUBLE_CURVATURE_SAGITTA_TOL.preview).toBe(0.02);
    expect(DOUBLE_CURVATURE_FLOOR).toBe(24);
    expect(doubleCurvatureSegs(0.75, "preview")).toBe(DOUBLE_CURVATURE_FLOOR); // a rivet: the floor, 288 triangles instead of 6,728
    expect(doubleCurvatureSegs(4, "preview")).toBe(32);               // a goggle eye
    expect(doubleCurvatureSegs(10, "preview")).toBe(50);
    expect(doubleCurvatureSegs(60, "preview")).toBe(SEGS.preview);    // from here up, exactly the old flat count
    expect(doubleCurvatureSegs(300, "preview")).toBe(SEGS.preview);
  });

  test("the print tier is never coarser than the preview and never finer than the old cap", () => {
    expect(DOUBLE_CURVATURE_SAGITTA_TOL.print).toBe(SAGITTA_TOL.print);
    expect(doubleCurvatureSegs(0.75, "print")).toBe(doubleCurvatureSegs(0.75, "preview")); // a rivet exports at its preview density
    expect(doubleCurvatureSegs(10, "print")).toBe(71);                                // 0.01 mm at r = 10, above the preview's 50
    expect(doubleCurvatureSegs(300, "print")).toBe(circleSegs(300, "print"));        // large spheres follow the circle rule
    expect(doubleCurvatureSegs(Infinity, "print")).toBe(SEGS.print);
  });

  test("sphere sizing holds the tolerance wherever it is between its clamps, monotone in r", () => {
    for (const tier of ["preview", "print"]) {
      let prev = 0;
      for (let r = 0.05; r <= 600; r *= 1.07) {
        const n = doubleCurvatureSegs(r, tier);
        expect(n).toBeGreaterThanOrEqual(DOUBLE_CURVATURE_FLOOR);
        expect(n).toBeLessThanOrEqual(SEGS[tier]);
        expect(n).toBeGreaterThanOrEqual(prev);
        if (n > DOUBLE_CURVATURE_FLOOR && n < SEGS[tier]) expect(sagitta(r, n)).toBeLessThanOrEqual(DOUBLE_CURVATURE_SAGITTA_TOL[tier] + 1e-12);
        prev = n;
      }
    }
  });

  test("a degenerate radius or an unknown tier takes the preview floor rather than throwing", () => {
    for (const r of [0, -1, NaN, undefined, null]) expect(doubleCurvatureSegs(r, "preview")).toBe(DOUBLE_CURVATURE_FLOOR);
    expect(doubleCurvatureSegs(300, "nonsense")).toBe(SEGS.preview);
    expect(doubleCurvatureSegs(300, "toString")).toBe(SEGS.preview);
  });
});

describe("double-curvature primitives follow the rule on both tiers", () => {
  // Baselines are the flat-116 counts measured before the rule reached these ops;
  // the LARGE cases must stay exactly there (nothing gets finer, and a feature the
  // flat count already served well keeps its density), the SMALL ones must fall
  // hard and export at their preview density.
  const torusS = (k) => k.torus({ rMajor: 3, rMinor: 0.75 });            // an O-ring: was 27,376
  const torusL = (k) => k.torus({ rMajor: 1000, rMinor: 300 });
  const rcylS = (k) => k.roundedCylinder({ r: 2, h: 4, round: 0.5 });     // was 13,920
  const rcylL = (k) => k.roundedCylinder({ r: 100, h: 300, round: 80 });
  const capsule = (k) => k.roundedCylinder({ r: 1, h: 3, round: 1 });     // was 13,688
  const rboxS = (k) => k.roundedBox({ size: [3, 3, 3], round: { side: 0.5, top: 0.5, bottom: 0.5 } }); // was 4,092
  const rboxL = (k) => k.roundedBox({ size: [200, 200, 200], round: { side: 80, top: 80, bottom: 80 } });

  test("a small torus: profile arcs at the double-curvature count, sweep at the circle count", () => {
    // tube ring: four quarter arcs at doubleCurvatureSegs(0.75) = 24, plus the
    // contour's start and seam points (the flat count gave 116 + 2 = 118 the same
    // way) → 26 points; sweep: circleSegs(3.75) = 116 → 26 · 116 · 2 triangles.
    expect(tris(preview.torus({ rMajor: 3, rMinor: 0.75 }))).toBe(26 * 116 * 2);
    expect(tris(print.torus({ rMajor: 3, rMinor: 0.75 }))).toBe(tris(preview.torus({ rMajor: 3, rMinor: 0.75 })));
  });

  test("large lathe solids keep exactly the flat-count density on both tiers", () => {
    expect(tris(preview.torus({ rMajor: 1000, rMinor: 300 }))).toBe(27840);
    expect(tris(print.torus({ rMajor: 1000, rMinor: 300 }))).toBe(372480);
    expect(tris(preview.roundedCylinder({ r: 100, h: 300, round: 80 }))).toBe(13920);
    expect(tris(print.roundedCylinder({ r: 100, h: 300, round: 80 }))).toBe(45492);
  });

  test("small lathe solids fall to a fraction of the flat count and export at preview density", () => {
    for (const [make, before] of [[torusS, 27376], [rcylS, 13920], [capsule, 13688]]) {
      expect(tris(make(preview))).toBeLessThan(before / 3);
      expect(tris(make(print))).toBe(tris(make(preview)));
    }
  });

  test("a rounded box: small corners at the double-curvature density, large ones unchanged", () => {
    expect(tris(rboxS(preview))).toBeLessThan(4092 / 3);
    expect(tris(rboxS(print))).toBe(tris(rboxS(preview)));
    expect(tris(rboxL(preview))).toBe(3884);
    expect(tris(rboxL(print))).toBe(10444);
  });

  test("roundedBoxArcSamples: quarter-arc samples from the double-curvature count, never finer than before", () => {
    // before: ceil(circle/8) — 15 at preview, 49 at a metre-scale print
    expect(roundedBoxArcSamples(116, 24)).toBe(6);   // a 0.5 mm corner: 15° facets, the sphere floor's own
    expect(roundedBoxArcSamples(116, 50)).toBe(13);  // r = 10 at preview
    expect(roundedBoxArcSamples(116, 116)).toBe(15); // r ≥ 60: exactly the old count
    expect(roundedBoxArcSamples(385, 385)).toBe(49); // a metre-scale print corner: exactly the old count
    expect(roundedBoxArcSamples(116, 0)).toBe(2);    // degenerate: the builder's own floor
  });

  test("a revolve of a straight-sided profile is untouched: sweep at the circle count", () => {
    const ring = [[4, 0], [6, 0], [6, 1], [4, 1]];
    expect(tris(preview.revolve({ profile: ring }))).toBe(8 * SEGS.preview);
    expect(tris(print.revolve({ profile: ring }))).toBe(8 * SEGS.preview);
    const shape = (k) => k.shape2d(ring);
    expect(tris(preview.revolve({ profile: shape(preview) }))).toBe(8 * SEGS.preview);
  });

  test("an author's own arc-profile revolve gets the same treatment as the built-ins", () => {
    // a rounded-corner lathe profile written by hand: the corner arc (r = 0.5) at the
    // double-curvature count, the sweep at the circle count — same as roundedCylinder.
    const prof = (k) => k.shape2d([[0, 0], [2, 0], [2, 4], [0, 4]]).fillet(0.5);
    const hand = tris(preview.revolve({ profile: prof(preview) }));
    expect(hand).toBeLessThan(27376 / 4); // four 0.5 mm arcs at 24/circle, swept at 116: ~27 · 116 · 2
    expect(tris(print.revolve({ profile: prof(print) }))).toBe(hand);
    // and extruding the SAME shape still tessellates its arcs at the flat circle count
    expect(tris(preview.extrude({ profile: prof(preview), h: 1 }))).toBe(tris(preview.extrude({ profile: prof(preview), h: 1 })));
  });
});

describe("primitives at print quality", () => {
  test("a small sphere exports at exactly the preview's density", () => {
    expect(tris(print.sphere({ r: 0.75 }))).toBe(tris(preview.sphere({ r: 0.75 })));
  });

  test("a large sphere still gets more segments at print than at preview", () => {
    expect(tris(print.sphere({ r: 300 }))).toBeGreaterThan(tris(preview.sphere({ r: 300 })));
  });

  test("a small cylinder exports at the preview's density; a large one is finer", () => {
    expect(tris(print.cylinder({ r: 1, h: 5 }))).toBe(tris(preview.cylinder({ r: 1, h: 5 })));
    expect(tris(print.cylinder({ r: 300, h: 5 }))).toBeGreaterThan(tris(preview.cylinder({ r: 300, h: 5 })));
  });

  test("a cone is sized by its larger radius", () => {
    // r1 = 300 governs: the print cone must be finer than preview even though r2 is tiny.
    expect(tris(print.cylinder({ r1: 300, r2: 0.5, h: 5 }))).toBeGreaterThan(tris(preview.cylinder({ r1: 300, r2: 0.5, h: 5 })));
  });

  test("a small bored cylinder exports at the preview's density", () => {
    expect(tris(print.boredCylinder({ od: 3, h: 4, bore: 1 }))).toBe(tris(preview.boredCylinder({ od: 3, h: 4, bore: 1 })));
  });

  test("a small rounded box exports at the preview's density", () => {
    const o = { size: [6, 6, 6], round: { side: 1, top: 1, bottom: 1 } };
    expect(tris(print.roundedBox(o))).toBe(tris(preview.roundedBox(o)));
  });

  test("a revolve is sized by the profile's largest radius from the axis", () => {
    const ring = (x0, x1) => [[x0, 0], [x1, 0], [x1, 1], [x0, 1]];
    expect(tris(print.revolve({ profile: ring(4, 6) }))).toBe(tris(preview.revolve({ profile: ring(4, 6) })));
    expect(tris(print.revolve({ profile: ring(398, 400) }))).toBeGreaterThan(tris(preview.revolve({ profile: ring(398, 400) })));
  });

  test("a revolved Shape2D is sized the same way", () => {
    const shape = (x0, x1) => print.shape2d([[x0, 0], [x1, 0], [x1, 1], [x0, 1]]);
    const shapeP = (x0, x1) => preview.shape2d([[x0, 0], [x1, 0], [x1, 1], [x0, 1]]);
    expect(tris(print.revolve({ profile: shape(4, 6) }))).toBe(tris(preview.revolve({ profile: shapeP(4, 6) })));
    expect(tris(print.revolve({ profile: shape(398, 400) }))).toBeGreaterThan(tris(preview.revolve({ profile: shapeP(398, 400) })));
  });

  test("a revolve's explicit segs is the caller's own sizing, bounded only by the tier cap", () => {
    // mesh-fillet's blend tools compute their density from a 1 µm sagitta bound and
    // rely on getting exactly that count (the dephase and horn-containment arithmetic
    // assume it), so an explicit override is NOT re-bounded by the part-scale rule:
    // a small ring may ask for more than the rule would give it, up to the cap.
    const small = [[4, 0], [6, 0], [6, 1], [4, 1]];
    expect(tris(print.revolve(small, { segs: 24 }))).toBeLessThan(tris(print.revolve(small)));
    expect(tris(print.revolve(small, { segs: 300 }))).toBeGreaterThan(tris(print.revolve(small)));
    expect(tris(print.revolve(small, { segs: 10000 }))).toBe(tris(print.revolve(small, { segs: SEGS.print })));
    expect(tris(preview.revolve(small, { segs: 10000 }))).toBe(tris(preview.revolve(small)));
  });

  test("preview output is pinned by literal counts, not only by equality with print", () => {
    // Equality tests stay green if both tiers drift together; these do not.
    expect(tris(preview.sphere({ r: 0.75 }))).toBe(288);  // 8·(24/4)²: the sphere floor
    expect(tris(preview.sphere({ r: 300 }))).toBe(6728);  // 8·(116/4)²: the old flat count survives for big spheres
    expect(tris(preview.cylinder({ r: 1, h: 5 }))).toBe(460); // 2·116 wall + two (116 − 2)-triangle caps
    expect(tris(preview.revolve({ profile: [[4, 0], [6, 0], [6, 1], [4, 1]] }))).toBe(8 * SEGS.preview);
  });

  test("Shape2D readbacks tessellate at the same per-radius LOD", () => {
    const ringLen = (k, r) => k.shape2d(circleContour(r)).toRegions()[0].outer.length;
    expect(ringLen(print, 1)).toBe(ringLen(preview, 1));
    expect(ringLen(print, 300)).toBeGreaterThan(ringLen(preview, 300));
  });
});

describe("mesh fillet at print quality", () => {
  // A cylinder topped by a cone, as ONE revolve: the circle where the wall meets the
  // cone has two CURVED flanks and its mesh vertices sit exactly on the circle, so it
  // is fitted as an arc chain and blended by revolveTool — the one tool that reasons
  // about the flank's own facet pitch (seam-grazing sag, closed-revolve dephase). At
  // print that flank is faceted by the per-radius rule, not the cap, and the tool must
  // follow it. (A bore through a sphere would NOT do: two faceted surfaces meet on a
  // jagged polyline, which the fillet rightly refuses as non-planar.)
  const capped = (k) => k.revolve({ profile: [[0, 0], [6, 0], [6, 5], [3, 10], [0, 10]] });

  test("a blend on a circular edge between two curved flanks builds on both tiers and agrees", () => {
    const rawP = capped(preview), rawQ = capped(print);
    const fP = rawP.fillet(0.5), fQ = rawQ.fillet(0.5);
    expect(preview.takeBuildWarnings?.() ?? []).toEqual([]);   // no edge skipped
    expect(print.takeBuildWarnings?.() ?? []).toEqual([]);
    expect(fP.genus()).toBe(0);
    expect(fQ.genus()).toBe(0);
    expect(fP.volume()).toBeLessThan(rawP.volume());          // convex fillets remove material
    expect(fQ.volume()).toBeLessThan(rawQ.volume());
    expect(Math.abs(fQ.volume() - fP.volume()) / fP.volume()).toBeLessThan(0.01);
    // r = 6 is under the floor radius, so the flanks facet identically at both tiers
    // and — with the tool following the flank rather than the cap — so do the blends.
    expect(tris(fQ)).toBe(tris(fP));
  });
});

describe("contour arcs at print quality", () => {
  test("a small arc-profile extrude exports at the preview's density; a large one is finer", () => {
    const small = { profile: circleContour(1), h: 2 };
    const large = { profile: circleContour(300), h: 2 };
    expect(tris(print.extrude(small))).toBe(tris(preview.extrude(small)));
    expect(tris(print.extrude(large))).toBeGreaterThan(tris(preview.extrude(large)));
  });

  test("a Shape2D built from arcs follows the same rule through csFor", () => {
    const small = (k) => k.extrude({ profile: k.shape2d(circleContour(1)), h: 2 });
    const large = (k) => k.extrude({ profile: k.shape2d(circleContour(300)), h: 2 });
    expect(tris(small(print))).toBe(tris(small(preview)));
    expect(tris(large(print))).toBeGreaterThan(tris(large(preview)));
  });

  test("a prism's arc points follow the rule too", () => {
    const small = { points: circleContour(1), h: 2 };
    const large = { points: circleContour(300), h: 2 };
    expect(tris(print.prism(small))).toBe(tris(preview.prism(small)));
    expect(tris(print.prism(large))).toBeGreaterThan(tris(preview.prism(large)));
  });
});

describe("samplers accept a per-radius segment function", () => {
  test("sampleArc hands the function the arc's own radius", () => {
    const seen = [];
    const fn = (r) => { seen.push(r); return 64; };
    const pts = sampleArc([2, 0], [0, 2], [-2, 0], fn);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeCloseTo(2, 9);
    expect(pts).toHaveLength(32);                          // a half circle at 64/circle
    expect(pts).toEqual(sampleArc([2, 0], [0, 2], [-2, 0], 64));
  });

  test("sampleBezier sizes a cubic by the radius it traces", () => {
    const printFn = (r) => circleSegs(r, "print");
    const small = quarterCubic(1), large = quarterCubic(300);
    expect(sampleBezier(...small, printFn)).toHaveLength(sampleBezier(...small, SEGS.preview).length);
    expect(sampleBezier(...large, printFn).length).toBeGreaterThan(sampleBezier(...large, SEGS.preview).length);
    expect(sampleBezier(...large, printFn).length).toBeLessThanOrEqual(sampleBezier(...large, SEGS.print).length);
  });

  test("a straight or degenerate cubic under the function form emits its endpoint and nothing else", () => {
    const printFn = (r) => circleSegs(r, "print");
    expect(sampleBezier([0, 0], [1, 0], [2, 0], [3, 0], printFn)).toEqual([[3, 0]]);   // collinear: t = 0
    expect(sampleBezier([0, 0], [0, 0], [0, 0], [0, 0], printFn)).toEqual([[0, 0]]);   // zero length
    expect(sampleBezier([0, 0], [1, 0], [2, 0], [3, 0], printFn)).toEqual(sampleBezier([0, 0], [1, 0], [2, 0], [3, 0], SEGS.print));
  });

  test("a numeric count still means what it always did", () => {
    expect(tessellateContour(circleContour(1), 116)).toHaveLength(117);
    expect(tessellateContour(circleContour(1), (r) => circleSegs(r, "print"))).toHaveLength(117);
    expect(tessellateContour(circleContour(300), (r) => circleSegs(r, "print")).length).toBeGreaterThan(117);
  });
});

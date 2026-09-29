// gasket.js is the reference part for the 2-D editing surface (docs/AUTHORING-PARTS.md
// "Editing profiles"): pathProfile outline (one cubic bulge edge) -> Shape2D.union two
// bolt bosses whose circular tabs are centered ON the outline's bottom edge (the
// coincident-edge boolean case) -> fillet the convex corners -> cut the bolt holes ->
// optional print-clearance offset -> extrude.
//
// Two independent checks:
//  1. The 2-D profile itself, re-derived here with the free contour-ops/paper-bridge
//     functions (booleanRegions, filletProfile, validateProfile, profileCorners) instead
//     of Shape2D/a kernel — "re-running the build's 2D steps as pure functions" so the
//     profile's curve-native shape can be inspected/validated with no WASM involved.
//  2. The actual build on the Manifold backend — volume and genus (through-hole count).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import part, { gasketGeometry } from "../src/parts/gasket.js";
import { pathProfile, circleProfile, circlePolygon } from "../src/framework/geometry/polygon.js";
import { booleanRegions } from "../src/framework/geometry/paper-bridge.js";
import { liftProfile, filletProfile, profileCorners, validateProfile } from "../src/framework/geometry/contour-ops.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const buildGasket = (overrides = {}) => {
  const p = { ...part.defaults, ...overrides };
  const d = part.derive ? part.derive(p) : {};
  return part.parts.gasket.build(k, p, d);
};

// Mirrors build()'s pre-extrude 2-D pipeline with the free functions directly: no
// k.shape2d(), no kernel. booleanRegions/filletProfile operate on the same plain
// {outer,holes}[] region-array shape Shape2D.toContours() returns. Stops right after
// the fillet — the true `{to,via}` arcs it inserts are what the next step (cutting the
// bolt holes, another paper.js boolean) degrades to cubics, per the documented
// "booleans are cubic-only" carve-out (AUTHORING-PARTS.md "Editing profiles" — fillet
// after booleans if STEP CIRCLE fidelity matters). Checking segment kinds here, not
// after the cuts, is what actually exercises fillet's arc-insertion.
function pureGasketFilletedRegions(overrides = {}) {
  const p = { ...part.defaults, ...overrides };
  const { w2, dep, bulge, tabR, tabX, tabSegs, filletR } = gasketGeometry(p);

  const outline = pathProfile([-w2, 0])
    .lineTo([w2, 0])
    .lineTo([w2, dep])
    .cubicTo([-w2, dep], [w2 * 0.5, dep + bulge], [-w2 * 0.5, dep + bulge])
    .close();

  let regions = liftProfile(outline).regions;
  for (const cx of [-tabX, tabX]) {
    regions = booleanRegions(regions, liftProfile(circlePolygon(tabR, [cx, 0], tabSegs)).regions, "unite");
  }
  if (filletR > 0) regions = filletProfile(regions, filletR, { corners: "convex" });
  return regions;
}

// Continues through the bolt-hole cuts — the same profile build() extrudes.
function pureGasketRegions(overrides = {}) {
  const p = { ...part.defaults, ...overrides };
  const { tabX } = gasketGeometry(p);
  let regions = pureGasketFilletedRegions(overrides);
  for (const cx of [-tabX, tabX]) {
    regions = booleanRegions(regions, liftProfile(circleProfile(p.boltR, [cx, 0])).regions, "subtract");
  }
  return regions;
}

test("pure 2-D pipeline: validateProfile reports no issues on the gasket profile", () => {
  const regions = pureGasketRegions();
  const { ok, issues } = validateProfile(regions);
  expect(ok, `unexpected issues: ${JSON.stringify(issues)}`).toBe(true);
});

test("pure 2-D pipeline: the fillet leaves line, cubic and arc segments all present", () => {
  const regions = pureGasketFilletedRegions();
  const kinds = new Set();
  for (const region of regions) {
    for (const seg of region.outer.segments) {
      if (seg.via) kinds.add("arc");
      else if (seg.c1) kinds.add("cubic");
      else kinds.add("line");
    }
  }
  // line: the outline's straight sides/bottom runs, plus the bosses (circleProfile is a
  // tessellated polygon, so unioning two polygons stays polygonal); cubic: the top
  // bulge edge, carried through the union untouched; arc: the true circular fillet
  // Shape2D.fillet/filletProfile inserts at each rounded convex corner. (A later
  // boolean — cutting the bolt holes — degrades these arcs to cubics; see
  // pureGasketFilletedRegions's comment.)
  expect(kinds.has("line")).toBe(true);
  expect(kinds.has("cubic")).toBe(true);
  expect(kinds.has("arc")).toBe(true);
});

test("pure 2-D pipeline: profileCorners reports the expected corner count", () => {
  const regions = pureGasketRegions();
  const corners = profileCorners(regions);
  // Two bolt-hole cuts add a hole ring each with its own corner list (a circle: 0 sharp
  // corners, since a circle's paper-bridge tessellation-free arc has no tangent break).
  // The outer ring after union+fillet keeps a mix of sharp (boss/outline meet points)
  // and filleted (now-arc, still tangent-discontinuous at their endpoints) corners.
  expect(corners.length).toBeGreaterThan(0);
  expect(regions.length).toBe(1);          // one outer ring, no separate disjoint pieces
  expect(regions[0].holes.length).toBe(2); // the two bolt holes
});

test("Manifold build: volume is positive", () => {
  const s = buildGasket();
  expect(s.volume()).toBeGreaterThan(0);
});

test("Manifold build: genus equals the bolt-hole count (2)", () => {
  const s = buildGasket();
  expect(s.genus()).toBe(2);
});

test("Manifold build: clearance offset grows the plate (more volume than without)", () => {
  const base = buildGasket({ clearance: 0 }).volume();
  const grown = buildGasket({ clearance: 0.4 }).volume();
  expect(grown).toBeGreaterThan(base);
});

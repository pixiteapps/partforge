import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SQ = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

test("union area of two overlapping unit-spaced squares", () => {
  const s = k.shape2d(SQ(0, 0, 10)).union(SQ(5, 5, 10));   // 100 + 100 − 25 overlap
  expect(s.area()).toBeCloseTo(175, 4);
});

test("cut subtracts overlap area", () => {
  const s = k.shape2d(SQ(0, 0, 10)).cut(SQ(5, 5, 10));      // 100 − 25
  expect(s.area()).toBeCloseTo(75, 4);
});

test("intersect keeps the overlap", () => {
  const s = k.shape2d(SQ(0, 0, 10)).intersect(SQ(5, 5, 10));// 25
  expect(s.area()).toBeCloseTo(25, 4);
});

test("subtract that punches a hole extrudes to genus 1", () => {
  const plate = k.shape2d(SQ(0, 0, 20)).cut(SQ(7, 7, 6));   // hole strictly inside
  expect(k.extrude({ profile: plate, h: 3 }).genus()).toBe(1);
});

test("toRegions materializes; simple unwraps the single region", () => {
  const s = k.shape2d(SQ(0, 0, 20)).cut(SQ(7, 7, 6));       // hole strictly inside → ring with a hole, 1 region
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  expect(s.simple().holes).toHaveLength(1);
});

// Shape2D booleans themselves are pure JS over the contour IR — no WASM, nothing to
// cache. What the content hash still buys is downstream: an identical shape rebuilt
// from scratch keys the SAME solid-cache entries, so the CrossSection materialization
// and the extrude behind it are done once.
test("an identical rebuilt shape hits the solid cache downstream (content hash)", () => {
  k.beginSubPart("t");
  k.resetCacheStats();
  const one = () => k.extrude({ profile: k.shape2d(SQ(0, 0, 10)).cut(SQ(5, 5, 10)), h: 2 }).volume();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});

// The same shape used twice by one op class tessellates ONE CrossSection — csFor
// (extrude, prism) and csForLathe (revolve) each memoize theirs in the solid cache by
// shape hash + LOD. The two classes deliberately do NOT share: a lathe profile's arcs
// are sampled at the double-curvature count (circle-segs.js), an extrusion's at the
// flat circle count, so the same shape revolved and extruded is two tessellations.
test("materialization is memoized per op class: a shape used twice tessellates once", () => {
  k.beginSubPart("cs");
  k.resetCacheStats();
  const shape = k.shape2d(SQ(2, 0, 6));
  k.extrude({ profile: shape, h: 2 });
  const afterExtrude = k.cacheStats();
  k.extrude({ profile: shape, h: 3 });                       // a different solid, the same CrossSection
  expect(k.cacheStats().hits).toBeGreaterThan(afterExtrude.hits);
  k.revolve({ profile: shape, degrees: 360 });
  const afterRevolve = k.cacheStats();
  expect(afterRevolve.misses).toBeGreaterThan(afterExtrude.misses); // its own lathe tessellation
  k.revolve({ profile: shape, degrees: 180 });               // a different solid, the same lathe CrossSection
  expect(k.cacheStats().hits).toBeGreaterThan(afterRevolve.hits);
  k.endSubPart();
});

test("curve operand: cut a circleProfile hole from a square", () => {
  const s = k.shape2d(SQ(-10, -10, 20)).cut(circleProfile(5));
  expect(s.area()).toBeCloseTo(400 - Math.PI * 25, 0);   // faceted → loose tol
});

test("cutAll subtracts several tools; empty list is a safe identity (no double-free)", () => {
  const s = k.shape2d(SQ(0, 0, 20)).cutAll([SQ(2, 2, 4), SQ(12, 12, 4)]);
  expect(s.area()).toBeCloseTo(400 - 16 - 16, 3);
  const id = k.shape2d(SQ(0, 0, 10)).cutAll([]);   // must survive cleanup()/eviction unscathed
  expect(id.area()).toBeCloseTo(100, 4);
  k.cleanup();                                       // would throw "already deleted" on the aliasing bug
});

test("revolve of a Shape2D lathe profile builds a sane solid", () => {
  const prof = k.shape2d([[2, 0], [6, 0], [6, 8], [2, 8]]);   // rectangle in +X (r,z)
  const v = k.revolve({ profile: prof, degrees: 360 }).volume();
  expect(v).toBeCloseTo(Math.PI * (6 * 6 - 2 * 2) * 8, -1);   // annular ring volume
});

test("intersect of disjoint shapes is empty; simple() throws", () => {
  const s = k.shape2d([[0,0],[1,0],[1,1],[0,1]]).intersect([[10,10],[11,10],[11,11],[10,11]]);
  expect(s.area()).toBeCloseTo(0, 6);
  expect(() => s.simple()).toThrow("Shape2D.simple");
});

test("shape2d rejects an invalid profile", () => {
  expect(() => k.shape2d([[0, 0], [1, 0]])).toThrow(/≥3 points|profile/);
});

test("offset grows a square by delta on every side (round corners add quarter-circles)", () => {
  const s = k.shape2d(SQ(0, 0, 10)).offset(1);           // 10x10 + perimeter*1 + 4 quarter-circles
  expect(s.area()).toBeCloseTo(100 + 40 + Math.PI, 1);   // 100 + 4*10*1 + π*1²
});

test("negative offset insets a square to 8x8", () => {
  expect(k.shape2d(SQ(0, 0, 10)).offset(-1).area()).toBeCloseTo(64, 1); // inset convex corners stay sharp → 8x8
});

test("corner styles differ at convex right angles (sharp > round > chamfer)", () => {
  // chamfer is a true 45° bevel (a single-chord round join): at a right-angle
  // corner it cuts a triangle of area d²/2 per corner, so total = 100 + 40 + 4·0.5
  // = 142 — smaller than round, and identical to OCCT's `bevel` (verified 142.0000
  // on both backends).
  const sharp = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "sharp" }).area();
  const round = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "round" }).area();
  const cham  = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "chamfer" }).area();
  expect(sharp).toBeGreaterThan(round);
  expect(round).toBeGreaterThan(cham);
  expect(cham).toBeCloseTo(142, 4);       // exact 45° bevel — matches OCCT
});

test("acute (<90°) corners: chamfer is a true single-chord bevel", () => {
  // The native engine's chamfer is a true bevel (a single straight chord across the
  // corner) at every corner angle, not just interior ≥ 90° — no separate "acute" case
  // to approximate. So this isoceles triangle (apex 40°, base corners 70°) is chosen
  // only to keep every corner comfortably clear of the sharp-corner miter limit (2×delta,
  // i.e. interior angle 60° exactly) in BOTH directions: the 40° apex reliably falls back
  // to a bevel and the 70° base corners reliably hold a true miter, so sharp > round is a
  // stable inequality rather than a coin flip. (An exactly-equilateral 60° triangle sits
  // exactly ON that boundary — the miter-limit distance check is `<= 2·delta` there for
  // every corner at once — so which corners fall back is decided by sub-ULP floating-point
  // noise from the triangle's literal coordinates, not by geometry; that's what the old
  // triangle here did, and it's why this one replaces it.)
  const tri = [[-10, 0], [10, 0], [0, 27.4748]];   // isoceles, apex 40°, base angles 70°
  const cham = k.shape2d(tri).offset(1, { corners: "chamfer" }).area();
  const round = k.shape2d(tri).offset(1, { corners: "round" }).area();
  const sharp = k.shape2d(tri).offset(1, { corners: "sharp" }).area();
  expect(cham).toBeLessThan(round);
  expect(round).toBeLessThan(sharp);
});

test("offset of a circle scales the radius", () => {
  const a = k.shape2d(circleProfile(5)).offset(1).area();
  expect(a).toBeCloseTo(Math.PI * 36, 0);                // π(5+1)²  (faceted → loose)
});

test("collapse throws immediately", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(-6)).toThrow("Shape2D.offset: offset collapses the shape");
});

test("offset validates delta and corners", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(NaN)).toThrow("Shape2D.offset: delta must be a finite number");
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "bevel" }))
    .toThrow('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
});

// Offset now runs the shared native engine in pure JS like every other Shape2D
// op, and its RESULT is a contour-IR shape like any other — so the repeat payoff
// is downstream: the same offset shape extrudes off a cached CrossSection + solid.
test("an offset result is content-hashed: repeat rebuild hits the solid cache", () => {
  k.beginSubPart("off"); k.resetCacheStats();
  const one = () => k.extrude({ profile: k.shape2d(SQ(0, 0, 10)).offset(1), h: 2 }).volume();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});

// --- Shape2D sugar (extrude / revolve / regions) ---

test("Shape2D.extrude({h}) equals k.extrude({profile, h})", () => {
  const viaSugar = k.shape2d(SQ(0, 0, 10)).extrude({ h: 4 });
  const viaKernel = k.extrude({ profile: k.shape2d(SQ(0, 0, 10)), h: 4 });
  expect(viaSugar.volume()).toBeCloseTo(400, 3);
  expect(viaSugar.volume()).toBeCloseTo(viaKernel.volume(), 3);
});

test("Shape2D.revolve({degrees}) equals k.revolve({profile})", () => {
  const viaSugar = k.shape2d(SQ(5, 0, 4)).revolve({ degrees: 360 });   // offset from the axis
  const viaKernel = k.revolve({ profile: k.shape2d(SQ(5, 0, 4)), degrees: 360 });
  expect(viaSugar.volume()).toBeGreaterThan(0);
  expect(viaSugar.volume()).toBeCloseTo(viaKernel.volume(), 3);
});

test("Shape2D.regions() splits disjoint regions into separate live Shape2Ds", () => {
  const disjoint = k.shape2d(SQ(0, 0, 10)).union(SQ(20, 0, 10));   // two separated squares
  const regions = disjoint.regions();
  expect(regions.length).toBe(2);
  for (const r of regions) { expect(r._shape2d).toBe(true); expect(r.area()).toBeCloseTo(100, 3); }
  expect(regions[0].union(regions[1]).area()).toBeCloseTo(200, 3);   // re-composable
});

test("Shape2D.extrude with no h throws the kernel's required-arg error (not silent garbage)", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).extrude({})).toThrow(/h is required/);
});

// Empty-shape semantics, aligned across backends (see the twin test in
// shape2d-occt.test.js): empty is a legal 2-D value — booleans/offset stay total
// on it — but 3-D materialization fails loudly instead of silently building an
// empty solid, so a part that vanishes a feature must guard with .isEmpty().
test("empty shape: extrude/revolve throw, offset stays empty, union is identity", () => {
  const empty = k.shape2d(SQ(0, 0, 10)).intersect(SQ(20, 20, 10));
  expect(empty.isEmpty()).toBe(true);
  expect(() => k.extrude({ profile: empty, h: 5 })).toThrow("extrude: the profile Shape2D is empty");
  expect(() => empty.revolve()).toThrow("revolve: the profile Shape2D is empty");
  expect(empty.offset(1).isEmpty()).toBe(true);
  expect(k.shape2d(SQ(0, 0, 10)).union(empty).area()).toBeCloseTo(100, 4);
});

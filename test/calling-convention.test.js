// test/calling-convention.test.js
// Pins the options-object calling convention end-to-end on the Manifold backend:
// equivalence with positional form, the detection rule, cache-entry sharing,
// error surfacing, and OCCT routing. This file is ALSO the deliberate legacy
// suite — the positional spellings here pin the compat shim until a future
// breaking contract version removes it (contract v2, partforge 0.59, did not —
// that bump only changed `offset` semantics).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { detectBackend } from "../src/framework/backend-select.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const sameGeom = (a, b) => {
  expect(a.volume()).toBeCloseTo(b.volume(), 6);
  const ba = a.boundingBox(), bb = b.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(ba.min[i]).toBeCloseTo(bb.min[i], 4);
    expect(ba.max[i]).toBeCloseTo(bb.max[i], 4);
  }
};

const TRI = [[0, 0], [10, 0], [0, 10]];
const RZ = [[0, 0], [5, 0], [5, 8], [0, 8]];

test("options form ≡ positional form for every factory op", () => {
  sameGeom(k.cylinder({ r: 4, h: 10 }), k.cylinder(4, 4, 10));
  sameGeom(k.cylinder({ d: 8, h: 10 }), k.cylinder(4, 4, 10));
  sameGeom(k.cylinder({ d1: 8, d2: 2, h: 10 }), k.cylinder(4, 1, 10));
  sameGeom(k.cylinder({ r: 4, h: 10, center: true }), k.cylinder(4, 4, 10, { center: true }));
  sameGeom(k.sphere({ d: 10 }), k.sphere(5));
  sameGeom(k.box({ min: [0, 0, 0], max: [2, 4, 6] }), k.box([0, 0, 0], [2, 4, 6]));
  sameGeom(k.prism({ points: TRI, h: 5, twist: 30 }), k.prism(TRI, 5, { twist: 30 }));
  sameGeom(k.extrude({ profile: TRI, h: 5 }), k.extrude(TRI, 5));
  sameGeom(k.revolve({ profile: RZ, degrees: 180 }), k.revolve(RZ, { degrees: 180 }));
  const RINGS = [{ sides: 6, radius: 5, z: 0 }, { sides: 6, radius: 3, z: 10 }];
  sameGeom(k.loft({ rings: RINGS }), k.loft(RINGS));
  const PATH = [[0, 0, 0], [0, 0, 20]];
  sameGeom(k.sweep({ profile: TRI, path: PATH }), k.sweep(TRI, PATH));
});

test("box({size}) sits centered in X/Y with its base at z=0", () => {
  const b = k.box({ size: [4, 6, 10] }).boundingBox();
  expect(b.min).toEqual([-2, -3, 0]);
  expect(b.max).toEqual([2, 3, 10]);
  const c = k.box({ size: [4, 6, 10], center: true }).boundingBox();
  expect(c.min).toEqual([-2, -3, -5]);
});

test("detection rule: two-argument object-profile extrude stays positional", () => {
  const outer = [[0, 0], [20, 0], [20, 20], [0, 20]];
  const hole = [[8, 8], [12, 8], [12, 12], [8, 12]];
  sameGeom(
    k.extrude({ outer, holes: [hole] }, 5),                      // legacy positional
    k.extrude({ profile: { outer, holes: [hole] }, h: 5 }),      // options form
  );
});

test("both spellings share one solid-cache entry", () => {
  // NOTE: deviates from the brief, which used k.cylinder(...) here — cylinder/sphere/box
  // are bare Manifold primitives that never touch cache.lookup (only boolean/profile ops
  // like prism/extrude/loft/sweep/boredCylinder route through cached(), per
  // manifold-backend.js). Swapped to prism, which the same normalize-before-backend
  // rewrite still makes share one cache entry across both calling forms.
  k.beginSubPart("cc"); k.prism(TRI, 5).toMesh(); k.endSubPart(); k.cleanup();
  k.resetCacheStats();
  k.beginSubPart("cc"); k.prism({ points: TRI, h: 5 }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(0);
  expect(k.cacheStats().hits).toBeGreaterThan(0);
});

test("validation errors surface through the kernel", () => {
  expect(() => k.cylinder({ r: 4, d: 8, h: 1 })).toThrow("cylinder: pass exactly one of r/d, or r1+r2 / d1+d2");
  expect(() => k.cylinder({ radius: 4, h: 1 })).toThrow('cylinder: unknown option "radius" — did you mean r?');
  expect(() => k.prism({ points: TRI, h: 5, scaleTop: -1 })).toThrow("prism: scaleTop must be ≥ 0");
  expect(() => k.prism(TRI, 5, { scaleTop: -1 })).toThrow("prism: scaleTop must be ≥ 0"); // positional still checked
});

test("options-only compound ops get key validation too", () => {
  // These predate the convention (always options-form); a typo'd key must fail
  // loudly instead of destructuring to undefined → NaN geometry.
  expect(() => k.boredCylinder({ od: 8, h: 10, boreDiameter: 3 }))
    .toThrow('boredCylinder: unknown option "boreDiameter" — did you mean bore?');
  expect(() => k.boredCylinder({ od: 8, h: 10 })).toThrow("boredCylinder: bore is required");
  expect(() => k.helixSweptTube({ pathR: 10, profileR: 1.5, pitch: 4 }))
    .toThrow("helixSweptTube: turns is required");
  expect(k.boredCylinder({ od: 8, h: 10, bore: 3 }).volume()).toBeGreaterThan(0); // valid call unaffected
});

test("options-form fillet builds natively on Manifold (mesh-fillet.js)", () => {
  const out = k.box({ size: [1, 1, 1] }).fillet({ r: 0.2 });
  expect(out.volume()).toBeGreaterThan(0);
  expect(out.volume()).toBeLessThan(1); // material actually removed
});

test("probe routes an options-form shell build to occt (fillet no longer routes)", () => {
  const shelled = { defaults: {}, parts: { p: { build: (kk) => kk.box({ size: [1, 1, 1] }).shell({ t: 0.1, open: { dir: "Z" } }) } } };
  expect(detectBackend(shelled)).toBe("occt");
  const filleted = { defaults: {}, parts: { p: { build: (kk) => kk.box({ size: [1, 1, 1] }).fillet({ r: 0.1 }) } } };
  expect(detectBackend(filleted)).toBe("manifold");
});

test("screwSweep is options-only and validates required keys", () => {
  expect(() => k.screwSweep({ profile: [[4, 0], [5, 1]], pitch: 2 }))
    .toThrow("screwSweep: turns is required");
});

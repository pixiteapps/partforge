// implicitDistance(node): the implicit engine's field as a point function, so the
// kinematics domain's grip can close on any k.implicit shape. On the plain shapes it
// must agree with the domain's closed forms (shapes.js distanceFor); on what only the
// engine knows (a blend, a warp) it must at least be finite and signed right.
import { describe, it, expect } from "vitest";
import { implicitDistance } from "../src/framework/geometry/polygon.js";
import { SpecError } from "../src/framework/geometry/errors.js";
import { ImplicitSpecError } from "../src/framework/geometry/implicit/errors.js";
import { distanceFor } from "../src/framework/domains/kinematics/shapes.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { axisVector, rotation } from "../src/framework/geometry/implicit/frames.js";
import { implicitFrames } from "../src/framework/geometry/implicit/frame-report.js";

/** A seeded LCG in [0, 1): the same points every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const points = (seed, half, n = 200) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => [0, 1, 2].map(() => (r() * 2 - 1) * half));
};

// Ruling 3's vocabulary, one node each (plus the variants that change the packing).
const SHAPES = {
  sphere: { kind: "sphere", r: 7, at: [1, -2, 3] },
  capsule: { kind: "capsule", b: [10, 4, -3], r: 3 },
  "capsule (a, taper)": { kind: "capsule", a: [-4, 1, 2], b: [9, -3, 5], r: [4, 1.5] },
  box: { kind: "box", size: [12, 8, 6] },
  "box (round)": { kind: "box", size: [12, 8, 6], round: 2, at: [0, 1, 0] },
  cylinder: { kind: "cylinder", h: 14, r: 5 },
  "cylinder (round, axis x)": { kind: "cylinder", h: 14, r: 5, round: 1.5, axis: "x" },
  "cylinder (axis vector)": { kind: "cylinder", h: 10, r: 4, axis: [1, 1, 2] },
  "cylinder (axis near x)": { kind: "cylinder", h: 10, r: 4, axis: [1, 0.1, 0] },
  torus: { kind: "torus", R: 8, r: 2.5 },
  "torus (axis y)": { kind: "torus", R: 8, r: 2.5, axis: "y", at: [2, 0, -1] },
  tube: { kind: "tube", points: [[0, 0, 0], [8, 2, 0], [10, 9, 4]], r: 2 },
  "tube (per-point r)": { kind: "tube", points: [[0, 0, 0], [8, 2, 0], [10, 9, 4]], r: [3, 2, 1.2] },
  ellipsoid: { kind: "ellipsoid", r: [9, 5, 3], at: [0, 2, 0] },
  union: { kind: "union", children: [{ kind: "sphere", r: 5 }, { kind: "box", size: [6, 6, 20], at: [6, 0, 0] }] },
  "union (k 0)": { kind: "union", k: 0, children: [{ kind: "capsule", b: [0, 0, 12], r: 2 }, { kind: "torus", R: 6, r: 1 }] },
};

describe("implicitDistance matches the domain's closed forms", () => {
  let seed = 1;
  for (const [name, node] of Object.entries(SHAPES)) {
    const s = seed++;
    it(name, () => {
      const engine = implicitDistance(node), closed = distanceFor(node);
      for (const p of points(s, 18)) {
        const a = engine(...p), b = closed(...p);
        expect(Math.abs(a - b), `${name} at [${p}]: engine ${a}, closed ${b}`).toBeLessThanOrEqual(1e-9);
      }
    });
  }

  it("halfspace (the engine refuses one alone as unbounded; cut by a far sphere it is exact)", () => {
    const hs = { kind: "halfspace", normal: [1, -2, 0.5], offset: 3 };
    expect(() => implicitDistance(hs)).toThrow(ImplicitSpecError);
    expect(() => implicitDistance(hs)).toThrow(/unbounded/);
    const engine = implicitDistance({ kind: "intersect", children: [hs, { kind: "sphere", r: 1000 }] });
    const closed = distanceFor(hs);
    for (const p of points(99, 18)) expect(Math.abs(engine(...p) - closed(...p))).toBeLessThanOrEqual(1e-9);
  });
});

describe("implicitDistance on what only the engine knows", () => {
  const blended = { kind: "union", k: 4, children: [{ kind: "sphere", r: 6 }, { kind: "box", size: [4, 4, 20], at: [8, 0, 0] }] };
  const twisted = { kind: "twist", degPerMm: 4, child: { kind: "box", size: [12, 4, 30] } };

  it("a blended union: finite, and signed right inside and out", () => {
    const d = implicitDistance(blended);
    expect(d(0, 0, 0)).toBeLessThan(0);
    expect(d(6, 2.3, 3)).toBeLessThan(0);   // in the blend's fillet, outside both children
    expect(distanceFor({ kind: "union", children: blended.children })(6, 2.3, 3)).toBeGreaterThan(0);
    expect(d(40, 0, 0)).toBeGreaterThan(0);
    for (const p of points(7, 30)) expect(Number.isFinite(d(...p))).toBe(true);
  });

  it("a twist: finite, and signed right inside and out", () => {
    const d = implicitDistance(twisted);
    expect(d(0, 0, 0)).toBeLessThan(0);
    expect(d(5, 0, 0)).toBeLessThan(0);
    expect(d(0, 0, 25)).toBeGreaterThan(0);
    expect(d(30, 30, 0)).toBeGreaterThan(0);
    for (const p of points(8, 30)) expect(Number.isFinite(d(...p))).toBe(true);
  });

  it("a node naming a frame is a spec error (implicitDistance takes no frames)", () => {
    expect(() => implicitDistance({ kind: "sphere", r: 5, frame: "nope" })).toThrow(ImplicitSpecError);
  });

  it("grip closes on a blended shape through implicitDistance", () => {
    const rod = { kind: "cylinder", r: 12, h: 120, at: [0, 60, -25], axis: "x" };
    const around = implicitDistance({ kind: "union", k: 3, children: [rod, { kind: "sphere", r: 6, at: [40, 60, -25] }] });
    const L = limb("index", {
      parent: "palm", at: [-30, 96, 2], rotate: [{ axis: "z", deg: 8 }],
      joints: ["mcp", "pip", "dip"].map((n) => ({ name: n, range: [-180, 180] })),
      lengths: [42, 25, 22],
    });
    const posed = L.pose({ curl: 0, grip: { around, r: [9.5, 8.5, 7.4, 6.4] } }, { palm: {} });
    for (const j of posed.report.grip.joints) expect(j.touched, j.joint).toBe(true);
    expect(posed.report.grip.touching).toBe(true);
  });
});

describe("implicit errors sit on core's SpecError", () => {
  it("ImplicitSpecError is a SpecError and keeps its own code and prefix", () => {
    const e = new ImplicitSpecError("x");
    expect(e).toBeInstanceOf(SpecError);
    expect(e).toBeInstanceOf(ImplicitSpecError);
    expect(e.code).toBe("IMPLICIT_SPEC");
    expect(e.name).toBe("ImplicitSpecError");
    expect(e.message).toBe("implicit: x");
    expect(e.issues).toEqual(["x"]);
  });

  it("frames.js's axis helpers still throw ImplicitSpecError (core's SpecError rethrown)", () => {
    expect(() => axisVector("w")).toThrow(ImplicitSpecError);
    expect(() => axisVector([1e-200, 0, 0])).toThrow(ImplicitSpecError);
    expect(() => rotation("w", 10)).toThrow(/^implicit: unknown axis "w"$/);
  });

  it("an axis the grammar passes but the core refuses (underflowing length) is still an implicit spec error", () => {
    const node = { kind: "cylinder", h: 4, r: 1, axis: [1e-200, 0, 0] };
    expect(() => implicitDistance(node)).toThrow(ImplicitSpecError);
    expect(() => implicitFrames({ root: node })).toThrow(ImplicitSpecError);
    expect(() => implicitFrames({ frames: { a: { rotate: { axis: [0, 1e-200, 0], deg: 5 } } }, root: { kind: "sphere", r: 1 } }))
      .toThrow(ImplicitSpecError);
  });

  it("a frame set's rotate with a bad axis is an implicit spec error", () => {
    const set = implicitFrames({ root: { kind: "sphere", r: 1 } });
    expect(() => set.rotate(10, [0, 0, 0], [0, 0, 0])).toThrow(ImplicitSpecError);
  });
});

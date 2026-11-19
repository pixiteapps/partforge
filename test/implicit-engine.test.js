import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit, implicitHashable, IMPLICIT_DEFAULTS } from "../src/framework/geometry/implicit/index.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { edgeCheck } from "./helpers/mesh-topology.js";

describe("engine entry", () => {
  test("compile + mesh a blended pair", () => {
    const spec = { root: { kind: "union", k: 2, children: [{ kind: "sphere", r: 5 }, { kind: "capsule", a: [0, 0, 0], b: [12, 0, 0], r: 2 }] } };
    const out = meshImplicit(compileImplicit(spec), 1);
    expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(out.stats.leaves).toBeGreaterThan(0);
    expect(out.warnings).toEqual([]);
  });
  test("warns on features thinner than two grid cells and on clipping", () => {
    const thin = meshImplicit(compileImplicit({ root: { kind: "box", size: [10, 10, 1] } }), 0.8);
    expect(thin.warnings.join(" ")).toMatch(/thinnest feature \(1\.00 mm\) is under 2 grid cells/);
  });
  test("invalid specs throw IMPLICIT_SPEC before any sampling", () => {
    expect(() => compileImplicit({ root: { kind: "sphere", r: 0 } })).toThrow(/root\.r: must be a number > 0/);
  });
  test("hashable carries image digests", () => {
    const data = new Uint16Array(4);
    const images = new Map([["m", { digest: "abc", width: 2, height: 2, data }]]);
    const spec = { root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return length(p) - 0.5 - texture(t, p.xy);", textures: { t: { image: "m" } } } };
    expect(implicitHashable(spec, compileImplicit(spec, { images })).digests).toEqual(["abc"]);
  });
  test("defaults", () => expect(IMPLICIT_DEFAULTS).toEqual({ resolution: 0.6 }));
});

// Pads (blend, round, onion, displace) assume the child's field grows at rate 1
// outside its box; slow-growing fields (ellipsoids, upscaling tapers, twists, bends)
// need the pad divided by that growth rate, or the derived bounds clip the shape.
const SLOW_GROWTH = {
  roundEllipsoid: { root: { kind: "round", r: 2, child: { kind: "ellipsoid", r: [10, 1, 1] } } },
  blendedEllipsoids: { root: { kind: "union", k: 6, children: [{ kind: "ellipsoid", r: [20, 3, 3], at: [0, -2, 0] }, { kind: "ellipsoid", r: [20, 3, 3], at: [0, 2, 0] }] } },
  roundTaper: { root: { kind: "round", r: 2, child: { kind: "taper", from: [-5, 1], to: [5, 3], child: { kind: "box", size: [4, 4, 10] } } } },
  roundTwist: { root: { kind: "round", r: 2, child: { kind: "twist", degPerMm: 20, child: { kind: "box", size: [16, 2, 10] } } } },
  roundBend: { root: { kind: "round", r: 2, child: { kind: "bend", radius: 12, child: { kind: "box", size: [4, 4, 20] } } } },
};

describe("derived bounds", () => {
  for (const [name, spec] of Object.entries(SLOW_GROWTH)) {
    test(`${name}: the derived bounds hold the whole shape (no clipping) and the mesh closes`, () => {
      const c = compileImplicit(spec);
      expect(sampleField(c, 0.5).clipped).toBe(false);
      const out = meshImplicit(c, 0.5);
      expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      expect(out.warnings.filter((w) => /clipped/.test(w))).toEqual([]);
    });
  }
  test("the clipped warning names expr boxes only when the spec has an expr node", () => {
    const tight = compileImplicit({ root: { kind: "sphere", r: 6 } });
    tight.bounds = { min: [-4, -4, -4], max: [4, 4, 4] };   // stand-in for bounds derived too tight
    const w = meshImplicit(tight, 0.5).warnings.join(" ");
    expect(w).toMatch(/clipped/);
    expect(w).not.toMatch(/expr/);
    expect(w).toMatch(/derived bounds were too tight/);
    const withExpr = compileImplicit({ root: { kind: "expr", box: [[-4, -4, -4], [4, 4, 4]], sdf: "return length(p) - 6.0;" } });
    expect(meshImplicit(withExpr, 0.5).warnings.join(" ")).toMatch(/enlarge the `box` of the `expr` node/);
  });
});

// An intersect's child bounds are per-axis; a rotation above the node (twist, polar
// repeat, rotated frame) can turn the box so the real growth is up to sqrt(3) slower.
describe("derived bounds: intersect under rotation", () => {
  const I = { kind: "intersect", children: [{ kind: "box", size: [10, 10, 40], at: [-2.5, -2.5, 0] }, { kind: "box", size: [10, 10, 40], at: [2.5, 2.5, 0] }] };
  const CASES = {
    twist: { root: { kind: "round", r: 4, child: { kind: "twist", degPerMm: 2.25, child: I } } },
    polarRepeat: { root: { kind: "round", r: 4, child: { kind: "repeat", polar: { count: 8 }, child: I } } },
    rotatedFrame: { frames: { f: { rotate: { axis: "z", deg: 45 } } }, root: { kind: "round", r: 4, child: { ...I, frame: "f" } } },
  };
  for (const [name, spec] of Object.entries(CASES)) {
    test(`${name}: not clipped`, () => expect(sampleField(compileImplicit(spec), 0.5).clipped).toBe(false));
  }
});

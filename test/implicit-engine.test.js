import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit, implicitHashable, IMPLICIT_DEFAULTS } from "../src/framework/geometry/implicit/index.js";
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
  test("defaults", () => expect(IMPLICIT_DEFAULTS).toEqual({ resolution: 0.6, preview: 1.5 }));
});

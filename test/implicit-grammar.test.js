import { describe, test, expect } from "vitest";
import { validateSpec, NODE_KINDS } from "../src/framework/geometry/implicit/grammar.js";

const issues = (spec, opts) => { try { validateSpec(spec, opts); return []; } catch (e) { expect(e.code).toBe("IMPLICIT_SPEC"); return e.issues; } };

describe("validateSpec", () => {
  test("a good spec passes", () => {
    expect(issues({
      frames: { palm: {}, tip: { parent: "palm", at: [0, 10, 0], rotate: [{ axis: "x", deg: -20 }] } },
      root: { kind: "union", k: 2, children: [
        { kind: "sphere", r: 5, frame: "palm", label: "ball" },
        { kind: "capsule", frame: "tip", b: [0, 8, 0], r: [3, 2] },
        { kind: "repeat", linear: { step: [0, 0, 6], count: 4 }, child: { kind: "torus", R: 4, r: 1 } },
        { kind: "expr", box: [[-5, -5, -5], [5, 5, 5]], sdf: "return length(p) - 4.0;", lipschitz: 1 },
      ] },
      detail: [{ kind: "creases", frame: "tip", amplitude: 0.3, wavelength: 1.5, axis: "y" }],
      resolution: 0.5, preview: 1.5,
    })).toEqual([]);
  });
  test("every problem is reported with its exact path", () => {
    const got = issues({
      root: { kind: "union", children: [
        { kind: "sphere", r: -1 },
        { kind: "sphre", r: 1 },
        { kind: "box", size: [1, 2] },
        { kind: "sphere", r: 1, radius: 2 },
        { kind: "sphere", r: 1, frame: "missing" },
      ] },
      preview: 0,
    });
    expect(got).toContain("root.children[0].r: must be a number > 0");
    expect(got.some((m) => m.startsWith('root.children[1].kind: unknown kind "sphre"'))).toBe(true);
    expect(got).toContain("root.children[2].size: must be [x, y, z] with every value > 0");
    expect(got).toContain('root.children[3]: unknown field "radius"');
    expect(got).toContain('root.children[4].frame: unknown frame "missing"');
    expect(got).toContain("preview: must be a number ≥ 0.05");
  });
  test("missing root, repeat needing exactly one layout, tube radii length", () => {
    expect(issues({})).toContain("root: required");
    expect(issues({ root: { kind: "repeat", child: { kind: "sphere", r: 1 } } }))
      .toContain("root: repeat needs exactly one of `linear` or `polar`");
    expect(issues({ root: { kind: "tube", points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], r: [1, 1] } }))
      .toContain("root.r: needs one radius per point (3)");
  });
  test("texture images must be declared when imageNames is given", () => {
    const spec = { root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return 0.0;", textures: { skin: { image: "skinMap" } } } };
    expect(issues(spec, { imageNames: new Set(["skinMap"]) })).toEqual([]);
    expect(issues(spec, { imageNames: new Set() })).toContain('root.textures.skin.image: unknown image "skinMap" — declare it in the part\'s `images` field');
  });
  test("every documented kind has a schema", () => {
    for (const k of ["sphere", "ellipsoid", "capsule", "box", "cylinder", "torus", "tube", "halfspace",
      "union", "intersect", "subtract", "mirror", "round", "onion", "displace", "twist", "bend", "taper", "repeat", "expr"]) {
      expect(NODE_KINDS[k], k).toBeTruthy();
    }
  });
});

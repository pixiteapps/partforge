import { describe, it, expect } from "vitest";
import { distanceFor } from "../src/framework/domains/kinematics/shapes.js";
import { SpecError } from "../src/framework/geometry/errors.js";

const TOL = 1e-9;
/** Each case: a node and [probe, expected distance] pairs, computed by hand. */
const near = (node, probes) => {
  const d = distanceFor(node);
  for (const [p, want] of probes) expect(Math.abs(d(...p) - want), `${JSON.stringify(node)} at ${p}: ${d(...p)} vs ${want}`).toBeLessThanOrEqual(TOL);
};
const IMPLICIT = "needs the implicit engine — pass a distance function (x, y, z) => mm instead — implicitDistance(node) from partforge/geometry makes one";

describe("shapes.js closed-form distances", () => {
  it("sphere (with at)", () => {
    near({ kind: "sphere", r: 5, at: [1, 2, 3] }, [[[1, 2, 3], -5], [[6, 2, 3], 0], [[1, 2, 13], 5]]);
  });

  it("ellipsoid: min(r)·(|p/r| − 1)", () => {
    near({ kind: "ellipsoid", r: [2, 4, 8] }, [[[0, 0, 0], -2], [[1, 0, 0], -1], [[2, 0, 0], 0], [[0, 8, 0], 2]]);
  });

  it("capsule: a defaults to the origin; an explicit a", () => {
    near({ kind: "capsule", b: [0, 10, 0], r: 2 }, [[[0, 5, 0], -2], [[2, 5, 0], 0], [[0, 15, 0], 3], [[0, -4, 0], 2]]);
    near({ kind: "capsule", a: [1, 1, 1], b: [1, 1, 11], r: 1 }, [[[1, 1, 6], -1], [[2, 1, 6], 0], [[4, 5, 6], 4]]);
    // [r, r] is the plain capsule.
    near({ kind: "capsule", b: [0, 10, 0], r: [2, 2] }, [[[0, 5, 0], -2], [[2, 5, 0], 0], [[0, 15, 0], 3]]);
  });

  it("tapered capsule r [3, 1] is a round cone", () => {
    // Side slope: sin α = (3 − 1) / 10 = 0.2, cos α = √0.96; side distance ρ·cos α + y·sin α − r1.
    const c = Math.sqrt(0.96);
    near({ kind: "capsule", b: [0, 10, 0], r: [3, 1] }, [
      [[10, 5, 0], 10 * c + 1 - 3],
      [[0, 5, 0], 1 - 3],
      [[2 / c, 5, 0], 0],
      [[0, -5, 0], 2],          // past the r1 end: the sphere at a
      [[0, 14, 0], 3],          // past the r2 end: the sphere at b
    ]);
  });

  it("box (plain and rounded, with at)", () => {
    near({ kind: "box", size: [4, 6, 8] }, [[[0, 0, 0], -2], [[2, 0, 0], 0], [[5, 0, 0], 3], [[3, 4, 5], Math.sqrt(3)]]);
    near({ kind: "box", size: [4, 6, 8], round: 1, at: [0, 0, 10] }, [
      [[0, 0, 10], -2], [[2, 0, 10], 0],
      [[3, 4, 14], 2],          // past the rounded corner: |(2, 2, 1)| − 1
    ]);
  });

  it("cylinder: default axis z, rounded, axis x and y with at", () => {
    near({ kind: "cylinder", r: 3, h: 10 }, [[[0, 0, 0], -3], [[3, 0, 0], 0], [[0, 0, 8], 3], [[6, 0, 9], 5]]);
    near({ kind: "cylinder", r: 3, h: 10, round: 1 }, [[[0, 0, 0], -3], [[0, 0, 5], 0], [[5, 0, 6], Math.sqrt(13) - 1]]);
    near({ kind: "cylinder", r: 3, h: 10, at: [0, 5, 0], axis: "x" }, [[[0, 5, 1], -2], [[4, 5, 3], 0], [[7, 5, 0], 2], [[0, 10, 0], 2]]);
    near({ kind: "cylinder", r: 2, h: 6, at: [1, 1, 1], axis: "y" }, [[[1, 1, 1], -2], [[1, 4, 1], 0], [[4, 1, 1], 1], [[1, 9, 1], 5]]);
    // A vector axis: [0, 0, -2] is the z axis again.
    near({ kind: "cylinder", r: 3, h: 10, axis: [0, 0, -2] }, [[[0, 0, 0], -3], [[3, 0, 0], 0], [[0, 0, 8], 3]]);
  });

  it("torus: default axis z, axis x and y with at", () => {
    near({ kind: "torus", R: 10, r: 2 }, [[[10, 0, 0], -2], [[12, 0, 0], 0], [[0, 0, 0], 8], [[10, 0, 5], 3]]);
    near({ kind: "torus", R: 10, r: 2, axis: "x", at: [0, 0, 5] }, [[[0, 10, 5], -2], [[0, 0, 17], 0], [[3, 10, 5], 1], [[0, 0, 5], 8]]);
    near({ kind: "torus", R: 10, r: 2, axis: "y" }, [[[10, 0, 0], -2], [[0, 0, 12], 0], [[0, 10, 0], 10 * Math.SQRT2 - 2]]);
  });

  it("halfspace: normal·p − offset (with at, a vector normal)", () => {
    near({ kind: "halfspace", normal: "z", offset: 2 }, [[[0, 0, 0], -2], [[5, 5, 2], 0], [[0, 0, 7], 5]]);
    near({ kind: "halfspace", normal: [0, 3, 4], at: [0, 0, 1] }, [[[0, 0, 0], -0.8], [[0, 0, 1], 0], [[0, 5, 1], 3]]);
  });

  it("tube: one capsule per segment, one radius or one per point", () => {
    near({ kind: "tube", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], r: 1 }, [
      [[5, 0, 0], -1], [[5, 1, 0], 0], [[5, -3, 0], 2], [[10, 5, 0], -1], [[13, 5, 0], 2],
    ]);
    const c = Math.sqrt(0.96);
    near({ kind: "tube", points: [[0, 0, 0], [0, 10, 0]], r: [3, 1] }, [[[10, 5, 0], 10 * c - 2], [[0, -5, 0], 2]]);
  });

  it("a plain union is the min of its children (at translates them all)", () => {
    const kids = [{ kind: "sphere", r: 1 }, { kind: "box", size: [2, 2, 2], at: [5, 0, 0] }, { kind: "cylinder", r: 1, h: 4, axis: "x", at: [0, 4, 0] }];
    const at = [1, -2, 3];
    const u = distanceFor({ kind: "union", at, children: kids });
    const u0 = distanceFor({ kind: "union", k: 0, children: kids });
    const ds = kids.map((k) => distanceFor(k));
    for (const p of [[0, 0, 0], [2, -2, 3], [6, -2, 3], [1, 2, 3], [3.3, 0.1, -4], [10, 10, 10]]) {
      const l = [p[0] - at[0], p[1] - at[1], p[2] - at[2]];
      expect(u(...p)).toBe(Math.min(...ds.map((d) => d(...l))));
      expect(u0(...l)).toBe(Math.min(...ds.map((d) => d(...l))));
    }
    near({ kind: "union", children: [{ kind: "sphere", r: 1 }, { kind: "sphere", r: 1, at: [5, 0, 0] }] }, [[[2, 0, 0], 1], [[5, 0, 0], -1]]);
  });

  describe("refusals", () => {
    it("a blended union needs the implicit engine", () => {
      expect(() => distanceFor({ kind: "union", k: 2, children: [{ kind: "sphere", r: 1 }] })).toThrow(`grip.around: a blended union ${IMPLICIT}`);
    });
    it("an implicit-only kind needs the implicit engine", () => {
      expect(() => distanceFor({ kind: "twist", degPerMm: 2, child: { kind: "sphere", r: 1 } })).toThrow(`grip.around: node kind "twist" ${IMPLICIT}`);
      expect(() => distanceFor({ kind: "union", children: [{ kind: "sphere", r: 1 }, { kind: "subtract", children: [] }] }))
        .toThrow(`grip.around.children[1]: node kind "subtract" ${IMPLICIT}`);
    });
    it("a frame is refused", () => {
      expect(() => distanceFor({ kind: "sphere", r: 1, frame: "palm" })).toThrow('grip.around: shapes are in part coordinates; drop "frame"');
    });
    it("errors are SpecErrors and go through a caller's fail", () => {
      let caught;
      try { distanceFor({ kind: "twist" }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(SpecError);
      const fail = (field, msg) => { throw new Error(`X.${field}: ${msg}`); };
      expect(() => distanceFor({ kind: "bend" }, { fail })).toThrow(`X.grip.around: node kind "bend" ${IMPLICIT}`);
    });
  });

  describe("grammar checks", () => {
    const bad = [
      [{ kind: "sphere", r: -1 }, "grip.around.r: must be a number > 0"],
      [{ kind: "sphere" }, "grip.around.r: required"],
      [{ kind: "sphere", r: 1, size: 2 }, 'grip.around: unknown field "size"'],
      [{ kind: "sphere", r: 1, at: [0, 0] }, "grip.around.at: must be [x, y, z]"],
      [{ kind: "ellipsoid", r: [1, 0, 1] }, "grip.around.r: must be [x, y, z] with every value > 0"],
      [{ kind: "capsule", b: [0, 1, 0], r: [1, 2, 3] }, "grip.around.r: must be a number > 0 or [r0, r1] with both > 0"],
      [{ kind: "box", size: [2, 2, 2], round: -1 }, "grip.around.round: must be a number ≥ 0"],
      [{ kind: "box", size: [2, 4, 6], round: 1.5 }, "grip.around.round: must be at most half the smallest size (1)"],
      [{ kind: "cylinder", r: 2, h: 2, round: 1.5 }, "grip.around.round: must be at most min(r, h/2)"],
      [{ kind: "cylinder", r: 2, h: 2, axis: "w" }, 'grip.around.axis: must be "x", "y", "z" or a non-zero [x, y, z]'],
      [{ kind: "torus", R: 5, r: 1, axis: [0, 0, 0] }, 'grip.around.axis: must be "x", "y", "z" or a non-zero [x, y, z]'],
      [{ kind: "tube", points: [[0, 0, 0]], r: 1 }, "grip.around.points: must be at least two [x, y, z] points"],
      [{ kind: "tube", points: [[0, 0, 0], [1, 0, 0]], r: [1, 1, 1] }, "grip.around.r: needs one radius per point (2)"],
      [{ kind: "tube", points: [[0, 0, 0], [1, 0, 0]], r: [1, 0] }, "grip.around.r: must be a number > 0 or one number > 0 per point"],
      [{ kind: "halfspace", normal: "z", offset: NaN }, "grip.around.offset: must be a finite number"],
      [{ kind: "union", children: [] }, "grip.around.children: must be a non-empty array of nodes"],
      [{ kind: "union", children: [{ kind: "sphere", r: 1 }, 3] }, "grip.around.children[1]: must be a node object"],
      [{ kind: "blob" }, 'grip.around.kind: unknown kind "blob" (expected one of sphere, ellipsoid, capsule, box, cylinder, torus, tube, halfspace, union)'],
    ];
    for (const [node, msg] of bad) it(msg, () => expect(() => distanceFor(node)).toThrow(msg));
    it("accepts a label", () => { expect(distanceFor({ kind: "sphere", r: 1, label: "ball" })(0, 0, 0)).toBe(-1); });
  });
});

import { describe, it, expect } from "vitest";
import { IDENTITY, compose, invert, translation, rotation, axisVector, xformPoint, xformDir, resolveFrames } from "../src/framework/geometry/xform.js";
import { SpecError } from "../src/framework/geometry/errors.js";

const near = (A, B, tol) => { for (let i = 0; i < 12; i++) expect(Math.abs(A[i] - B[i])).toBeLessThan(tol); };

describe("xform", () => {
  it("compose and invert round-trip a rigid transform", () => {
    const M = compose(translation([3, -7, 11]), compose(rotation([1, 2, 3], 47), rotation("x", -130)));
    near(compose(M, invert(M)), IDENTITY, 1e-12);
    near(compose(invert(M), M), IDENTITY, 1e-12);
  });

  it("rotation z 90 maps +x to +y", () => {
    const out = [0, 0, 0];
    xformDir(out, rotation("z", 90), 1, 0, 0);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(1, 12);
    expect(out[2]).toBeCloseTo(0, 12);
  });

  it("xformPoint applies the translation, xformDir does not", () => {
    const M = translation([1, 2, 3]);
    const p = [0, 0, 0], d = [0, 0, 0];
    xformPoint(p, M, 1, 1, 1);
    xformDir(d, M, 1, 1, 1);
    expect(p).toEqual([2, 3, 4]);
    expect(d).toEqual([1, 1, 1]);
  });

  it("resolveFrames resolves a three-level chain to the product of its locals", () => {
    const frames = {
      a: { at: [1, 0, 0], rotate: { axis: "z", deg: 90 } },
      b: { parent: "a", at: [0, 2, 0], rotate: [{ axis: "x", deg: 30 }, { axis: "y", deg: 20 }] },
      c: { parent: "b", at: [0, 0, 3] },
    };
    const m = resolveFrames(frames);
    const la = compose(translation([1, 0, 0]), rotation("z", 90));
    const lb = compose(translation([0, 2, 0]), compose(rotation("x", 30), rotation("y", 20)));
    const lc = translation([0, 0, 3]);
    near(m.get("c").world, compose(la, compose(lb, lc)), 1e-12);
    near(compose(m.get("c").world, m.get("c").inv), IDENTITY, 1e-12);
  });

  it("an unknown parent throws SpecError naming the frame", () => {
    let e;
    try { resolveFrames({ a: { parent: "nope" } }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(SpecError);
    expect(e.code).toBe("SPEC");
    expect(e.issues).toEqual(['frames.a.parent: unknown frame "nope"']);
    expect(e.message).toBe('frames.a.parent: unknown frame "nope"');
  });

  it("a cycle throws SpecError naming the frame", () => {
    let e;
    try { resolveFrames({ a: { parent: "b" }, b: { parent: "a" } }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(SpecError);
    expect(e.issues[0]).toMatch(/is its own ancestor/);
    expect(e.issues[0]).toMatch(/frames\.[ab]/);
  });

  it("axisVector rejects zero-length and unknown axes", () => {
    expect(() => axisVector([0, 0, 0])).toThrow(SpecError);
    expect(() => axisVector([0, 0, 0])).toThrow("has zero length");
    expect(() => axisVector("w")).toThrow('unknown axis "w"');
    expect(axisVector([0, 3, 4])).toEqual([0, 0.6, 0.8]);
  });
});

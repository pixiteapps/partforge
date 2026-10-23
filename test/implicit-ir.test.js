// test/implicit-ir.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";

const lower = (spec, images = new Map()) => lowerSpec(spec, { images });
const at = (c, p) => evalReference(c, p[0], p[1], p[2]);

describe("lowering + reference", () => {
  test("frames are absolute, `at` is relative to the frame", () => {
    const c = lower({
      frames: { f: { at: [10, 0, 0], rotate: { axis: "z", deg: 90 } } },
      root: { kind: "union", children: [{ kind: "sphere", r: 1, frame: "f", at: [0, 5, 0] }] },
    });
    expect(at(c, [5, 0, 0])).toBeCloseTo(-1, 12);   // f's local +y is world −x
  });
  test("nested `at` composes with the parent's placement", () => {
    const c = lower({ root: { kind: "union", at: [0, 0, 10], children: [{ kind: "sphere", r: 1, at: [3, 0, 0] }] } });
    expect(at(c, [3, 0, 10])).toBeCloseTo(-1, 12);
  });
  test("subtract and blended union", () => {
    const c = lower({ root: { kind: "subtract", children: [{ kind: "sphere", r: 5 }, { kind: "sphere", r: 3 }] } });
    expect(at(c, [0, 0, 0])).toBe(3);
    expect(at(c, [4, 0, 0])).toBe(-1);
    const u = lower({ root: { kind: "union", k: 2, children: [{ kind: "sphere", r: 1, at: [-1.5, 0, 0] }, { kind: "sphere", r: 1, at: [1.5, 0, 0] }] } });
    expect(at(u, [0, 0, 0])).toBeLessThan(0.5);                                  // blended past the hard union's 0.5
  });
  test("repeat places count instances; tube is a chain of capsules", () => {
    const c = lower({ root: { kind: "repeat", linear: { step: [10, 0, 0], count: 3 }, child: { kind: "sphere", r: 1 } } });
    expect(at(c, [20, 0, 0])).toBeCloseTo(-1, 12);
    expect(at(c, [30, 0, 0])).toBeCloseTo(9, 12);
    const p = lower({ root: { kind: "repeat", polar: { count: 4 }, child: { kind: "sphere", r: 1, at: [5, 0, 0] } } });
    expect(at(p, [0, 5, 0])).toBeCloseTo(-1, 9);
    const t = lower({ root: { kind: "tube", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], r: 1 } });
    expect(at(t, [10, 5, 0])).toBeCloseTo(-1, 12);
  });
  test("mirror, round, onion, twist, bend, taper", () => {
    expect(at(lower({ root: { kind: "mirror", plane: "yz", child: { kind: "sphere", r: 1, at: [4, 0, 0] } } }), [-4, 0, 0])).toBeCloseTo(-1, 12);
    expect(at(lower({ root: { kind: "round", r: 1, child: { kind: "sphere", r: 1 } } }), [0, 0, 2])).toBeCloseTo(0, 12);
    expect(at(lower({ root: { kind: "onion", t: 0.5, child: { kind: "sphere", r: 3 } } }), [0, 0, 0])).toBeCloseTo(2.5, 12);
    const tw = lower({ root: { kind: "twist", degPerMm: 9, child: { kind: "box", size: [8, 2, 20] } } });
    expect(at(tw, [0, 3.9, 9])).toBeLessThan(0);                               // 81° at z = 9: the slab has turned almost onto y
    const bd = lower({ root: { kind: "bend", radius: 20, child: { kind: "capsule", a: [0, 0, 0], b: [0, 0, 15], r: 1 } } });
    expect(at(bd, [20 - 20 * Math.cos(0.5), 0, 20 * Math.sin(0.5)])).toBeCloseTo(-1, 9);
    const tp = lower({ root: { kind: "taper", from: [0, 1], to: [10, 0.5], child: { kind: "cylinder", h: 20, r: 4 } } });
    expect(at(tp, [3.9, 0, -5])).toBeLessThan(0);
    expect(at(tp, [3.9, 0, 9.9])).toBeGreaterThan(0);
  });
  test("expr nodes, uniforms and textures", () => {
    const data = Uint16Array.from([0, 65535, 0, 65535]);
    const images = new Map([["ramp", { digest: "r1", width: 2, height: 2, data }]]);
    const c = lower({ root: { kind: "expr", box: [[-5, -5, -5], [5, 5, 5]], sdf: "return length(p) - r - texture(t, vec2(1.0, 0.0));", uniforms: { r: 2 }, textures: { t: { image: "ramp" } } } }, images);
    expect(at(c, [0, 0, 4])).toBeCloseTo(1, 6);
    expect(c.digests).toEqual(["r1"]);
  });
  test("bounds, thin, and spec errors from expr source", () => {
    const c = lower({ root: { kind: "union", k: 2, children: [{ kind: "sphere", r: 1 }, { kind: "box", size: [2, 4, 0.6], at: [5, 0, 0] }] } });
    expect(c.bounds.min[0]).toBeLessThanOrEqual(-1);
    expect(c.bounds.max[0]).toBeGreaterThanOrEqual(6);
    expect(c.thin).toBeCloseTo(0.6, 12);
    expect(() => lower({ root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return q;" } })).toThrow(/root\.sdf: line 1: unknown name 'q'/);
    expect(() => lower({ root: { kind: "halfspace", normal: "z" } })).toThrow(/unbounded/);
    expect(() => lower({ root: { kind: "bend", radius: 2, child: { kind: "box", size: [10, 1, 1] } } })).toThrow(/bend radius/);
  });
});

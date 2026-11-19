import { describe, test, expect } from "vitest";
import { resolveFrames, xformPoint, xformDir, compose, invert, rotation, IDENTITY } from "../src/framework/geometry/implicit/frames.js";
import { ImplicitSpecError } from "../src/framework/geometry/implicit/errors.js";

const close = (a, b, eps = 1e-12) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
const apply = (M, p) => { const o = [0, 0, 0]; xformPoint(o, M, p[0], p[1], p[2]); return o; };
const dir = (M, p) => { const o = [0, 0, 0]; xformDir(o, M, p[0], p[1], p[2]); return o; };

describe("frames", () => {
  test("rotation steps apply about the frame's OWN current axes, in order", () => {
    const f = resolveFrames({ a: { rotate: [{ axis: "z", deg: 90 }, { axis: "x", deg: 90 }] } }).get("a");
    close(dir(f.world, [1, 0, 0]), [0, 1, 0]);   // local x: Rx keeps it, Rz turns it to +y
    close(dir(f.world, [0, 1, 0]), [0, 0, 1]);   // local y: Rx turns it to +z, Rz keeps z
  });
  test("parent chains compose: child `at` is in the parent's rotated frame", () => {
    const fr = resolveFrames({
      p: { at: [10, 0, 0], rotate: { axis: "z", deg: 90 } },
      c: { parent: "p", at: [0, 5, 0] },
    });
    close(apply(fr.get("c").world, [0, 0, 0]), [5, 0, 0]);
  });
  test("inv is the inverse of world", () => {
    const f = resolveFrames({ a: { at: [1, 2, 3], rotate: [{ axis: [1, 1, 0], deg: 33 }, { axis: "y", deg: -71 }] } }).get("a");
    close(Array.from(compose(f.inv, f.world)), Array.from(IDENTITY));
    close(Array.from(invert(invert(rotation("z", 40)))), Array.from(rotation("z", 40)));
  });
  test("unknown parents and cycles are spec errors naming the frame", () => {
    expect(() => resolveFrames({ a: { parent: "nope" } })).toThrow(ImplicitSpecError);
    expect(() => resolveFrames({ a: { parent: "nope" } })).toThrow(/frames\.a\.parent: unknown frame "nope"/);
    expect(() => resolveFrames({ a: { parent: "b" }, b: { parent: "a" } })).toThrow(/is its own ancestor/);
  });
});

describe("inherited property names are not frames", () => {
  test("a parent named only on Object.prototype is an unknown frame", () => {
    expect(() => resolveFrames({ a: { parent: "constructor" } })).toThrow(ImplicitSpecError);
    expect(() => resolveFrames({ a: { parent: "constructor" } })).toThrow(/frames\.a\.parent: unknown frame "constructor"/);
  });
});

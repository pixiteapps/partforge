import { describe, test, expect } from "vitest";
import { implicitFrames } from "../src/framework/geometry/implicit/frame-report.js";
import { resolveFrames } from "../src/framework/geometry/implicit/frames.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { ImplicitSpecError } from "../src/framework/geometry/implicit/errors.js";
import { SUGAR } from "../src/framework/geometry/solid-sugar.js";
import { setCoreEnabled } from "../src/framework/core/core.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";

const r3 = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };
const round = (a) => a.map(r3);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a, b, eps = 0.002) => a.forEach((v, i) => expect(Math.abs(v - b[i]), `${a} vs ${b}`).toBeLessThanOrEqual(eps));

const TWO = { root: { kind: "union", children: [
  { kind: "sphere", r: 5, at: [10, 0, 0], label: "a" },
  { kind: "box", size: [4, 4, 4], at: [-10, 0, 0], label: "b" },
] } };

describe("implicitFrames: frames", () => {
  test("frames match resolveFrames before any transform", () => {
    const spec = handSpec(HAND_POSES.fist);
    const rep = implicitFrames(spec).report();
    expect(Object.keys(rep.frames)).toEqual(Object.keys(spec.frames));
    const world = resolveFrames(spec.frames);
    for (const [name, f] of Object.entries(rep.frames)) {
      const M = world.get(name).world;
      expect(f.origin).toEqual(round([M[9], M[10], M[11]]));
      expect(f.x).toEqual(round([M[0], M[3], M[6]]));
      expect(f.y).toEqual(round([M[1], M[4], M[7]]));
      expect(f.z).toEqual(round([M[2], M[5], M[8]]));
    }
  });

  test("transforms move origins as points and axes as directions", () => {
    const f = implicitFrames(handSpec(HAND_POSES.fist));
    const a = f.report().frames["index.tip"];
    const b = f.rotateY(180).translate([1, 2, 3]).report().frames["index.tip"];
    close(b.origin, [-a.origin[0] + 1, a.origin[1] + 2, -a.origin[2] + 3]);
    close(b.x, [-a.x[0], a.x[1], -a.x[2]]);
  });

  test("axes stay unit after scale and mirror", () => {
    const f = implicitFrames(handSpec()).scale(2, [5, 0, 0]).mirror("XY").rotate(30, [0, 0, 0], [1, 1, 0]);
    const rep = f.report();
    expect(rep.mirrored).toBe(true);
    for (const { x, y, z } of Object.values(rep.frames)) {
      for (const a of [x, y, z]) expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThanOrEqual(0.002);
      expect(Math.abs(dot(x, y))).toBeLessThanOrEqual(0.002);
      expect(Math.abs(dot(y, z))).toBeLessThanOrEqual(0.002);
      close(cross(x, y), z.map((v) => -v), 0.003);
    }
    const back = f.mirror("YZ").report();
    expect(back.mirrored).toBe(false);
    for (const { x, y, z } of Object.values(back.frames)) close(cross(x, y), z, 0.003);
  });

  test("sugar matches primitives", () => {
    const f = implicitFrames(handSpec());
    expect(f.rotateX).toBe(SUGAR.rotateX);
    expect(f.rotateX(25).report()).toEqual(f.rotate(25, [0, 0, 0], [1, 0, 0]).report());
    expect(f.rotateY(25).report()).toEqual(f.rotate(25, [0, 0, 0], [0, 1, 0]).report());
    expect(f.rotateZ(25).report()).toEqual(f.rotate(25, [0, 0, 0], [0, 0, 1]).report());
    expect(f.rotateAbout({ axis: "Y", deg: 40, through: [1, 2, 3] }).report()).toEqual(f.rotate(40, [1, 2, 3], [0, 1, 0]).report());
    expect(f.along("+X").report()).toEqual(f.rotate(90, [0, 0, 0], [0, 1, 0]).report());
    expect(f.at([1, 2, 3]).report()).toEqual(f.translate([1, 2, 3]).report());
  });

  test("no frames reports {}", () => {
    expect(implicitFrames({ root: { kind: "sphere", r: 1 } }).report()).toEqual({ frames: {}, labels: {}, mirrored: false });
  });

  test("rounding and negative zero", () => {
    const walk = (v) => {
      if (typeof v === "number") { expect(Math.round(v * 1000) / 1000).toBe(v); expect(Object.is(v, -0)).toBe(false); }
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(implicitFrames(handSpec(HAND_POSES.fist)).rotateY(180).report());
  });
});

describe("implicitFrames: labels", () => {
  test("labels: boxes contain their pieces", () => {
    const f = implicitFrames(TWO);
    expect(f.report().labels.a).toEqual({ min: [5, -5, -5], max: [15, 5, 5], center: [10, 0, 0], approximate: true });
    const moved = f.translate([0, 0, 7]).report().labels;
    expect(moved.a.min[2]).toBe(2);
    expect(moved.b).toEqual({ min: [-12, -2, 5], max: [-8, 2, 9], center: [-10, 0, 7], approximate: true });
  });

  test("duplicate labels report the union of their boxes", () => {
    const rep = implicitFrames({ root: { kind: "union", children: [
      { kind: "sphere", r: 5, at: [10, 0, 0], label: "x" },
      { kind: "sphere", r: 5, at: [-10, 0, 0], label: "x" },
    ] } }).report();
    expect(rep.labels.x.min[0]).toBe(-15);
    expect(rep.labels.x.max[0]).toBe(15);
  });

  test("labels cover repeat instances and mirror copies", () => {
    const rep = implicitFrames({ root: { kind: "repeat", linear: { count: 3, step: [10, 0, 0] },
      child: { kind: "sphere", r: 2, label: "s" } } }).report();
    expect(rep.labels.s.max[0]).toBe(22);
    expect(rep.labels.s.min[0]).toBe(-2);
    const m = implicitFrames({ root: { kind: "mirror", plane: "yz",
      child: { kind: "sphere", r: 2, at: [10, 0, 0], label: "s" } } }).report();
    expect(m.labels.s.min[0]).toBe(-12);
    expect(m.labels.s.max[0]).toBe(12);
  });

  test("labels under a warp or round report the outer distorting box", () => {
    const twist = { kind: "twist", degPerMm: 3, label: "outer", child: { kind: "box", size: [20, 4, 30], label: "inner" } };
    const rep = implicitFrames({ root: twist }).report();
    expect(rep.labels.inner).toEqual(rep.labels.outer);
    expect(rep.labels.inner.max[1]).toBeGreaterThan(2);   // the twist sweeps the 4 mm side out
    const rd = implicitFrames({ root: { kind: "round", r: 1, child: { kind: "sphere", r: 3, label: "s" } } }).report();
    expect(rd.labels.s.max[0]).toBeGreaterThanOrEqual(4);
  });
});

describe("implicitFrames: errors and purity", () => {
  test("bad spec throws the k.implicit error", () => {
    const bad = { frames: { a: { parent: "nope" } }, root: { kind: "sphere", r: 1 } };
    let want;
    try { compileImplicit(bad); } catch (e) { want = e; }
    expect(want).toBeInstanceOf(ImplicitSpecError);
    expect(() => implicitFrames(bad)).toThrow(ImplicitSpecError);
    expect(() => implicitFrames(bad)).toThrow(want.message);
  });

  test("bad transform arguments", () => {
    const f = implicitFrames(TWO);
    expect(() => f.scale(0)).toThrow("scale: factor must be > 0");
    expect(() => f.mirror("Q")).toThrow('mirror: unknown plane "Q" (use "XY"|"XZ"|"YZ")');
    expect(() => f.along("up")).toThrow('along: unknown direction "up"');
  });

  test("immutable and deterministic", () => {
    const f = implicitFrames(handSpec(HAND_POSES.fist));
    expect(Object.isFrozen(f)).toBe(true);
    const before = JSON.stringify(f.report());
    f.translate([1, 0, 0]);
    expect(JSON.stringify(f.report())).toBe(before);
    expect(JSON.stringify(implicitFrames(handSpec(HAND_POSES.fist)).report())).toBe(before);
    setCoreEnabled(false);
    try { expect(JSON.stringify(implicitFrames(handSpec(HAND_POSES.fist)).report())).toBe(before); }
    finally { setCoreEnabled(true); }
  });
});

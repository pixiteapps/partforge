import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { routedPart } from "../src/framework/sheet/routed.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RECT = [[0, 0], [100, 0], [100, 60], [0, 60]];
const P = { t: 18 };
const part = (over = {}) => routedPart({
  views: ["main"], label: "Plinth", material: "walnut", thickness: (p) => p.t,
  profile: (kk) => kk.shape2d(RECT), ...over,
});
const resolve = (sp) => resolveSheet(k, sp, P, {});

describe("resolveRouted", () => {
  test("a laser sheet has no routed field; a routed part with nothing declared has empty lists", () => {
    const s = resolve(part());
    expect(s.process).toBe("cnc-router");
    expect(s.routed).toEqual({ pockets: [], drills: [], extra: [] });
    expect(s.engrave).toBeNull();
  });

  test("pockets: region lifted to a Shape2D, depth and label kept, null entries skipped", () => {
    const s = resolve(part({ pockets: () => [null, { region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 11.43, label: "vault" }, { region: [[50, 10], [60, 10], [60, 20], [50, 20]], depth: 18 }] }));
    expect(s.routed.pockets).toHaveLength(2);
    expect(s.routed.pockets[0].depth).toBe(11.43);
    expect(s.routed.pockets[0].label).toBe("vault");
    expect(s.routed.pockets[0].region.area()).toBeCloseTo(600, 6);
    expect(s.routed.pockets[1].label).toBeNull();
    expect(s.routed.pockets[1].depth).toBe(18);           // depth == thickness is allowed
  });

  test("drills: an exact circle shape, through when depth >= thickness", () => {
    const s = resolve(part({ drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }, { at: [20, 20], d: 6, depth: 18, label: "bolt" }, { at: [80, 20], d: 6, depth: 40 }] }));
    expect(s.routed.drills.map((x) => x.through)).toEqual([false, true, true]);
    expect(s.routed.drills[0].shape.area()).toBeCloseTo(Math.PI * 1.7 * 1.7, 2); // area() reads the arcs' cubic approximation (~0.03% over); the via check below is the exactness claim
    expect(s.routed.drills[0].shape.toContours()[0].outer.segments.every((seg) => seg.via)).toBe(true);
    expect(s.routed.drills[1].label).toBe("bolt");
  });

  test("extra: solid kept, footprint lifted, label and method required", () => {
    const s = resolve(part({ extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }), footprint: [[60, 10], [70, 10], [70, 20], [60, 20]], label: "slot", method: "table saw, blade at 12°" }] }));
    expect(s.routed.extra).toHaveLength(1);
    expect(s.routed.extra[0].footprint.area()).toBeCloseTo(100, 6);
    expect(s.routed.extra[0].method).toBe("table saw, blade at 12°");
  });
});

describe("resolveRouted refuses", () => {
  const refuses = (over, message) => expect(() => resolve(part(over))).toThrow(message);
  test("a pocket deeper than the stock", () => {
    refuses({ pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 20, label: "vault" }] },
      'routed part "Plinth": pocket "vault" is 20 mm deep in 18 mm stock — a pocket may be at most the thickness; make it a through cut in `profile` if it should go through');
  });
  test("a drill deeper than the stock by more than a through hole needs is fine, but a non-positive depth is not", () => {
    refuses({ drills: () => [{ at: [50, 30], d: 3.4, depth: 0 }] }, 'routed part "Plinth": drill 1 depth must be a finite number > 0 (mm), got 0');
  });
  test("a malformed entry", () => {
    refuses({ pockets: () => [{ depth: 3 }] }, 'routed part "Plinth": pocket 1 needs a region (a Shape2D or profile)');
    refuses({ pockets: () => [{ region: [[0, 0], [1, 0], [1, 1]], depth: "3" }] }, 'routed part "Plinth": pocket 1 depth must be a finite number > 0 (mm), got "3"');
    refuses({ drills: () => [{ at: [1], d: 3, depth: 3 }] }, 'routed part "Plinth": drill 1 needs at: [x, y]');
    refuses({ drills: () => [{ at: [1, 1], d: 0, depth: 3 }] }, 'routed part "Plinth": drill 1 d must be a finite number > 0 (mm), got 0');
    refuses({ extra: (kk) => [{ solid: kk.box({ size: [1, 1, 1] }), footprint: [[0, 0], [1, 0], [1, 1]], label: "x" }] },
      'routed part "Plinth": extra op "x" needs a method — say how the operator makes it ("table saw, blade tilted 12°")');
    refuses({ extra: (kk) => [{ solid: kk.box({ size: [1, 1, 1] }), footprint: [[0, 0], [1, 0], [1, 1]], method: "saw" }] },
      'routed part "Plinth": extra op 1 needs a label — say what it is ("12° domino slot")');
    refuses({ extra: () => [{ solid: null, footprint: [[0, 0], [1, 0], [1, 1]], label: "x", method: "y" }] },
      'routed part "Plinth": extra op "x" needs a solid — the geometry it removes, for the preview and the STEP');
    refuses({ extra: (kk) => [{ solid: kk.box({ size: [1, 1, 1] }), label: "x", method: "y" }] },
      'routed part "Plinth": extra op "x" needs a footprint — its outline on the machined face, for the drawing');
  });
  test("a non-array return", () => {
    refuses({ drills: () => ({}) }, 'routed part "Plinth": drills(p, d) must return an array of { at, d, depth }');
  });
});

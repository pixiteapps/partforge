import { describe, expect, test } from "vitest";
import { unionMany } from "../src/framework/geometry/union-many.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { textGlyphs } from "../src/framework/geometry/text2d.js";

// A stand-in Shape2D: an axis-aligned box that counts the booleans run on it.
// `parts` is how many input shapes a union result covers — enough to check the
// reduction's balance without a kernel.
function fakes(boxes) {
  const log = { unions: [] };
  const make = (min, max, parts, ids) => ({
    min, max, parts, ids,
    boundingBox: () => ({ min, max }),
    union(o) {
      log.unions.push([this.parts, o.parts]);
      return make([Math.min(min[0], o.min[0]), Math.min(min[1], o.min[1])],
        [Math.max(max[0], o.max[0]), Math.max(max[1], o.max[1])], parts + o.parts, [...ids, ...o.ids]);
    },
    toContours: () => [{ ids }],
  });
  const shapes = boxes.map(([x0, y0, x1, y1], i) => make([x0, y0], [x1, y1], 1, [i]));
  const fromContours = (regions) => ({ concatenated: regions.flatMap((r) => r.ids) });
  return { shapes, fromContours, log };
}

describe("unionMany", () => {
  test("shapes whose boxes do not touch are concatenated with no boolean at all", () => {
    const { shapes, fromContours, log } = fakes([[0, 0, 1, 1], [2, 0, 3, 1], [0, 2, 1, 3], [5, 5, 6, 6]]);
    const out = unionMany(shapes, fromContours);
    expect(log.unions).toEqual([]);
    expect(out.concatenated).toEqual([0, 1, 2, 3]);            // input order, deterministic
  });

  test("overlapping and edge-touching shapes are fused; disjoint clusters stay apart", () => {
    // 0–1 overlap, 1–2 share an edge (touching must still fuse), 3 stands alone.
    const { shapes, fromContours, log } = fakes([[0, 0, 2, 1], [1, 0, 3, 1], [3, 0, 4, 1], [10, 0, 11, 1]]);
    const out = unionMany(shapes, fromContours);
    expect(log.unions).toHaveLength(2);
    expect(out.concatenated).toEqual([0, 1, 2, 3]);
  });

  test("a cluster that needs booleans is reduced in a balanced tree, not a left fold", () => {
    const n = 16;
    const boxes = Array.from({ length: n }, (_, i) => [i, 0, i + 1.5, 1]);  // a chain: every neighbour overlaps
    const { shapes, fromContours, log } = fakes(boxes);
    const out = unionMany(shapes, fromContours);
    expect(log.unions).toHaveLength(n - 1);
    expect(out.parts).toBe(n);                                  // one cluster → the union itself
    // A left fold's operand grows to n-1; a balanced tree never exceeds n/2.
    expect(Math.max(...log.unions.flat())).toBe(n / 2);
  });

  test("one shape is returned as-is and zero shapes throw", () => {
    const { shapes, fromContours } = fakes([[0, 0, 1, 1]]);
    expect(unionMany(shapes, fromContours)).toBe(shapes[0]);
    expect(() => unionMany([], fromContours)).toThrow(/no shapes/);
  });
});

describe("text2d through unionMany (bundled Roboto)", () => {
  const leftFold = (k, regions) => regions.map((r) => k.shape2d.trusted(r)).reduce((a, b) => a.union(b));

  test("multi-line text matches the old left-fold union exactly", async () => {
    const k = await bootManifoldKernel();
    const str = "We appreciate your hard work,\nand your patronage — PLEASE\n• use the brush #2 & flush.";
    const opts = { size: 2.7, lineHeight: 4.1 };
    const fast = k.text2d(str, opts);
    k.text2d("x");                                              // ensure the default font is parsed
    const slow = leftFold(k, textGlyphs(k._defaultFont, str, opts));
    expect(fast.area()).toBeCloseTo(slow.area(), 9);
    expect(fast.toContours()).toHaveLength(slow.toContours().length);
    expect(fast.boundingBox()).toEqual(slow.boundingBox());
  });

  test("letters pushed into each other by negative tracking still fuse into one region", async () => {
    const k = await bootManifoldKernel();
    const opts = { size: 10, tracking: -1.5 };
    const glyphRegions = (k.text2d("x"), textGlyphs(k._defaultFont, "AVATAR", opts));
    const fast = k.text2d("AVATAR", opts);
    expect(fast.toContours().length).toBeLessThan(glyphRegions.length);
    expect(fast.area()).toBeCloseTo(leftFold(k, glyphRegions).area(), 9);
  });

  test("the result is deterministic (same string, same hash) — build purity rests on it", async () => {
    const k = await bootManifoldKernel();
    expect(k.text2d("Hello, world\nline two")._hash).toBe(k.text2d("Hello, world\nline two")._hash);
  });
});

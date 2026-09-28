// Corner ownership, proven FIRST (spec risk #2: until this ran it was a paper argument).
// fingerBox's five panels, extruded and posed exactly the way sheetPart will pose them,
// must assemble on Manifold into exactly the open box: no two panels interpenetrate,
// the union has the box's volume, and every corner cube belongs to exactly one panel.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { fingerBox } from "../src/framework/sheet/joinery.js";
import { poseSteps } from "../src/framework/sheet/pose.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const NAMES = ["bottom", "front", "back", "left", "right"];

// The canonical solid (profile in XY, z ∈ [0, t]) carried through the pose's steps.
const posedPanel = (panel, t) => poseSteps(panel.pose, t).reduce(
  (s, st) => (st.t === "translate" ? s.translate(st.v) : s.rotate(st.deg, st.center, st.axis)),
  k.shape2d(panel.outline).extrude({ h: t }),
);

const CASES = [
  { width: 160, depth: 110, height: 80, thickness: 3 },
  { width: 97.3, depth: 61, height: 43.5, thickness: 2.7 },  // "3 mm" ply that measured 2.7
];

describe.each(CASES)("fingerBox $width × $depth × $height, t = $thickness", ({ width: W, depth: D, height: H, thickness: t }) => {
  test("each outline sits in its own frame, bbox [0, 0]–size", () => {
    const box = fingerBox({ width: W, depth: D, height: H, thickness: t, clearance: 0 });
    const want = { bottom: [W, D], front: [W, H], back: [W, H], left: [D, H], right: [D, H] };
    expect(Object.keys(box)).toEqual(NAMES);
    for (const name of NAMES) {
      const xs = box[name].outline.map((p) => p[0]), ys = box[name].outline.map((p) => p[1]);
      expect([Math.min(...xs), Math.min(...ys)], name).toEqual([0, 0]);
      expect(box[name].size[0], name).toBeCloseTo(want[name][0], 9);
      expect(box[name].size[1], name).toBeCloseTo(want[name][1], 9);
      expect(Math.max(...xs), name).toBeCloseTo(want[name][0], 9);
      expect(Math.max(...ys), name).toBeCloseTo(want[name][1], 9);
    }
  });

  test.each([0, 0.1])("clearance %s: no two posed panels interpenetrate", (clearance) => {
    const box = fingerBox({ width: W, depth: D, height: H, thickness: t, clearance });
    const solids = NAMES.map((n) => posedPanel(box[n], t));
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++)
        expect(solids[i].intersect(solids[j]).volume(), `${NAMES[i]} ∩ ${NAMES[j]}`).toBeLessThan(1e-6);
  });

  test("clearance 0: the union is exactly the open box, W·D·H − (W−2t)(D−2t)(H−t)", () => {
    const box = fingerBox({ width: W, depth: D, height: H, thickness: t, clearance: 0 });
    const union = k.union(NAMES.map((n) => posedPanel(box[n], t)));
    const want = W * D * H - (W - 2 * t) * (D - 2 * t) * (H - t);
    expect(union.volume()).toBeCloseTo(want, 3);
    const bb = union.boundingBox();
    expect(bb.min.map((v) => +v.toFixed(6) + 0)).toEqual([-W / 2, -D / 2, 0]);
    expect(bb.max.map((v) => +v.toFixed(6) + 0)).toEqual([W / 2, D / 2, H]);
  });

  test("clearance 0: every corner cube has exactly one owner", () => {
    const box = fingerBox({ width: W, depth: D, height: H, thickness: t, clearance: 0 });
    const solids = Object.fromEntries(NAMES.map((n) => [n, posedPanel(box[n], t)]));
    const span = (s, half) => (s < 0 ? [-half, -half + t] : [half - t, half]);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z0 of [0, H - t]) {
      const [x0, x1] = span(sx, W / 2), [y0, y1] = span(sy, D / 2);
      const cube = k.box({ min: [x0, y0, z0], max: [x1, y1, z0 + t] });
      const owners = NAMES.filter((n) => solids[n].intersect(cube).volume() > 1e-6);
      expect(owners, `corner (${sx}, ${sy}, z ${z0})`).toHaveLength(1);
      expect(solids[owners[0]].intersect(cube).volume()).toBeCloseTo(t ** 3, 6);
    }
  });
});

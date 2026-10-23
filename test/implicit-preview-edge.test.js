// test/implicit-preview-edge.test.js — the automatic preview grid (implicit/preview-edge.js):
// a spec without `preview` meshes at the finest ladder edge whose predicted cost fits the
// budget. No timing here: the model's ranking is checked against the measured order, and the
// measured times live in the calibration table (feat/implicit-auto-preview).
import { describe, test, expect, beforeAll, afterEach } from "vitest";
import { compileImplicit, choosePreviewEdge } from "../src/framework/geometry/implicit/index.js";
import { previewProbe, PREVIEW_LADDER, PREVIEW_BUDGET } from "../src/framework/geometry/implicit/preview-edge.js";
import { programOps, emitProgram } from "../src/framework/geometry/implicit/program.js";
import { fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { setCoreEnabled } from "../src/framework/core/core.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handSpec, HAND_POSES, vaseSpec, BALL_BOARD } from "./fixtures/implicit-trees.js";
import { capsulePress, threePress, fingersOnPalm } from "./fixtures/implicit-seam-cases.js";

const withoutPreview = (spec) => { const { preview: _drop, ...rest } = spec; return rest; };
const edgeOf = (spec, images) => choosePreviewEdge(compileImplicit(spec, { images }));

describe("choosePreviewEdge", () => {
  afterEach(() => setCoreEnabled(true));

  test("a simple shape previews fine: the ball pressed by a board", () => {
    expect(edgeOf(BALL_BOARD)).toBeLessThanOrEqual(0.75);
  });
  test("the hand keeps today's 1.5 mm grid, open and in a fist", () => {
    expect(edgeOf(withoutPreview(handSpec()))).toBe(1.5);
    expect(edgeOf(withoutPreview(handSpec(HAND_POSES.fist)))).toBe(1.5);
  });
  test("every pick is on the ladder, and within budget unless it is the coarsest", () => {
    for (const spec of [BALL_BOARD, withoutPreview(handSpec()), capsulePress({ overlap: 1.2 })]) {
      const compiled = compileImplicit(spec), edge = choosePreviewEdge(compiled);
      expect(PREVIEW_LADDER).toContain(edge);
      const probe = previewProbe(compiled);
      expect(probe.cost(edge)).toBeLessThanOrEqual(PREVIEW_BUDGET);
      const finer = PREVIEW_LADDER[PREVIEW_LADDER.indexOf(edge) - 1];
      if (finer !== undefined) expect(probe.cost(finer)).toBeGreaterThan(PREVIEW_BUDGET);
    }
  });
  test("a shape too costly for any step takes the coarsest", () => {
    const big = { root: { kind: "union", children: [0, 1, 2, 3, 4, 5].map((i) => ({ kind: "sphere", r: 200, at: [i * 420, 0, 0] })) } };
    expect(edgeOf(big)).toBe(PREVIEW_LADDER[PREVIEW_LADDER.length - 1]);
  });
  test("deterministic: two compiles agree, and the native core does not change the pick", () => {
    const spec = withoutPreview(handSpec(HAND_POSES.nearMiss));
    const a = edgeOf(spec), b = edgeOf(structuredClone(spec));
    setCoreEnabled(false);
    const c = edgeOf(spec);
    expect([b, c]).toEqual([a, a]);
  });
  test("programOps walks a whole program (it ends on END) and counts n-ary operands", () => {
    const one = compileImplicit({ root: { kind: "sphere", r: 2 } });
    expect(programOps(emitProgram(one, fullDecision(one)))).toBe(2);   // PRIM, END
    const three = compileImplicit({ root: { kind: "union", children: [{ kind: "sphere", r: 2 }, { kind: "sphere", r: 3 }, { kind: "sphere", r: 4 }] } });
    expect(programOps(emitProgram(three, fullDecision(three)))).toBe(3 + 1 + 3 + 1);   // 3 PRIM, UNION + 3 operands, END
  });
});

// The measured order of native preview-tier meshImplicit times at a 1.5 mm grid (desktop):
// each group is slower than the one before; inside a group the times are within 3%
// (the open hand and the near miss: 237.6 and 237.7 ms). The model must rank alike.
describe("the cost model ranks the fixtures as measured", () => {
  test("at 1.5 mm", () => {
    const vase = vaseSpec();
    const groups = [
      [["threePress", threePress({ gap: 0 })]],
      [["fingersOnPalm", fingersOnPalm({ fingerGap: 0.3 })]],
      [["capsulePress", capsulePress({ overlap: 1.2 })]],
      [["ball+board", BALL_BOARD]],
      [["vase", withoutPreview(vase.spec), vase.images]],
      [["hand", withoutPreview(handSpec())], ["nearMiss", withoutPreview(handSpec(HAND_POSES.nearMiss))]],
      [["fist", withoutPreview(handSpec(HAND_POSES.fist))]],
    ].map((g) => g.map(([name, spec, images]) => ({ name, cost: previewProbe(compileImplicit(spec, { images })).cost(1.5) })));
    for (let i = 1; i < groups.length; i++) {
      const prevMax = Math.max(...groups[i - 1].map((f) => f.cost)), curMin = Math.min(...groups[i].map((f) => f.cost));
      expect(curMin, `${groups[i].map((f) => f.name)} above ${groups[i - 1].map((f) => f.name)}`).toBeGreaterThan(prevMax);
    }
  });
});

describe("k.implicit uses the automatic preview edge", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel(); });

  test("no `preview`: the solid is the chosen edge's; an explicit `preview` wins", () => {
    const spec = { root: { kind: "union", k: 1, children: [{ kind: "sphere", r: 6 }, { kind: "box", size: [16, 16, 3], round: 1, at: [0, 0, 5] }] } };
    const chosen = edgeOf(spec);
    expect(chosen).toBeLessThan(1.5);
    const auto = k.implicit(spec);
    expect(auto._hash).toBe(k.implicit({ ...spec, preview: chosen })._hash);
    const explicit = k.implicit({ ...spec, preview: 2 });
    expect(explicit._hash).not.toBe(auto._hash);
    expect(explicit._m.numTri()).toBeLessThan(auto._m.numTri());
  });
});

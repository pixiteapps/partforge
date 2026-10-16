// test/implicit-plan-inherit.test.js — hierarchical leaf planning.
//
// planLeaves hands each child block its parent block's decision, and blockDecision does
// not re-walk a slot the parent pruned with a clear margin (interval.js, "Inheriting a
// parent's decision"). The plan must be exactly what the old full walk from the IR root
// produced — same leaves, same order, same programs — so every fixture is planned both
// ways (`{ inherit: false }` is the old walk), and every block's interval and decision
// key is compared too: a child that pruned a slot the full walk keeps fails here.
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { blockDecision, decisionKey } from "../src/framework/geometry/implicit/interval.js";
import { planLeaves, LEAF, TOP, PAD_CELLS } from "../src/framework/geometry/implicit/sparse.js";
import { TREES } from "./fixtures/implicit-small-trees.js";
import { nativeCases } from "./fixtures/implicit-native-cases.js";
import { randomSpec } from "./fixtures/implicit-trees.js";

const lower = (spec, images = new Map()) => lowerSpec(spec, { images });

const CASES = [
  ...nativeCases({ pending: true }),   // every small tree (bendCut too), the vase, the hand, ADVERSARIAL, touching faces
  ...Array.from({ length: 40 }, (_, i) => ({ name: `randomSpec(${i + 1})`, spec: randomSpec(i + 1), images: new Map(), edges: [0.5, 1.0] })),
];
for (const k of CASES) if (k.name === "hand") k.edges = [1.5, 0.8, 0.5];

function expectSamePlan(a, b) {
  expect(a.n).toEqual(b.n);
  expect(a.origin).toEqual(b.origin);
  expect(a.samples).toBe(b.samples);
  expect(a.leaves).toEqual(b.leaves);
  expect(a.programs.length).toBe(b.programs.length);
  a.programs.forEach((p, i) => expect(Array.from(p)).toEqual(Array.from(b.programs[i])));
}

// The planLeaves traversal, comparing at every visited block the inherited decision
// with a full walk from the root. Returns the number of blocks compared.
function compareBlocks(c, edge) {
  const plan = planLeaves(c, edge);
  const { origin, n } = plan;
  const SQRT3 = Math.sqrt(3);
  let blocks = 0;
  const visit = (i0, j0, l0, B, parent) => {
    const r = (B * edge * SQRT3) / 2 + PAD_CELLS * edge;
    const cx = origin[0] + (i0 + B / 2) * edge, cy = origin[1] + (j0 + B / 2) * edge, cz = origin[2] + (l0 + B / 2) * edge;
    const full = blockDecision(c, cx, cy, cz, r);
    const inh = parent ? blockDecision(c, cx, cy, cz, r, parent) : full;
    blocks++;
    if (inh.lo !== full.lo || inh.hi !== full.hi || decisionKey(inh.dec) !== decisionKey(full.dec)) {
      expect({ block: [i0, j0, l0, B], lo: inh.lo, hi: inh.hi, key: decisionKey(inh.dec) }).toEqual({ block: [i0, j0, l0, B], lo: full.lo, hi: full.hi, key: decisionKey(full.dec) });
    }
    const interior = i0 > 0 && j0 > 0 && l0 > 0 && i0 + B < n[0] - 1 && j0 + B < n[1] - 1 && l0 + B < n[2] - 1;
    if (full.lo > 0 || (interior && full.hi < 0) || B <= LEAF) return;
    const h = B / 2;
    for (let dl = 0; dl < 2; dl++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const i = i0 + di * h, j = j0 + dj * h, l = l0 + dl * h;
      if (i < n[0] - 1 && j < n[1] - 1 && l < n[2] - 1) visit(i, j, l, h, inh.dec);
    }
  };
  for (let l = 0; l < n[2] - 1; l += TOP) for (let j = 0; j < n[1] - 1; j += TOP) for (let i = 0; i < n[0] - 1; i += TOP) visit(i, j, l, TOP, null);
  return blocks;
}

describe("hierarchical leaf planning", () => {
  for (const { name, spec, images, edges } of CASES) {
    test(`${name}: the inherited plan is the full walk's plan, block by block`, () => {
      const c = lower(spec, images);
      for (const edge of edges) {
        expectSamePlan(planLeaves(c, edge), planLeaves(c, edge, { inherit: false }));
        // Per-block comparison at the coarser edge only: the plan equality covers the rest.
        if (edge === Math.max(...edges)) expect(compareBlocks(c, edge)).toBeGreaterThan(0);
      }
    }, 60_000);
  }

  // The mechanism itself, on planted parent decisions: a slot the parent pruned FIRMLY
  // is not walked again (it stays pruned even where the full walk would keep it — which
  // is why the plan-equality test above is what proves the planted case never arises);
  // a slot the parent pruned without a clear margin is walked again.
  const two = lower({ root: { kind: "union", k: 1, children: [{ kind: "sphere", r: 1 }, { kind: "sphere", r: 1, at: [3, 0, 0] }] } });
  const root = two.ir.root;
  test("a firmly pruned parent slot stays pruned without being walked", () => {
    const full = blockDecision(two, 1.5, 0, 0, 1);
    expect(full.dec.kids[1]).not.toBeNull();
    const planted = { id: root, kids: [full.dec.kids[0], null], firm: [false, true] };
    const inh = blockDecision(two, 1.5, 0, 0, 1, planted);
    expect(inh.dec.kids[1]).toBeNull();
    expect(inh.dec.firm).toEqual([false, true]);
  });
  test("a parent slot pruned without a clear margin is walked again", () => {
    const full = blockDecision(two, 1.5, 0, 0, 1);
    const planted = { id: root, kids: [full.dec.kids[0], null], firm: [false, false] };
    expect(decisionKey(blockDecision(two, 1.5, 0, 0, 1, planted).dec)).toBe(decisionKey(full.dec));
  });
  test("a firm prune on one mirror side keeps the other side's interval", () => {
    const m = lower({ root: { kind: "mirror", plane: "yz", child: { kind: "sphere", r: 1, at: [5, 0, 0] } } });
    const full = blockDecision(m, 5, 0, 0, 1);
    expect(full.dec.kids[1]).toBeNull();
    expect(full.dec.firm).toEqual([false, true]);
    const inh = blockDecision(m, 5, 0, 0, 1, full.dec);
    expect([inh.lo, inh.hi, decisionKey(inh.dec)]).toEqual([full.lo, full.hi, decisionKey(full.dec)]);
  });
  test("bend branch cut: an UNBOUNDED parent hands its child a full decision", () => {
    const c = lower(TREES.bendCut);
    const parent = blockDecision(c, 15, 0, 0.4, 3);
    expect(parent.lo).toBe(-Infinity);
    const child = blockDecision(c, 15, 0, 0.4, 1, parent.dec);
    const full = blockDecision(c, 15, 0, 0.4, 1);
    expect([child.lo, child.hi, decisionKey(child.dec)]).toEqual([full.lo, full.hi, decisionKey(full.dec)]);
  });
});

// The build probe on k.subdiv(cage) bodies: it hands over each cage's snapshot, keys the
// shape on the cage's faces rather than its points, and says when a pose change can be
// drawn by moving the cage's points alone (cagePosable).
import { test, expect } from "vitest";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { createCage } from "../src/framework/geometry/subdiv/cage.js";
import { resolveParams } from "../src/framework/part-model.js";
import hand, { cageHand } from "../src/parts/cage-hand.js";
import { TWO_BONE } from "./fixtures/skin-fixtures.js";

const ctx = { view: "v", p: {}, d: {} };
const probe = (build, scope = "build", sp = { build }) => probeSubPartPose(sp, ctx, { scope });

// A box with one arm whose cap turns by `deg`; `extra` adds one more extrude on the cap.
function bentCage(make, deg, { extra = false, crease = false } = {}) {
  const c = make({ box: { size: [10, 10, 10] } });
  const cap = c.extrude("+z:0,0", { by: 6, id: "arm" });
  if (deg) c.rotate(cap, { axis: "x", deg, about: c.centroid("arm") });
  if (extra) c.extrude(cap, { by: 3, id: "tip" });
  if (crease) c.crease("arm");
  return c;
}

test.each([
  ["k.subdiv(cage)", (k, deg) => k.subdiv(bentCage(k.cage, deg))],
  ["k.subdiv(cage).cut(box)", (k, deg) => k.subdiv(bentCage(k.cage, deg)).cut(k.box([2, 2, 2]))],
])("a cage bend keeps the shape and changes the base hash: %s", (_n, build) => {
  const a = probe((k) => build(k, 0));
  const b = probe((k) => build(k, 30));
  for (const [r, deg] of [[a, 0], [b, 30]]) {
    expect(r.trusted).toBe(true);
    expect(r.cagePosable).toBe(true);
    expect(r.skinnable).toBe(false);
    expect(r.cages).toHaveLength(1);
    expect(r.cages[0].points).toEqual(bentCage(createCage, deg).snapshot().points);
  }
  expect(a.shapeHash).toBe(b.shapeHash);
  expect(a.baseHash).not.toBe(b.baseHash);
});

test("an extra extrude between the two params changes the shape", () => {
  const a = probe((k) => k.subdiv(bentCage(k.cage, 10)));
  const b = probe((k) => k.subdiv(bentCage(k.cage, 10, { extra: true })));
  expect(a.shapeHash).not.toBe(b.shapeHash);
});

test("a changed cut operand changes the shape", () => {
  const sh = (w) => probe((k) => k.subdiv(bentCage(k.cage, 0)).cut(k.box([w, 2, 2]))).shapeHash;
  expect(sh(2)).not.toBe(sh(3));
});

test.each([
  ["two k.subdiv calls", (k) => k.union([k.subdiv(bentCage(k.cage, 0)), k.subdiv(bentCage(k.cage, 10))])],
  ["a creased cage", (k) => k.subdiv(bentCage(k.cage, 0, { crease: true }))],
  ["a translated result", (k) => k.subdiv(bentCage(k.cage, 0)).translate([1, 0, 0])],
  ["a translated result, then cut", (k) => k.subdiv(bentCage(k.cage, 0)).translate([1, 0, 0]).cut(k.box([1, 1, 1]))],
  ["a box cut by the cage", (k) => k.box([20, 20, 20]).cut(k.subdiv(bentCage(k.cage, 0)))],
  ["a mirrored result", (k) => k.subdiv(bentCage(k.cage, 0)).mirror("yz")],
  ["k.implicit beside k.subdiv", (k) => k.union([k.subdiv(bentCage(k.cage, 0)), k.implicit(TWO_BONE(0))])],
])("not cage-posable: %s", (_n, build) => {
  const r = probe(build);
  expect(r.cagePosable).toBe(false);
  expect(r.cages.length).toBeGreaterThan(0);
});

test("a part with no cage reports no cages", () => {
  const r = probe((k) => k.box([1, 1, 1]));
  expect(r).toMatchObject({ cages: [], cagePosable: false });
});

test("the untrusted and throwing paths report no cage pose", () => {
  const queried = probe((k) => { const s = k.subdiv(bentCage(k.cage, 0)); s.volume(); return s; });
  expect(queried.trusted).toBe(false);
  expect(queried.cages).toHaveLength(1);
  const thrown = probe((k) => { k.subdiv(bentCage(k.cage, 0)); throw new Error("x"); });
  expect(thrown).toMatchObject({ trusted: false, cages: [], cagePosable: false });
});

test("only the throwing path says it threw", () => {
  expect(probe((k) => { k.subdiv(bentCage(k.cage, 0)); throw new Error("x"); }).threw).toBe(true);
  // A build that queries geometry is untrusted, but nothing threw.
  const queried = probe((k) => { const s = k.subdiv(bentCage(k.cage, 0)); s.boundingBox(); return s; });
  expect(queried.trusted).toBe(false);
  expect(queried.threw).toBeUndefined();
  expect(probe((k) => k.subdiv(bentCage(k.cage, 0))).threw).toBeUndefined();
});

test("a later edit to the cage does not change the snapshot already taken", () => {
  const r = probe((k) => {
    const c = bentCage(k.cage, 0);
    const s = k.subdiv(c);
    c.move("arm", [5, 5, 5]);
    return s;
  });
  expect(r.cages[0].points).toEqual(bentCage(createCage, 0).snapshot().points);
});

test("place() steps in full scope do not change cagePosable", () => {
  const sp = { build: (k) => k.subdiv(bentCage(k.cage, 0)), place: (s) => s.translate([5, 0, 0]) };
  expect(probe(null, "full", sp)).toMatchObject({ trusted: true, cagePosable: true });
});

test("a mixed implicit and cage part keeps its old skinnable answer and shape", () => {
  // The cage is a plain solid to the implicit path: its points stay in that shape.
  const sh = (deg) => probe((k) => k.union([k.implicit(TWO_BONE(0)), k.subdiv(bentCage(k.cage, deg))]));
  expect(sh(0).skinnable).toBe(true);
  expect(sh(0).shapeHash).not.toBe(sh(20).shapeHash);
});

// The reference hand: every slider at min, default and max.
const handProbe = (params) => {
  const { p, d } = resolveParams(hand, params);
  return { r: probeSubPartPose(hand.parts.hand, { view: "assembly", p, d }, { scope: "build" }), d };
};
const controls = hand.parameters.flatMap((g) => g.controls);

test("the cage hand is cage-posable, one shape across its whole slider range", () => {
  const settings = [{}, ...controls.flatMap((c) => [{ [c.key]: c.min }, { [c.key]: c.max }]),
    Object.fromEntries(controls.map((c) => [c.key, c.min])), Object.fromEntries(controls.map((c) => [c.key, c.max]))];
  const base = handProbe({}).r;
  for (const params of settings) {
    const { r, d } = handProbe(params);
    expect(r.trusted).toBe(true);
    expect(r.cagePosable).toBe(true);
    expect(r.shapeHash).toBe(base.shapeHash);
    // The probe's cage is the one the build skins from derive's limbs.
    expect(r.cages[0].points).toEqual(cageHand(createCage, d).snapshot().points);
  }
});

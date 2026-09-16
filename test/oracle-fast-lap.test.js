import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import gapPart from "./fixtures/gap-part.js";
import { verify } from "../src/framework/oracle/verify.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// ~6.7k triangles: above the diagnostic sample budget, below the gate budget, so the
// two resolutions are distinguishable on one mesh. r = 100 keeps the sphere at the
// flat 116-segment cap — smaller spheres are sized per radius (circle-segs.js's
// sphereSegs) and an r = 10 ball is 1,250 triangles, under the sample budget.
const ball = (verify) => ({
  meta: { title: "Ball", units: "mm" },
  defaults: {},
  parts: { ball: { views: ["v"], build: (kk) => kk.sphere({ r: 100 }) } },
  views: { v: { label: "V" } },
  ...(verify ? { verify } : {}),
});

test("an ungated part samples min wall at the diagnostic budget", () => {
  const s = measure(k, ball(), "v", {}, { minWall: true }).subparts[0];
  expect(s.minWall).toBeGreaterThan(0);          // the fact survives — this is a cheaper reading, not a missing one
  expect(s.minWallSampled).toBe(true);
  expect(s.minWallSamples.sampled).toBe(5_000);
  expect(s.minWallSamples.total).toBeGreaterThan(5_000);
});

// The other half of the same rule, and the half that must NOT change: a declared gate
// buys the full resolution, because its verdict rides on the reading.
test("a process profile keeps min wall at full resolution", () => {
  const s = measure(k, ball({ process: "fdm-pla" }), "v", {}, { minWall: true }).subparts[0];
  expect(s.minWallSampled).toBe(false);
  expect(s.minWallSamples.sampled).toBe(s.minWallSamples.total);
});

test("an expect mentioning minWall keeps min wall at full resolution", () => {
  const part = ball({ expect: { ball: { minWall: ">=1mm" } } });
  const s = measure(k, part, "v", {}, { minWall: true }).subparts[0];
  expect(s.minWallSampled).toBe(false);
});

test("an unresolvable profile is treated as gated, not as ungated", () => {
  const s = measure(k, ball({ process: "no-such-profile" }), "v", {}, { minWall: true }).subparts[0];
  expect(s.minWallSampled).toBe(false);
});

// ---- the quick lap: measure ----

test("measure({ gaps: false }) reports NO gap table rather than an empty one", () => {
  const r = measure(k, gapPart, "v", {}, { gaps: false });
  expect(r.measuredGaps).toBe(false);
  expect(r.gaps).toBeUndefined();     // absent, not [] — an empty table would read as
  expect(r.nearMisses).toEqual([]);   // "measured, and these pairs genuinely have no distance"
  expect(r.subparts).toHaveLength(2); // everything derived from the build it already has survives
  expect(r.overlaps).toEqual([]);
});

test("measure stamps measuredGaps true when it did measure them", () => {
  const r = measure(k, gapPart, "v");
  expect(r.measuredGaps).toBe(true);
  expect(r.nearMisses).toHaveLength(1);
});

// ---- the quick lap: verify ----
// The safety property of the whole feature: a quick lap reports FACTS, never a
// verdict. Anything a declared gate needed and did not get is `unevaluated`, and one
// unevaluated gate is enough to withhold `ok` — so a fast iteration can never be
// mistaken for a passing one.

const quickLap = (part, view = "v") => {
  const measured = measure(k, part, view, {}, { minWall: false, gaps: false });
  return verify(k, part, { view, quick: true, seed: { params: {}, result: measured } });
};

test("a quick lap withholds the verdict when a gate went unevaluated", () => {
  const part = ball({ process: "fdm-pla" });
  const r = quickLap(part);
  expect(r.ok).toBeNull();
  expect(r.unevaluated.map((c) => c.metric)).toContain("minWall");
});

test("a quick lap still FAILS a gate it can evaluate from the facts it has", () => {
  const part = ball({ expect: { ball: { holes: 7 } } });   // a sphere has 0
  const r = quickLap(part);
  expect(r.ok).toBe(false);                                 // a real failure outranks the withheld verdict
  expect(r.failures.map((c) => c.metric)).toContain("holes");
});

test("a quick lap on a part with nothing left unevaluated returns a real verdict", () => {
  const part = ball({ expect: { ball: { holes: 0 } } });
  const r = quickLap(part);
  expect(r.ok).toBe(true);
  expect(r.unevaluated).toEqual([]);
});

test("a quick lap never measures — not even a case the seed does not cover", () => {
  const part = { ...ball({ process: "fdm-pla" }), presets: { big: { label: "Big", params: {} } } };
  let calls = 0;
  const measured = measure(k, part, "v", {}, { minWall: false, gaps: false });
  const r = verify(k, part, {
    view: "v", quick: true, seed: { params: {}, result: measured },
    measureFn: (...a) => { calls++; return measure(...a); },
  });
  expect(calls).toBe(0);
  expect(r.ok).toBeNull();
});

test("an unmeasured pair gate is unevaluated, never a quiet pass", () => {
  const part = { ...gapPart, verify: { expect: { _view: { clearance: { "left×right": ">=0.1mm" } } } } };
  const r = quickLap(part, "v");
  expect(r.ok).toBeNull();
  expect(r.unevaluated.map((c) => c.metric)).toContain("clearance");
});

test("a full lap's verdict is unchanged — nothing reads as unevaluated", () => {
  const part = ball({ process: "fdm-pla" });
  const measured = measure(k, part, "v", {}, { minWall: true });
  const r = verify(k, part, { view: "v", seed: { params: {}, result: measured } });
  expect(r.ok).toBe(true);
  expect(r.unevaluated).toEqual([]);
});

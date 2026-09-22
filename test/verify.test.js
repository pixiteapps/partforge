import { expect, test } from "vitest";
import { evaluateCase } from "../src/framework/oracle/verify.js";
import { resolveProfile } from "../src/framework/oracle/dfm-profiles.js";
import { measure as measureReal } from "../src/framework/oracle/measure.js";
import { verify as verifyFromEntry } from "../src/testing.js";
import demo from "../src/parts/demo.js";

test("verify is exported from the partforge/testing entry", () => {
  expect(typeof verifyFromEntry).toBe("function");
});

const facts = {
  subparts: [{ name: "spacer", holes: 1, volume: 500, surfaceArea: 300, triangleCount: 200, bbox: [8, 8, 10], watertight: true, minWall: null }],
  aggregate: { bbox: [8, 8, 10], volume: 500 },
  overlaps: [],
};
const byKey = (checks, scope, metric) => checks.find((c) => c.scope === scope && c.metric === metric);

test("passes exact gates from profile + expect", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: { spacer: { holes: 1, volume: "0.4..0.6cm3" }, _view: { overlaps: 0 } } });
  expect(byKey(checks, "subpart", "holes").status).toBe("pass");
  expect(byKey(checks, "subpart", "volume").status).toBe("pass");
  expect(byKey(checks, "view", "overlaps").status).toBe("pass");
  expect(byKey(checks, "view", "bbox").status).toBe("pass");       // from profile.bed
});

test("min-wall with no reading is a warn (unavailable), never a fail", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/unavailable/);
});

test("a violated exact gate is a fail", () => {
  const checks = evaluateCase(facts, { profile: null, expect: { spacer: { holes: 2 } } });
  expect(byKey(checks, "subpart", "holes").status).toBe("fail");
});

test("Manifold-only facts skip on OCCT (null actual)", () => {
  const occt = { subparts: [{ name: "spacer", holes: null, watertight: null, volume: 500, surfaceArea: 1, triangleCount: 1, bbox: [8, 8, 10], minWall: null }], aggregate: { bbox: [8, 8, 10], volume: 500 }, overlaps: [] };
  const checks = evaluateCase(occt, { profile: null, expect: { spacer: { watertight: true } } });
  expect(byKey(checks, "subpart", "watertight").status).toBe("skip");
});

test("throws on an unknown metric", () => {
  expect(() => evaluateCase(facts, { profile: null, expect: { spacer: { wormholes: 1 } } })).toThrow();
});

import { beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const tube = (od, h) => ({
  meta: { title: "Tube", units: "mm" },
  defaults: { od, h, label: "a" },
  parameters: [{ id: "b", presets: { Big: { od: 20, h: 30 }, Relabel: { label: "z" } } }],
  parts: { tube: { views: ["v"], build: (kk, p) => kk.cylinder({ r: p.od / 2, h: p.h }).cut(kk.cylinder({ r: 2, h: p.h + 4 }).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
});

test("verify passes a sound part and reports a real min-wall measurement", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", expect: { tube: { holes: 1 }, _view: { overlaps: 0 } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.actual).toBeGreaterThan(1.2);   // healthy wall (~4 mm)
  expect(mw.status).toBe("pass");
});

test("verify fails a violated gate", () => {
  const part = { ...tube(12, 10), verify: { expect: { tube: { holes: 2 } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  expect(v.failures).toHaveLength(3);   // defaults + 2 presets
});

test("dedup: cases with the same param-deps signature reuse one measure call", () => {
  // "Relabel" preset changes only `label`, which the build never reads → same
  // signature as defaults; "Big" changes od/h → distinct. 3 cases, 2 measures.
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", cases: ["defaults", "Relabel", "Big"] } };
  let calls = 0;
  const measureFn = (...args) => { calls++; return measureReal(...args); };
  const v = verify(k, part, { measureFn });
  expect(v.cases).toHaveLength(3);
  expect(calls).toBe(2);
});

test("the demo part ships a passing verify block", () => {
  const v = verify(k, demo);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "M3", "M5"]);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.actual).toBeGreaterThan(1.2);   // spacer wall ~2.2 mm
  expect(mw.status).toBe("pass");
});

const factsThin = {
  subparts: [{ name: "ring", holes: 1, volume: 500, surfaceArea: 300, triangleCount: 200,
    bbox: [8, 8, 10], watertight: true, minWall: 0.8, minWallAt: [3.7, 0, 5] }],
  aggregate: { bbox: [8, 8, 10], volume: 500 },
  overlaps: [],
};

test("a failed check carries registry hint, pattern, and location", () => {
  const checks = evaluateCase(factsThin, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.hint).toMatch(/wall/);
  expect(w.pattern).toBe("minwall-sliver-triangles");
  expect(w.location).toEqual([3.7, 0, 5]);
});

test("a sampled min-wall reading is annotated, passing or not", () => {
  const sampled = (s) => ({ ...factsThin, subparts: [{ ...factsThin.subparts[0], minWall: s.minWall,
    minWallSampled: true, minWallSamples: { sampled: 50000, total: 412338 } }] });
  const warn = evaluateCase(sampled({ minWall: 0.8 }), { profile: resolveProfile("fdm-pla"), expect: {} });
  expect(byKey(warn, "subpart", "minWall").note).toMatch(/50000 of 412338/);
  const pass = evaluateCase(sampled({ minWall: 3 }), { profile: resolveProfile("fdm-pla"), expect: {} });
  expect(byKey(pass, "subpart", "minWall").status).toBe("pass");
  expect(byKey(pass, "subpart", "minWall").note).toMatch(/sampled/);
});

test("a sampled run that found NO wall is annotated too, not just 'unavailable'", () => {
  // The caveat matters most exactly here: minWall is null, so the check warns
  // "min wall unavailable" — which without the note reads like a mesh nobody
  // measured rather than one whose 50k sampled rays all missed.
  const facts = { ...factsThin, subparts: [{ ...factsThin.subparts[0], minWall: null, minWallAt: null,
    minWallSampled: true, minWallSamples: { sampled: 50000, total: 412338 } }] };
  const w = byKey(evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: {} }), "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.message).toBe("min wall unavailable");
  expect(w.note).toMatch(/50000 of 412338/);
});

test("an exact min-wall reading carries no sampling note", () => {
  const checks = evaluateCase(factsThin, { profile: resolveProfile("fdm-pla"), expect: {} });
  expect(byKey(checks, "subpart", "minWall").note).toBeUndefined();
});

test("part-authored { expr, hint } wins over the registry hint (pattern still applies)", () => {
  const checks = evaluateCase(factsThin, { profile: null,
    expect: { ring: { minWall: { expr: ">=1.2", hint: "increase `wallThickness` or reduce `twist`" } } } });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.expr).toBe(">=1.2");
  expect(w.hint).toBe("increase `wallThickness` or reduce `twist`");
  expect(w.pattern).toBe("minwall-sliver-triangles");
});

test("passing checks carry no diagnostic noise", () => {
  const checks = evaluateCase(factsThin, { profile: null, expect: { ring: { holes: 1 } } });
  const c = byKey(checks, "subpart", "holes");
  expect(c.status).toBe("pass");
  expect(c.hint).toBeUndefined();
  expect(c.pattern).toBeUndefined();
  expect(c.location).toBeUndefined();
});

test("a failing view overlaps gate locates the first offending pair", () => {
  const facts2 = { ...factsThin, overlaps: [{ a: "a", b: "b", volume: 200, location: [9, 5, 5] }] };
  const checks = evaluateCase(facts2, { profile: null, expect: { _view: { overlaps: 0 } } });
  const c = byKey(checks, "view", "overlaps");
  expect(c.status).toBe("fail");
  expect(c.hint).toMatch(/clearance|placement/);
  expect(c.location).toEqual([9, 5, 5]);
});

test("min-wall-unavailable warn still carries a hint", () => {
  const noReading = { ...factsThin, subparts: [{ ...factsThin.subparts[0], minWall: null, minWallAt: null }] };
  const checks = evaluateCase(noReading, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/unavailable/);
  expect(w.hint).toBeTruthy();
});

// ── contacts / clearance / near-miss warnings ──────────────────────────────────────────────

const twoBoxFacts = (over = {}) => ({
  subparts: [
    { name: "left", holes: 0, volume: 1000, surfaceArea: 600, triangleCount: 12, bbox: [10, 10, 10], watertight: true, minWall: null },
    { name: "right", holes: 0, volume: 1000, surfaceArea: 600, triangleCount: 12, bbox: [10, 10, 10], watertight: true, minWall: null },
  ],
  aggregate: { bbox: [20.2, 10, 10], volume: 2000 },
  overlaps: [],
  gaps: [{ a: "left", b: "right", distance: 0.2, at: [10.1, 5, 5] }],
  nearMisses: [{ a: "left", b: "right", distance: 0.2, at: [10.1, 5, 5] }],
  ...over,
});
const pairCheck = (checks, metric) => checks.find((c) => c.metric === metric);

test("an undeclared near miss is a warning with location, hint, and pattern", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null, expect: {} });
  const w = pairCheck(checks, "nearMiss");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.subpart).toBe("left×right");
  expect(w.actual).toBeCloseTo(0.2, 6);
  expect(w.location).toEqual([10.1, 5, 5]);
  expect(w.hint).toMatch(/contacts|clearance/);
  expect(w.pattern).toBe("near-miss-gap");
});

test("declaring the pair in contacts turns the near miss into a gate failure (and silences the warning)", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: [["left", "right"]] } } });
  const c = pairCheck(checks, "contact");
  expect(c.kind).toBe("gate");
  expect(c.status).toBe("fail");
  expect(c.actual).toBeCloseTo(0.2, 6);
  expect(c.location).toEqual([10.1, 5, 5]);
  expect(c.hint).toBeTruthy();
  expect(pairCheck(checks, "nearMiss")).toBeUndefined();
});

test("contacts passes on a touching pair, in either name order", () => {
  const facts = twoBoxFacts({ gaps: [{ a: "left", b: "right", distance: 0, at: [10, 5, 5] }], nearMisses: [] });
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { contacts: [["right", "left"]] } } });
  expect(pairCheck(checks, "contact").status).toBe("pass");
});

test("contacts passes on an overlapping pair (interpenetration is contact)", () => {
  const facts = twoBoxFacts({
    overlaps: [{ a: "left", b: "right", volume: 50, location: [10, 5, 5] }],
    gaps: [{ a: "left", b: "right", distance: 0.4, at: [10, 5, 5] }],  // contained-ish reading
    nearMisses: [],
  });
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { contacts: [["left", "right"]] } } });
  expect(pairCheck(checks, "contact").status).toBe("pass");
});

test("clearance gates the measured pair distance with the assertion DSL", () => {
  const fail = evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(fail, "clearance").status).toBe("fail");
  expect(pairCheck(fail, "clearance").location).toEqual([10.1, 5, 5]);
  expect(pairCheck(fail, "nearMiss")).toBeUndefined();     // declared → no warning
  const ok = evaluateCase(twoBoxFacts({ gaps: [{ a: "left", b: "right", distance: 5, at: [12.5, 5, 5] }], nearMisses: [] }),
    { profile: null, expect: { _view: { clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(ok, "clearance").status).toBe("pass");
});

test("clearance accepts { expr, hint } and surfaces the part-authored hint", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null,
    expect: { _view: { clearance: { "left×right": { expr: ">=0.3", hint: "grow `gap`" } } } } });
  expect(pairCheck(checks, "clearance").hint).toBe("grow `gap`");
});

test("a non-array contacts value throws a named shape error, not 'not iterable'", () => {
  // a string is iterable char-by-char, so the container guard must run first
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: "left×right" } } }))
    .toThrow(/array of \["a", "b"\] pairs/);
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: { left: "right" } } } }))
    .toThrow(/array of \["a", "b"\] pairs/);
});

test("a self-pair throws in contacts and in clearance", () => {
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: [["left", "left"]] } } }))
    .toThrow(/two different sub-parts/);
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { clearance: { "left×left": ">=0.3" } } } }))
    .toThrow(/two different sub-parts/);
});

test("a declared pair absent from the case but known to the part skips instead of throwing", () => {
  const facts = twoBoxFacts({ subparts: [twoBoxFacts().subparts[0]], gaps: [], nearMisses: [] }); // only "left" built
  const checks = evaluateCase(facts, { profile: null,
    expect: { _view: { contacts: [["left", "right"]], clearance: { "left×right": ">=0.3" } } },
    subPartNames: ["left", "right"] });
  expect(pairCheck(checks, "contact").status).toBe("skip");
  expect(pairCheck(checks, "contact").message).toMatch(/disabled/);
  expect(pairCheck(checks, "clearance").status).toBe("skip");
});

test("unknown sub-part names and malformed pair keys throw", () => {
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: [["left", "wing"]] } } })).toThrow(/wing/);
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { clearance: { "left+right": ">=0.3" } } } })).toThrow(/a×b/);
});

test("contact/clearance skip when facts carry no gap table (legacy facts)", () => {
  const facts = twoBoxFacts({ gaps: undefined, nearMisses: undefined });
  const checks = evaluateCase(facts, { profile: null,
    expect: { _view: { contacts: [["left", "right"]], clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(checks, "contact").status).toBe("skip");
  expect(pairCheck(checks, "clearance").status).toBe("skip");
});

test("a declared pair MISSING from a present gap table fails loudly (empty sub-part mesh)", () => {
  // gaps exists but has no entry for the pair (meshGaps skips empty meshes) —
  // a declared gate must not silently skip, or verify.ok lies.
  const facts = twoBoxFacts({ gaps: [], nearMisses: [] });
  const checks = evaluateCase(facts, { profile: null,
    expect: { _view: { contacts: [["left", "right"]], clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(checks, "contact").status).toBe("fail");
  expect(pairCheck(checks, "contact").message).toMatch(/no measured distance/);
  expect(pairCheck(checks, "contact").hint).toBeTruthy();
  expect(pairCheck(checks, "clearance").status).toBe("fail");
});

test("a flat (non-nested) contacts entry throws a clear shape error", () => {
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: ["left", "right"] } } }))
    .toThrow(/\["a", "b"\] pair/);
});

import gapPart from "./fixtures/gap-part.js";

test("end-to-end: contacts gate fails on the real 0.2mm gap part", () => {
  const part = { ...gapPart, verify: { expect: { _view: { contacts: [["left", "right"]] } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  const c = v.failures.find((f) => f.metric === "contact");
  expect(c.actual).toBeCloseTo(0.2, 4);
  expect(c.location[0]).toBeCloseTo(10.1, 3);
  expect(c.pattern).toBe("near-miss-gap");
});

test("end-to-end: undeclared near miss is a warning; verify still ok", () => {
  // one declared expectation, so the verdict is not withheld as vacuous
  const v = verify(k, { ...gapPart, verify: { expect: { _view: { overlaps: 0 } } } });
  expect(v.ok).toBe(true);
  expect(v.warnings.some((w) => w.metric === "nearMiss")).toBe(true);
});

test("end-to-end: declared clearance passes a separated pair", () => {
  const part = { ...gapPart, defaults: { gap: 5 }, verify: { expect: { _view: { clearance: { "left×right": ">=0.3" } } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.warnings.filter((w) => w.metric === "nearMiss")).toEqual([]);
});

test("end-to-end: contacts on an enabled()-gated sub-part skips cases where it is disabled", () => {
  const part = {
    meta: { title: "LidBox", units: "mm" },
    defaults: { with_lid: 1 },
    parameters: [{ id: "b", presets: { Bare: { with_lid: 0 } } }],
    parts: {
      base: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 5] }) },
      lid:  { views: ["v"], enabled: (p) => p.with_lid > 0, build: (kk) => kk.box({ min: [0, 0, 5], max: [10, 10, 7] }) },
    },
    views: { v: { label: "V" } },
    verify: { expect: { _view: { contacts: [["base", "lid"]] } } },
  };
  const v = verify(k, part);                                   // must not throw
  expect(v.ok).toBe(true);
  const defaults = v.cases.find((c) => c.name === "defaults");
  expect(defaults.checks.find((c) => c.metric === "contact").status).toBe("pass");   // touching at z=5
  const bare = v.cases.find((c) => c.name === "Bare");
  expect(bare.checks.find((c) => c.metric === "contact").status).toBe("skip");       // lid disabled
});

// ── function-valued expect (per-case expectations) ─────────────────────────────────────────

// A puck with an optional bore: presets legitimately change the topology
// (bore on → genus 1, bore off → genus 0) — the case a static expect can't pin.
const holey = () => ({
  meta: { title: "Holey", units: "mm" },
  defaults: { od: 12, h: 10, bore: 4 },
  parameters: [{ id: "b", presets: { Solid: { bore: 0 }, Wide: { bore: 6 } } }],
  derive: (p) => ({ boreR: p.bore / 2 }),
  parts: {
    puck: { views: ["v"], build: (kk, p, d) => {
      const s = kk.cylinder({ r: p.od / 2, h: p.h });
      return p.bore > 0 ? s.cut(kk.cylinder({ r: d.boreR, h: p.h + 4 }).translate([0, 0, -2])) : s;
    } },
  },
  views: { v: { label: "V" } },
});

test("a function-valued expect is resolved per case and passes topology-changing presets", () => {
  const part = { ...holey(), verify: { expect: (p) => ({ puck: { holes: p.bore > 0 ? 1 : 0 } }) } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "Solid", "Wide"]);
});

test("a function-valued expect still fails a genuinely wrong case", () => {
  const part = { ...holey(), verify: { expect: () => ({ puck: { holes: 2 } }) } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  expect(v.failures).toHaveLength(3);
});

test("the expect function receives the case's resolved (p, d)", () => {
  const seen = [];
  const part = { ...holey(), verify: { expect: (p, d) => { seen.push([p.bore, d.boreR]); return {}; } } };
  verify(k, part);
  expect(seen).toEqual([[4, 2], [0, 0], [6, 3]]);   // defaults, Solid, Wide
});

test("a function expect mentioning minWall turns the measurement on", () => {
  const part = { ...holey(), verify: { expect: () => ({ puck: { minWall: ">=1" } }) } };
  const v = verify(k, part);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(typeof mw.actual).toBe("number");          // a real reading, not "unavailable"
});

import planter from "../src/parts/planter.js";

test("the planter's shipped verify block passes every preset (drain on AND off)", () => {
  const v = verify(k, planter);
  expect(v.failures).toEqual([]);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "Pen cup", "Planter", "Vase"]);
});

// ── seeding: verify reuses an already-computed measure ───────────────────────

const counted = () => { const c = { n: 0 }; return [(...args) => { c.n++; return measureReal(...args); }, c]; };

test("a seed matching the defaults case skips that case's measure", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", cases: ["defaults", "Big"] } };
  const result = measureReal(k, part, "v", {}, { minWall: true });
  const [measureFn, calls] = counted();
  const v = verify(k, part, { measureFn, seed: { params: {}, result } });
  expect(calls.n).toBe(1);                            // only "Big" is measured
  expect(v.cases).toHaveLength(2);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.status).toBe("pass");
  expect(mw.actual).toBeGreaterThan(1.2);             // the seeded reading, not "unavailable"
});

test("the seed is keyed through the case signature, so it covers every case with that signature", () => {
  // "Relabel" changes only `label`, which the build never reads → same signature
  // as defaults. One seed, two cases, zero measures.
  const part = { ...tube(12, 10), verify: { cases: ["defaults", "Relabel"], expect: { tube: { holes: 1 } } } };
  const result = measureReal(k, part, "v", {}, { minWall: true });
  const [measureFn, calls] = counted();
  const v = verify(k, part, { measureFn, seed: { params: {}, result } });
  expect(calls.n).toBe(0);
  expect(v.ok).toBe(true);
});

test("a seed for other params misses (no falsely-shared reading)", () => {
  const part = { ...tube(12, 10), verify: { cases: ["defaults"], expect: { tube: { holes: 1 } } } };
  const result = measureReal(k, part, "v", { od: 20, h: 30 }, { minWall: true });
  const [measureFn, calls] = counted();
  const v = verify(k, part, { measureFn, seed: { params: { od: 20, h: 30 }, result } });
  expect(calls.n).toBe(1);
  expect(v.ok).toBe(true);
});

test("a seed taken WITHOUT min-wall is ignored when the run needs min-wall", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", cases: ["defaults"] } };
  const result = measureReal(k, part, "v", {}, { minWall: false });
  expect(result.subparts[0].minWall).toBeNull();      // the seed really has no reading
  expect(result.measuredMinWall).toBe(false);         // and says so itself — no caller assertion
  const [measureFn, calls] = counted();
  const v = verify(k, part, { measureFn, seed: { params: {}, result } });
  expect(calls.n).toBe(1);                            // recomputed — the seed is not a superset
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.status).toBe("pass");
  expect(mw.actual).toBeGreaterThan(1.2);             // a real reading, never "min wall unavailable"
});

test("a WITH-min-wall seed is reused when the run doesn't need min-wall (superset direction)", () => {
  const part = { ...tube(12, 10), verify: { cases: ["defaults"], expect: { tube: { holes: 1 } } } };
  const result = measureReal(k, part, "v", {}, { minWall: true });
  const [measureFn, calls] = counted();
  const v = verify(k, part, { measureFn, seed: { params: {}, result } });
  expect(calls.n).toBe(0);
  expect(v.ok).toBe(true);
});

test("a seed measured on another view is ignored", () => {
  const twoView = {
    meta: { title: "Tube", units: "mm" },
    defaults: { od: 12, h: 10, label: "a" },
    parts: { tube: { views: ["v", "w"], build: (kk, p) => kk.cylinder({ r: p.od / 2, h: p.h }) } },
    views: { v: { label: "V" }, w: { label: "W" } },
    verify: { cases: ["defaults"], expect: { tube: { holes: 0 } } },
  };
  const result = measureReal(k, twoView, "w", {}, { minWall: true });
  const [measureFn, calls] = counted();
  const v = verify(k, twoView, { view: "v", measureFn, seed: { params: {}, result } });
  expect(calls.n).toBe(1);
  expect(v.ok).toBe(true);
});

test("seeded and unseeded verify produce identical reports", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", expect: { tube: { holes: 1 }, _view: { overlaps: 0 } } } };
  const result = measureReal(k, part, "v", {}, { minWall: true });
  expect(verify(k, part, { seed: { params: {}, result } })).toEqual(verify(k, part));
});

// ── overhang (opt-in) and the vacuous-verify rule ─────────────────────────────

// A T: a wide slab riding a narrow stem — the slab's underside beyond the stem is
// a 90° ceiling on each side, 8×10 mm² per side.
const tee = () => ({
  meta: { title: "Tee", units: "mm" },
  defaults: { w: 20 },
  parts: { tee: { views: ["v"], build: (kk, p) => kk.box({ size: [p.w, 10, 4] }).translate([-p.w / 2, 0, 6])
    .union(kk.box({ size: [4, 10, 6] }).translate([-2, 0, 0])) } },
  views: { v: { label: "V" } },
});

test("overhang: opted in with orientation: print under an FDM profile, the ceiling warns with area and location", () => {
  const v = verify(k, { ...tee(), verify: { process: "fdm-pla", orientation: "print", expect: { tee: { holes: 0 } } } });
  expect(v.ok).toBe(true); // a warning, never a gate
  const oh = v.cases[0].checks.find((c) => c.metric === "overhangArea");
  expect(oh.status).toBe("warn");
  expect(oh.actual).toBeCloseTo(160, 3);
  expect(oh.location).toHaveLength(3);
  expect(oh.location[2]).toBeCloseTo(6, 3);           // on the slab's underside
  expect(oh.note).toMatch(/90\.0° from vertical/);
  expect(oh.hint).toMatch(/reorient|chamfer|supports/);
});

test("overhang: not checked without the orientation key (even under FDM) or under a profile with no angle; a clean part passes", () => {
  expect(verify(k, { ...tee(), verify: { process: "fdm-pla", expect: { tee: { holes: 0 } } } }).cases[0].checks.some((c) => c.metric === "overhangArea")).toBe(false);
  expect(verify(k, { ...tee(), verify: { process: "resin", orientation: "print", expect: { tee: { holes: 0 } } } }).cases[0].checks.some((c) => c.metric === "overhangArea")).toBe(false);
  const box = verify(k, { ...tube(12, 10), verify: { process: "fdm-pla", orientation: "print", expect: { tube: { holes: 1 } } } });
  const oh = box.cases[0].checks.find((c) => c.metric === "overhangArea");
  expect(oh.status).toBe("pass");
  expect(oh.actual).toBe(0);
  expect(() => verify(k, { ...tee(), verify: { orientation: "sideways" } })).toThrow(/unknown verify.orientation/);
});

test("vacuous verify: a part that declares nothing gets no verdict, and says why — in warnings, never inside a case", () => {
  for (const part of [tube(12, 10), { ...tube(12, 10), verify: { expect: {} } }, { ...tube(12, 10), verify: { expect: { tube: {} } } }]) {
    const v = verify(k, part);
    expect(v.ok).toBeNull();
    expect(v.declared).toBe(0);
    expect(v.evaluated).toBe(0);
    expect(v.failures).toEqual([]);
    const notice = v.warnings.find((w) => w.metric === "expectations");
    expect(notice.scope).toBe("part");
    expect(notice.case).toBeNull();
    expect(notice.message).toBe("no expectations declared");
    expect(notice.hint).toMatch(/verify\.expect/);
    for (const c of v.cases) expect(c.checks.some((ch) => ch.metric === "expectations")).toBe(false);
  }
});

test("vacuous verify: an undeclared near miss is still just a warning — the notice sits beside it and the nearMiss does not count as declared", () => {
  const v = verify(k, { ...gapPart, verify: { expect: {} } });
  expect(v.ok).toBeNull();
  expect(v.declared).toBe(0);
  expect(v.warnings.map((w) => w.metric).sort()).toEqual(["expectations", "nearMiss"]);
});

test("vacuous verify: declared but nothing answerable — every check skipped — is withheld with its own notice", () => {
  // a ref metric on a sub-part that declares no reference always skips
  const v = verify(k, { ...tube(12, 10), verify: { expect: { tube: { refVolumeDeltaPct: "<=1" } } } });
  expect(v.ok).toBeNull();
  expect(v.declared).toBe(3);
  expect(v.evaluated).toBe(0);
  expect(v.warnings.find((w) => w.metric === "expectations").message).toBe("no expectation could be evaluated");
});

test("vacuous verify: a quick lap whose seed matches no case is withheld through `unevaluated`, with NO false 'nothing declared' notice", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", expect: { tube: { holes: 1 } } } };
  const seed = { params: { od: 99, h: 99 }, result: measureReal(k, part, "v", { od: 99, h: 99, label: "a" }, { minWall: true }) };
  const v = verify(k, part, { quick: true, seed });
  expect(v.ok).toBeNull();
  expect(v.unevaluated.length).toBeGreaterThan(0);
  expect(v.warnings.some((w) => w.metric === "expectations")).toBe(false);
});

test("vacuous verify: one answerable expectation — or a profile — is enough for a verdict", () => {
  expect(verify(k, { ...tube(12, 10), verify: { process: "fdm-pla" } }).evaluated).toBeGreaterThan(0);
  expect(verify(k, { ...tube(12, 10), verify: { process: "fdm-pla" } }).ok).toBe(true);
  const v = verify(k, { ...tube(12, 10), verify: { expect: { tube: { holes: 1 } } } });
  expect(v.ok).toBe(true);
  expect(v.declared).toBe(3); // one per case: defaults + 2 presets
  expect(v.evaluated).toBe(3);
  expect(v.warnings.some((w) => w.metric === "expectations")).toBe(false);
});

// ── overhang: the seams the review found ──────────────────────────────────────

test("overhang: an author's own overhangArea expectation arms the measurement without the orientation key", () => {
  const v = verify(k, { ...tee(), verify: { process: "fdm-pla", expect: { tee: { overhangArea: "<=0.5" } } } });
  const oh = v.cases[0].checks.find((c) => c.metric === "overhangArea");
  expect(oh.status).toBe("warn");            // declared by the author as a warn-class metric: 160 > 0.5
  expect(oh.actual).toBeCloseTo(160, 3);
  // and on resin (no angle) it measures against the 45° default rather than answering "unavailable"
  const resin = verify(k, { ...tee(), verify: { process: "resin", expect: { tee: { overhangArea: "<=0.5" } } } });
  expect(resin.cases[0].checks.find((c) => c.metric === "overhangArea").actual).toBeCloseTo(160, 3);
  expect(resin.ok).toBe(true);
});

test("overhang: a seed measured against a different angle is not reused — a process override re-measures", () => {
  const part = { ...tee(), verify: { process: "resin", orientation: "print", expect: { tee: { holes: 0 } } } };
  const seed = { params: {}, result: measureReal(k, part, "v", { ...part.defaults }, { minWall: true }) };
  expect(seed.result.measuredOverhang).toBeNull(); // resin: not checked
  const unseeded = verify(k, part, { process: "fdm-pla" });
  const seeded = verify(k, part, { process: "fdm-pla", seed });
  const pick = (v) => v.cases[0].checks.find((c) => c.metric === "overhangArea");
  expect(pick(seeded)).toEqual(pick(unseeded));
  expect(pick(seeded).status).toBe("warn");
  expect(pick(seeded).actual).toBeCloseTo(160, 3);
});

test("overhang: a bottom-edge fillet does not warn — its lower curl is inside the near-bed band", () => {
  const plate = {
    meta: { title: "Plate", units: "mm" }, defaults: { r: 1 },
    parts: { plate: { views: ["v"], build: (kk, p) => kk.roundedBox({ size: [20, 20, 5], round: p.r }) } },
    views: { v: { label: "V" } },
  };
  const v = verify(k, { ...plate, verify: { process: "fdm-pla", orientation: "print", expect: { plate: { holes: 0 } } } });
  const oh = v.cases[0].checks.find((c) => c.metric === "overhangArea");
  expect(oh.status).toBe("pass");
  expect(oh.actual).toBe(0);
});

test("overhang: an exportable: false sub-part is not judged", () => {
  const part = tee();
  part.parts.ghost = { views: ["v"], exportable: false, build: (kk) => kk.box({ size: [20, 10, 4] }).translate([-10, 0, 20]).union(kk.box({ size: [4, 10, 6] }).translate([-2, 0, 14])) };
  const v = verify(k, { ...part, verify: { process: "fdm-pla", orientation: "print", expect: { tee: { holes: 0 } } } });
  const byName = Object.fromEntries(v.cases[0].checks.filter((c) => c.metric === "overhangArea").map((c) => [c.subpart, c]));
  expect(byName.tee.status).toBe("warn");
  expect(byName.ghost.status).toBe("skip");
});

const wallFacts = (value, location = [8, 9, 5]) => ({
  measuredMinWall: true,
  subparts: [{ name: "wall", holes: 0, volume: 100, surfaceArea: 100, triangleCount: 10, bbox: [10, 12, 10], watertight: true, minWall: 2,
    wall: value === undefined ? null : { value, location, band: { min: 1.8, max: 2.2 }, members: value === null ? 0 : 40 } }],
  aggregate: { bbox: [10, 12, 10], volume: 100 },
  overlaps: [],
});

test("wall outside its band is a located warning", () => {
  const w = byKey(evaluateCase(wallFacts(2.62), { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.location).toEqual([8, 9, 5]);
  expect(w.message).toMatch(/2\.62 out of 1\.8\.\.2\.2/);
  expect(w.hint).toMatch(/drifts from the declared band/);
});

test("wall inside its band passes and still reports the worst member", () => {
  const w = byKey(evaluateCase(wallFacts(2.05), { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.status).toBe("pass");
  expect(w.actual).toBe(2.05);
});

test("wall with no member skips with its own message", () => {
  const w = byKey(evaluateCase(wallFacts(null), { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.status).toBe("skip");
  expect(w.message).toBe("no wall in band");
});

test("wall on a quick lap is unevaluated, like minWall", () => {
  const facts = { ...wallFacts(undefined), measuredMinWall: false };
  const w = byKey(evaluateCase(facts, { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.unevaluated).toBe(true);
  expect(w.message).toBe("not measured (quick check)");
});

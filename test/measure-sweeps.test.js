// Sweeps and allowed pairs where the agent reads them (spec 2026-11-02-collisions-design.md,
// "Sweeps" and "Where the agent sees it"): measure reports `sweeps`, verify gates on
// `sweepContacts` and re-measures its cases without sweeps, `collisions.allow` lifts the
// overlaps gate for its pairs, and a sweep the deadline stopped is a visible warning.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import drawerBox from "../src/parts/drawer-box.js";
import robotArm from "../src/parts/robot-arm.js";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { assemblyOverlaps } from "../src/framework/assembly.js";
import { VIEW_METRICS } from "../src/framework/verify-metrics.js";
import { pairKey } from "../src/framework/collide/pairs.js";
import { collideBar } from "./fixtures/collide-bar.js";
import frameKnuckles from "./fixtures/hinge-frame-knuckles.js";
import buriedAxis from "./fixtures/hinge-buried-axis.js";
import detent from "./fixtures/hinge-detent.js";
import buttingKnuckles from "./fixtures/hinge-butting-knuckles.js";
import { hingeViews } from "./fixtures/hinge-views.js";
import { handle } from "../src/framework/jobs.js";
import { runSweeps } from "../src/framework/oracle/sweep.js";
import { sweepText } from "../bin/sweep-text.js";

const SLOW = 120_000;
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const withSweeps = (part, sweeps, extra = {}) => ({ ...part, ...extra, verify: { ...part.verify, ...extra.verify, sweeps } });
// The bar swings 0 → 180° and meets the slab at 60°.
const barSweep = (extra = {}) => withSweeps(collideBar, { swing: { param: "angle" } }, extra);
const gated = { verify: { expect: { _view: { sweepContacts: 0 } } } };
const DEPTH_UNREAD_HINT = "these pieces stay in contact along the motion and the time budget ran out before their depth could be read. Give the moving pair a running gap (for example 0.2 mm between knuckle faces, a bore larger than its pin) so the sweep can prove it clear, or run npx partforge measure for the long budget.";
// A preset section, so verify has a second case to re-measure.
const withPreset = (part) => ({
  ...part,
  parameters: [...part.parameters, { id: "shapes", title: "Shapes", description: "d", controls: [
    { type: "preset", label: "Shape", presets: { tilted: { angle: 20 } } },
  ] }],
});

describe("measure and sweeps", () => {
  it("measure without sweeps has no sweeps key", () => {
    // drawer-box.js declares its own sweeps: take them off to measure a part with none
    const { sweeps: _sweeps, ...verify } = drawerBox.verify;
    const r = measure(k, { ...drawerBox, verify }, "cabinet");
    expect("sweeps" in r).toBe(false);
  }, SLOW);

  it("measure reports declared sweeps", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1" } });
    const r = measure(k, part, "cabinet");
    expect(r.sweeps).toHaveLength(1);
    expect(r.sweeps[0]).toMatchObject({ name: "d1.drawer1Open", clear: true, rebuilds: false });
    expect(r.ok).toBe(true);
  }, SLOW);

  it("opts.sweeps false leaves the key out", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1" } });
    expect("sweeps" in measure(k, part, "cabinet", {}, { sweeps: false })).toBe(false);
  }, SLOW);

  it("a sweep past the deadline is skipped (timeout), not dropped", () => {
    const r = measure(k, barSweep(), "assembly", {}, { deadline: -Infinity });
    expect(r.sweeps).toEqual([expect.objectContaining({ name: "swing", clear: null, skipped: "timeout" })]);
  }, SLOW);
});

describe("verify and sweeps", () => {
  it("verify re-measures cases without sweeps", () => {
    const part = withPreset(barSweep());
    const spy = vi.fn((...args) => measure(...args));
    verify(k, part, { view: "assembly", measureFn: spy });
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    const flags = spy.mock.calls.map((c) => c[4]?.sweeps);
    expect(flags[0]).toBe(true);
    expect(Array.isArray(spy.mock.results[0].value.sweeps)).toBe(true); // the first call swept
    expect(flags.slice(1).every((f) => f === false)).toBe(true);
    expect(spy.mock.results.slice(1).every((r) => !("sweeps" in r.value))).toBe(true);
  }, SLOW);

  it("a seed's sweeps are reused, not re-run", () => {
    const part = barSweep(gated);
    const seed = measure(k, part, "assembly");
    const spy = vi.fn((...args) => measure(...args));
    const v = verify(k, part, { view: "assembly", measureFn: spy, seed: { params: {}, result: seed } });
    expect(spy.mock.calls.every((c) => c[4]?.sweeps === false)).toBe(true);
    expect(v.ok).toBe(false);
  }, SLOW);

  it("sweepContacts gates", () => {
    const v = verify(k, barSweep(gated), { view: "assembly" });
    expect(v.ok).toBe(false);
    const f = v.failures.find((c) => c.metric === "sweepContacts");
    expect(f).toBeTruthy();
    expect(f.hint).toBe(VIEW_METRICS.sweepContacts.hint);
    expect(f.location).toHaveLength(3);

    const allowed = barSweep({ ...gated, collisions: { allow: ["palm×bar"] } });
    const ok = verify(k, allowed, { view: "assembly" });
    expect(ok.ok).toBe(true);
    expect(ok.failures).toEqual([]);
  }, SLOW);

  it("every sweep timed out: the gate is withheld, with one volunteered warning", () => {
    const part = barSweep(gated);
    const seed = measure(k, part, "assembly", {}, { deadline: -Infinity });
    const v = verify(k, part, { view: "assembly", seed: { params: {}, result: seed } });
    const w = v.warnings.filter((c) => c.metric === "sweeps");
    expect(w).toHaveLength(1);
    expect(w[0].volunteered).toBe(true);
    expect(w[0].message).toContain("swing");
    expect(w[0].hint).toMatch(/partforge measure/);
    // Only the gate counts toward declared, and it has no reading: withheld, never a 0.
    expect(v.declared).toBe(1);
    expect(v.ok).toBe(null);
    const gate = v.unevaluated.find((c) => c.metric === "sweepContacts");
    expect(gate).toMatchObject({ status: "skip", actual: null, unevaluated: true });
  }, SLOW);

  // Crafted rows on a real measurement, as a seed: what the gate and the notices read.
  const row = (name, extra = {}) => ({ name, clear: true, clearance: 0.001, steps: 4, rebuilds: false,
    minClearance: null, contacts: [], freeRange: null, ms: 0, ...extra });
  const contact = { from: 60.06, to: 180, a: "palm", b: "bar", at: [1, 2, 3], driver: "angle" };
  const withRows = (rows) => {
    const part = barSweep(gated);
    const seed = { ...measure(k, part, "assembly", {}, { sweeps: false }), sweeps: rows };
    return verify(k, part, { view: "assembly", seed: { params: {}, result: seed } });
  };
  const gateOf = (v) => v.cases[0].checks.find((c) => c.metric === "sweepContacts");
  const notice = (v) => v.warnings.filter((c) => c.metric === "sweeps").map((c) => c.message);

  it("some ran and some timed out: the ran ones count, the rest warn", () => {
    const v = withRows([row("a"), row("b", { clear: null, skipped: "timeout" })]);
    expect(gateOf(v)).toMatchObject({ status: "pass", actual: 0 });
    expect(notice(v)).toEqual(["1 sweep(s) stopped at the time budget: b"]);
    expect(v.ok).toBe(true);
  }, SLOW);

  it("every sweep unreadable: the gate is withheld", () => {
    const v = withRows([row("a", { clear: null, skipped: "unreadable", error: "boom" }), row("b", { clear: null, skipped: "unreadable" })]);
    expect(gateOf(v)).toMatchObject({ status: "skip", actual: null, unevaluated: true });
    expect(v.ok).toBe(null);
    expect(notice(v)).toEqual(["2 sweep(s) could not run: a (boom), b"]);
  }, SLOW);

  it("a timed-out sweep that already found a contact counts, and the warning names it", () => {
    const v = withRows([row("b", { clear: null, skipped: "timeout", contacts: [contact] })]);
    expect(gateOf(v)).toMatchObject({ status: "fail", actual: 1, location: [1, 2, 3] });
    expect(v.ok).toBe(false);
    expect(notice(v)).toEqual(["1 sweep(s) stopped at the time budget: b (contact found at 60.06: bar×palm)"]);
  }, SLOW);

  it("a timed-out sweep that may touch counts only a contact read past its allowance", () => {
    const touching = (contacts) => row("t", { clearance: 0, clear: null, skipped: "timeout", contacts });
    // an allowed rub, and a contact whose depth the clock never finished reading: neither
    // counts, and the unread one withholds the gate with its own hint
    const quiet = withRows([touching([{ ...contact, depth: 0, allowed: true }, { ...contact, from: 90, depth: 0.01, depthUnread: true }])]);
    expect(gateOf(quiet)).toMatchObject({ status: "skip", actual: null, unevaluated: true, hint: DEPTH_UNREAD_HINT });
    expect(quiet.ok).toBe(null);
    expect(notice(quiet)).toEqual(["1 sweep(s) stopped at the time budget: t"]);
    // one read past it does, and the warning names that one
    const hit = withRows([touching([{ ...contact, depth: 0, allowed: true }, { ...contact, from: 90, depth: 2, allowed: false, at: [4, 5, 6] }])]);
    expect(gateOf(hit)).toMatchObject({ status: "fail", actual: 1, location: [4, 5, 6] });
    expect(notice(hit)).toEqual(["1 sweep(s) stopped at the time budget: t (contact found at 90: bar×palm)"]);
  }, SLOW);

  it("a known contact wins over an unread depth: the gate fails, never withheld", () => {
    const touching = (contacts, extra = {}) => row("t", { clearance: 0, clear: null, skipped: "timeout", contacts, ...extra });
    const unread = { ...contact, from: 90, depth: 0.01, depthUnread: true };
    // another row that finished with a contact, beside the unread one
    const beside = withRows([touching([unread]), row("hit", { clear: false, contacts: [contact] })]);
    expect(gateOf(beside)).toMatchObject({ status: "fail", actual: 1 });
    expect(beside.ok).toBe(false);
    // a stretch read past the allowance before the clock stopped, in the same row
    const same = withRows([touching([{ ...contact, depth: 2, allowed: false, at: [4, 5, 6] }, unread])]);
    expect(gateOf(same)).toMatchObject({ status: "fail", actual: 1, location: [4, 5, 6] });
    expect(same.ok).toBe(false);
  }, SLOW);

  it("an unread depth withholds the gate even beside a sweep that finished", () => {
    // a row that ran clear, and the butting knuckles' row stopped while reading depth
    const part = { ...buttingKnuckles, verify: { ...buttingKnuckles.verify, expect: { _view: { sweepContacts: 0 } } } };
    const steps = runSweeps(k, part, "assembly", {})[0].steps;
    let ticks = 0;
    const [cut] = runSweeps(k, part, "assembly", {}, { deadline: steps + 5, now: () => ticks++ });
    expect(cut.skipped).toBe("timeout");
    expect(cut.contacts.some((c) => c.depthUnread)).toBe(true);
    const clearRow = row("other", { clearance: 0.5 });
    const seed = { ...measure(k, part, "assembly", {}, { sweeps: false }), sweeps: [clearRow, cut] };
    const v = verify(k, part, { view: "assembly", seed: { params: {}, result: seed } });
    expect(v.ok).toBe(null);
    const gate = v.unevaluated.find((c) => c.metric === "sweepContacts");
    expect(gate).toMatchObject({ status: "skip", actual: null, unevaluated: true, hint: DEPTH_UNREAD_HINT });
  }, SLOW);

  it("a seed measured without sweeps is not admitted for a part that declares them", () => {
    const part = barSweep(gated);
    const seed = measure(k, part, "assembly", {}, { sweeps: false });
    const spy = vi.fn((...args) => measure(...args));
    const v = verify(k, part, { view: "assembly", measureFn: spy, seed: { params: {}, result: seed } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][4].sweeps).toBe(true);
    expect(v.ok).toBe(false); // the bar meets the slab
  }, SLOW);

  it("a seed not admitted (no min wall) still gives its sweep rows, whatever the case order", () => {
    // A min-wall profile, a seed measured without min wall, and a preset case listed first.
    const part = withPreset(barSweep({ verify: { process: "fdm-pla", cases: ["tilted", "defaults"], expect: { _view: { sweepContacts: 0 } } } }));
    const measured = measure(k, part, "assembly");
    expect(measured.measuredMinWall).toBe(false);
    const seed = { ...measured, sweeps: [row("seeded", { clear: null, skipped: "timeout", contacts: [contact] })] };
    const spy = vi.fn((...args) => measure(...args));
    const v = verify(k, part, { view: "assembly", measureFn: spy, seed: { params: {}, result: seed } });
    expect(spy.mock.calls.length).toBe(2);
    expect(spy.mock.calls.every((c) => c[4].minWall === true && c[4].sweeps === false)).toBe(true);
    const def = v.cases.find((c) => c.name === "defaults");
    expect(def.checks.find((c) => c.metric === "sweepContacts")).toMatchObject({ status: "fail", actual: 1 });
    expect(notice(v)).toEqual(["1 sweep(s) stopped at the time budget: seeded (contact found at 60.06: bar×palm)"]);
  }, SLOW);

  it("the caller's deadline reaches the one measure that sweeps", () => {
    const spy = vi.fn((...args) => measure(...args));
    verify(k, withPreset(barSweep()), { view: "assembly", measureFn: spy, deadline: 12345 });
    expect(spy.mock.calls[0][4]).toMatchObject({ sweeps: true, deadline: 12345 });
    expect(spy.mock.calls.slice(1).every((c) => !("deadline" in c[4]))).toBe(true);
  }, SLOW);

  it("a part that declares no sweeps verifies as before (no sweeps warning)", () => {
    const v = verify(k, drawerBox, { view: "cabinet" });
    expect(v.warnings.some((c) => c.metric === "sweeps")).toBe(false);
  }, SLOW);
});

describe("collisions.allow and the overlaps gate", () => {
  // `a` overlaps both `b` and `c`; only a×b is allowed.
  const three = (allow) => ({
    meta: { title: "three", units: "mm" },
    defaults: {},
    parts: {
      a: { label: "a", build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }), views: { main: (s) => s } },
      b: { label: "b", build: (kk) => kk.box({ min: [5, 0, 0], max: [15, 10, 10] }), views: { main: (s) => s } },
      c: { label: "c", build: (kk) => kk.box({ min: [-5, 0, 0], max: [3, 10, 10] }), views: { main: (s) => s } },
    },
    views: { main: { label: "Main" } },
    ...(allow ? { collisions: { allow } } : {}),
  });
  const pairs = (list) => list.map((o) => pairKey(o.a, o.b)).sort();

  it("allow lifts the overlaps gate for that pair only", () => {
    expect(pairs(assemblyOverlaps(k, three(), "main"))).toEqual(["a×b", "a×c"]);
    expect(pairs(assemblyOverlaps(k, three(), "main", {}, { allow: new Set(["a×b"]) }))).toEqual(["a×c"]);
    expect(pairs(measure(k, three(["b×a"]), "main").overlaps)).toEqual(["a×c"]);
  }, SLOW);

  it("the arm's forearm×hand is allowed, and only that pair", () => {
    const at = { toolY: 50 };
    const { collisions: _c, ...bare } = robotArm;
    expect(pairs(measure(k, bare, "assembly", at, { sweeps: false }).overlaps)).toContain("forearm×hand");
    const r = measure(k, robotArm, "assembly", at, { sweeps: false });
    expect(pairs(r.overlaps)).not.toContain("forearm×hand");
  }, SLOW);
});

// The moving-fit fixtures (spec 2026-11-12-moving-fits-swept-design.md, "Why" and B), each
// sweeping its hinge at clearance 0.
describe("sweeps that may touch, gated", () => {
  const gate = (part) => ({ ...part, verify: { ...part.verify, expect: { _view: { sweepContacts: 0 } } } });
  const sweepAt = (part, clearance) => ({ ...part, verify: { ...part.verify, sweeps: { open: { param: "open", clearance } } } });
  const gateOf = (v) => v.cases[0].checks.find((c) => c.metric === "sweepContacts");

  it("knuckles in the other plate, a buried axis, and a dig inside a touch fail the gate", () => {
    for (const part of [frameKnuckles, buriedAxis, buttingKnuckles]) {
      const v = verify(k, gate(part), { view: "assembly" });
      expect(v.ok, part.meta.title).toBe(false);
      expect(gateOf(v)).toMatchObject({ status: "fail", actual: 1 });
    }
  }, SLOW);

  it("a detent rub passes within its allowance and fails past it", () => {
    const allowed = verify(k, gate(sweepAt(detent, -0.3)), { view: "assembly" });
    expect(gateOf(allowed)).toMatchObject({ status: "pass", actual: 0 });
    expect(allowed.ok).toBe(true);
    const tight = verify(k, gate(detent), { view: "assembly" });
    expect(gateOf(tight)).toMatchObject({ status: "fail", actual: 1 });
    expect(tight.ok).toBe(false);
  }, SLOW);
});

// A declared sweep that moves nothing in the verified view runs in the first view where it
// moves something (spec 2026-11-12-moving-fits-swept-design.md, A: the hosting app verifies
// a part's FIRST view, and a case's hinge turns in its third).
describe("sweeps run where the motion is, whatever view is verified", () => {
  const gateOf = (v) => v.cases[0].checks.find((c) => c.metric === "sweepContacts");
  const inspectReport = async (part, msg = {}) => {
    const posted = [];
    await handle(k, part, { type: "inspect", params: {}, ...msg }, (m) => posted.push(m));
    return posted.find((m) => m.type === "report");
  };
  const stripMs = (rows) => rows?.map(({ ms: _ms, ...r }) => r);

  it("a hinge that turns only in `assembly` is swept when `base` is verified", () => {
    const part = hingeViews("buried");
    // measure() itself keeps to its own view: nothing moves in `base`
    expect(measure(k, part, "base").sweeps).toEqual([]);
    const v = verify(k, part, { view: "base" });
    expect(v.ok).toBe(false);
    const gate = gateOf(v);
    expect(gate).toMatchObject({ status: "fail", actual: 1 });
    expect(gate.location).toHaveLength(3);
    expect("rows" in gate).toBe(false);
    expect(v.sweeps).toHaveLength(1);
    expect(v.sweeps[0]).toMatchObject({ name: "open", clear: false, view: "assembly" });
    expect(v.sweeps[0].contacts.some((c) => c.allowed === false)).toBe(true);
  }, SLOW);

  it("the working hinge passes from `base`, its row read in `assembly`", () => {
    const v = verify(k, hingeViews("working"), { view: "base" });
    expect(v.ok).toBe(true);
    expect(gateOf(v)).toMatchObject({ status: "pass", actual: 0 });
    expect(v.sweeps).toEqual([expect.objectContaining({ name: "open", clear: true, view: "assembly" })]);
  }, SLOW);

  it("an expired deadline stops the other view's sweep: today's warning, the gate withheld", () => {
    const v = verify(k, hingeViews("buried"), { view: "base", deadline: -Infinity });
    expect(v.ok).toBe(null);
    expect(v.warnings.filter((c) => c.metric === "sweeps").map((c) => c.message)).toEqual(['1 sweep(s) stopped at the time budget: open (view "assembly")']);
    expect(gateOf(v)).toMatchObject({ status: "skip", actual: null, unevaluated: true });
    expect(v.sweeps).toEqual([expect.objectContaining({ name: "open", skipped: "timeout", view: "assembly" })]);
  }, SLOW);

  it("rows run in the verified view keep their shape: no `view`, no `sweeps` on verify", () => {
    const single = { ...buriedAxis, verify: { ...buriedAxis.verify, expect: { _view: { sweepContacts: 0 } } } };
    const m = measure(k, single, "assembly");
    expect(m.sweeps.every((r) => !("view" in r))).toBe(true);
    const one = verify(k, single, { view: "assembly" });
    expect(gateOf(one)).toMatchObject({ status: "fail", actual: 1 });
    expect("sweeps" in one).toBe(false);
    // the four-view part verified where it moves runs nothing elsewhere
    const own = verify(k, hingeViews("buried"), { view: "assembly" });
    expect(gateOf(own)).toMatchObject({ status: "fail", actual: 1 });
    expect("sweeps" in own).toBe(false);
  }, SLOW);

  // Two views pose the lid differently: `exploded` (ahead of `assembly`) lifts the lid
  // 100 mm and swings it about a lifted axis, so it never meets the base there; `assembly`
  // swings it through the base. Swept in the first other view only, the clear `exploded`
  // row answered for both, and verify said ok from `base` (final review, Critical).
  const explodedFirst = () => {
    const base = hingeViews("buried");
    const exploded = (s, p) => s.translate([0, 0, 100]).rotateAbout({ axis: "X", deg: -p.open, through: [0, 15, 110] });
    return {
      ...base,
      parts: {
        base: { ...base.parts.base, views: { base: (s) => s, exploded: (s) => s, assembly: (s) => s } },
        lid: { ...base.parts.lid, views: { lid: (s) => s, exploded, assembly: base.parts.lid.views.assembly } },
      },
      views: { base: { label: "Base" }, lid: { label: "Lid" }, exploded: { label: "Exploded" }, assembly: { label: "Assembly" } },
    };
  };

  it("a sweep runs in EVERY view where it moves something, not just the first", () => {
    const part = explodedFirst();
    const v = verify(k, part, { view: "base" });
    expect(v.ok).toBe(false);
    expect(gateOf(v)).toMatchObject({ status: "fail", actual: 1 });
    expect(v.sweeps.map((r) => [r.view, r.name, r.clear])).toEqual([["exploded", "open", true], ["assembly", "open", false]]);
    expect(v.sweeps[1].contacts.some((c) => c.allowed === false)).toBe(true);
    // verified in `assembly`, the exploded view's clear row joins its own contact row
    const own = verify(k, part, { view: "assembly" });
    expect(own.ok).toBe(false);
    expect(own.sweeps.map((r) => [r.view, r.name, r.clear])).toEqual([["exploded", "open", true]]);
  }, SLOW);

  it("a deadline that passes after the first other view times out the second, naming its view", () => {
    // the clock jumps past the deadline once the first other view's sweep has run
    let swept = false, passed = false;
    const kernel = Object.create(k);
    kernel.beginSubPart = (label) => { if (String(label).startsWith("oracle:sweep:")) swept = true; return k.beginSubPart?.(label); };
    kernel.cleanup = () => { if (swept) passed = true; return k.cleanup?.(); };
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (passed ? 8e15 : realNow()));
    let v;
    try { v = verify(kernel, explodedFirst(), { view: "base" }); } finally { spy.mockRestore(); }
    expect(v.sweeps.map((r) => [r.view, r.name, r.clear, r.skipped ?? null])).toEqual([
      ["exploded", "open", true, null], ["assembly", "open", null, "timeout"]]);
    expect(v.warnings.filter((c) => c.metric === "sweeps").map((c) => c.message))
      .toEqual(['1 sweep(s) stopped at the time budget: open (view "assembly")']);
  }, SLOW);

  it("a view that poses the moving pieces exactly as an already-swept one is not swept again", () => {
    const base = hingeViews("buried");
    // `demo` poses base and lid exactly as `assembly` does
    const twice = {
      ...base,
      parts: { ...base.parts,
        base: { ...base.parts.base, views: { ...base.parts.base.views, demo: (s) => s } },
        lid: { ...base.parts.lid, views: { ...base.parts.lid.views, demo: base.parts.lid.views.assembly } } },
      views: { ...base.views, demo: { label: "Demo" } },
    };
    expect(verify(k, twice, { view: "print" }).sweeps.map((r) => [r.name, r.view])).toEqual([["open", "assembly"]]);
    expect("sweeps" in verify(k, twice, { view: "assembly" })).toBe(false);
    // the whole assembly shifted is the same relative placement: still swept once
    const lidAt = base.parts.lid.views.assembly;
    const shifted = { ...twice, parts: {
      base: { ...twice.parts.base, views: { ...twice.parts.base.views, demo: (s) => s.translate([50, 0, 0]) } },
      lid: { ...twice.parts.lid, views: { ...twice.parts.lid.views, demo: (s, p) => lidAt(s, p).translate([50, 0, 0]) } } } };
    expect(verify(k, shifted, { view: "print" }).sweeps.map((r) => [r.name, r.view])).toEqual([["open", "assembly"]]);
  }, SLOW);

  it("a handle's DOF that moves only elsewhere runs there, though a sibling DOF moved here", () => {
    // `slide` moves the lid in `base` (well clear of the base), `open` only in `assembly`:
    // the handle's two entries are swept in two views, each where it moves something
    const base = hingeViews("buried", { gated: false });
    const part = {
      ...base,
      parameters: [{ ...base.parameters[0], controls: [...base.parameters[0].controls,
        { key: "slide", label: "Slide", unit: "mm", min: 0, max: 10, step: 1, description: "Slides the lid aside." }] }],
      defaults: { open: 0, slide: 0 },
      handles: { lid: { point: () => [15, 10, 20], params: ["slide", "open"], drag: "plane", normal: [0, 0, 1] } },
      parts: { ...base.parts,
        base: { ...base.parts.base },
        lid: { ...base.parts.lid, views: { ...base.parts.lid.views, base: (s, p) => s.translate([100 + p.slide, 0, 0]) } } },
      verify: { sweeps: { lid: { handle: "lid", clearance: 0 } } },
    };
    const own = measure(k, part, "base").sweeps;
    expect(own.map((r) => r.name)).toEqual(["lid.slide"]);
    const v = verify(k, part, { view: "base" });
    expect(v.sweeps.map((r) => [r.name, r.view])).toEqual([["lid.open", "assembly"]]);
    expect(v.sweeps[0].clear).toBe(false);
  }, SLOW);

  it("a quick lap still never sweeps, in any view", () => {
    const part = hingeViews("buried");
    const seed = measure(k, part, "base", {}, { sweeps: false });
    const v = verify(k, part, { view: "base", quick: true, seed: { params: {}, result: seed } });
    expect(gateOf(v)).toMatchObject({ unevaluated: true, message: "not measured (quick check)" });
    expect("sweeps" in v).toBe(false);
  }, SLOW);

  it("the inspect report's measure.sweeps carries the other view's rows, gate or no gate", async () => {
    const ungated = await inspectReport(hingeViews("buried", { gated: false }), { view: "base" });
    expect(ungated.measure.sweeps).toHaveLength(1);
    const [row] = ungated.measure.sweeps;
    expect(row).toMatchObject({ name: "open", view: "assembly", clear: false });
    expect(row.contacts.some((c) => [c.a, c.b].sort().join() === "base,lid" && c.allowed === false)).toBe(true);
    expect(ungated.verify.cases[0].checks.some((c) => c.metric === "sweepContacts")).toBe(false);

    const gated = await inspectReport(hingeViews("buried"), { view: "base" });
    expect(stripMs(gated.measure.sweeps)).toEqual(stripMs(ungated.measure.sweeps));
    expect(gated.verify.ok).toBe(false);
    expect(gateOf(gated.verify)).toMatchObject({ status: "fail", actual: 1 });
  }, SLOW);

  it("a single-view part's report has no other-view rows anywhere", async () => {
    const single = { ...buriedAxis, verify: { ...buriedAxis.verify, expect: { _view: { sweepContacts: 0 } } } };
    const r = await inspectReport(single, { view: "assembly" });
    expect(stripMs(r.measure.sweeps)).toEqual(stripMs(measure(k, single, "assembly").sweeps));
    expect("sweeps" in r.verify).toBe(false);
    expect(r.measure.sweeps.every((row) => !("view" in row))).toBe(true);
  }, SLOW);
});

describe("the CLI sweeps line", () => {
  it("prints a contact with its value, pair, driver and free range", () => {
    const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "test/fixtures/collide-bar-sweep.js", "--no-verify"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.startsWith("  sweeps:"));
    expect(line).toMatch(/^ {2}sweeps: swing CONTACT at (59|60)\.\d\d bar×palm driven by angle, free \[0, (59|60)\.\d\d\]$/);
  }, SLOW);

  it("prints how deep a contact presses on a sweep that may touch", () => {
    const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "test/fixtures/hinge-detent.js", "--no-verify"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.startsWith("  sweeps:"));
    expect(line).toMatch(/^ {2}sweeps: open CONTACT at (40|41)\.\d\d base×lid \(0\.(2|3)\dmm deep\) driven by open, free \[0, (39|40)\.\d\d\]$/);
  }, SLOW);

  const rub = { from: 40.0, to: 50.0, a: "lid", b: "base", at: [0, 0, 0], driver: "open", depth: 0.298, allowed: true };
  const clearRow = { name: "open", clear: true, clearance: -0.3, steps: 66, rebuilds: false,
    minClearance: { distance: -0.298, a: "lid", b: "base", at: [0, 0, 0], value: 45 }, contacts: [rub], freeRange: [0, 110], ms: 1 };
  it("an allowed rub reads clear, with the rub and its depth", () => {
    expect(sweepText(clearRow)).toBe("open clear (min -0.30mm base×lid), rub at 40 base×lid (0.30mm, allowed)");
    expect(sweepText({ ...clearRow, contacts: [rub, { ...rub, from: 80.5 }] })).toBe("open clear (min -0.30mm base×lid), rub at 40 base×lid (0.30mm, allowed) (+1 more)");
  });

  it("(+N more) counts the contacts a row's cap left off", () => {
    const hit = { ...rub, allowed: false, depth: 1 };
    const row = { ...clearRow, clear: false, clearance: 0, freeRange: null, contacts: [hit, { ...hit, from: 60 }], contactsOmitted: 3 };
    expect(sweepText(row)).toBe("open CONTACT at 40 base×lid (1.00mm deep) driven by open (+4 more)");
    expect(sweepText({ ...clearRow, contactsOmitted: 2 })).toBe("open clear (min -0.30mm base×lid), rub at 40 base×lid (0.30mm, allowed) (+2 more)");
  });

  it("a resting touch on a clear row prints nothing extra", () => {
    const rest = { ...rub, from: 0, to: 2, depth: 0.001 };
    expect(sweepText({ ...clearRow, clearance: 0, minClearance: { ...clearRow.minClearance, distance: 0 }, contacts: [rest] }))
      .toBe("open clear (min 0.00mm base×lid)");
  });

  it("a contact line names the first contact past the allowance, never an allowed rub", () => {
    const deep = { ...rub, from: 70.25, depth: 1.2, allowed: false };
    const s = { ...clearRow, clear: false, clearance: 0, contacts: [rub, deep], freeRange: [0, 69.9] };
    expect(sweepText(s)).toBe("open CONTACT at 70.25 base×lid (1.20mm deep) driven by open, free [0, 69.90]");
  });

  it("a positive-clearance contact line is unchanged", () => {
    const c = { from: 60.06, to: 180, a: "palm", b: "bar", at: [1, 2, 3], driver: "angle", depth: 1.7 };
    const s = { name: "swing", clear: false, clearance: 0.001, contacts: [c, { ...c, from: 120 }], freeRange: [0, 59.97] };
    expect(sweepText(s)).toBe("swing CONTACT at 60.06 bar×palm driven by angle, free [0, 59.97] (+1 more)");
  });
});

describe("a view no sweep moves", () => {
  it("reports an empty list, and sweepContacts reads 0 there", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1", views: ["elsewhere"] } }, gated);
    const r = measure(k, part, "cabinet");
    expect(r.sweeps).toEqual([]);
    const v = verify(k, part, { view: "cabinet", seed: { params: {}, result: r } });
    expect(v.cases[0].checks.find((c) => c.metric === "sweepContacts")).toMatchObject({ status: "pass", actual: 0 });
  }, SLOW);

  it("a quick lap withholds a declared sweep gate it could not read", () => {
    const part = barSweep(gated);
    const seed = measure(k, part, "assembly", {}, { sweeps: false });
    const v = verify(k, part, { view: "assembly", quick: true, seed: { params: {}, result: seed } });
    expect(v.ok).toBe(null);
    expect(v.unevaluated.map((c) => c.metric)).toContain("sweepContacts");
  }, SLOW);
});

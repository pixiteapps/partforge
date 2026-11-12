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
import { sweepText } from "../bin/sweep-text.js";

const SLOW = 120_000;
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const withSweeps = (part, sweeps, extra = {}) => ({ ...part, ...extra, verify: { ...part.verify, ...extra.verify, sweeps } });
// The bar swings 0 → 180° and meets the slab at 60°.
const barSweep = (extra = {}) => withSweeps(collideBar, { swing: { param: "angle" } }, extra);
const gated = { verify: { expect: { _view: { sweepContacts: 0 } } } };
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
    // an allowed rub, and a contact whose depth the clock never read: neither counts, so
    // the row has no reading and the gate is withheld, as for any sweep that stopped short
    const quiet = withRows([touching([{ ...contact, depth: 0, allowed: true }, { ...contact, from: 90, depth: null }])]);
    expect(gateOf(quiet)).toMatchObject({ status: "skip", actual: null, unevaluated: true });
    expect(notice(quiet)).toEqual(["1 sweep(s) stopped at the time budget: t"]);
    // one read past it does, and the warning names that one
    const hit = withRows([touching([{ ...contact, depth: 0, allowed: true }, { ...contact, from: 90, depth: 2, allowed: false, at: [4, 5, 6] }])]);
    expect(gateOf(hit)).toMatchObject({ status: "fail", actual: 1, location: [4, 5, 6] });
    expect(notice(hit)).toEqual(["1 sweep(s) stopped at the time budget: t (contact found at 90: bar×palm)"]);
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

  it("knuckles in the other plate, and a buried axis, fail the gate", () => {
    for (const part of [frameKnuckles, buriedAxis]) {
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

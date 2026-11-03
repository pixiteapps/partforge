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
    const r = measure(k, drawerBox, "cabinet");
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
    expect(flags[0]).not.toBe(false);
    expect(flags.slice(1).every((f) => f === false)).toBe(true);
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

  it("a timed-out sweep is one volunteered warning and moves nothing", () => {
    const part = barSweep(gated);
    const seed = measure(k, part, "assembly", {}, { deadline: -Infinity });
    const v = verify(k, part, { view: "assembly", seed: { params: {}, result: seed } });
    const w = v.warnings.filter((c) => c.metric === "sweeps");
    expect(w).toHaveLength(1);
    expect(w[0].volunteered).toBe(true);
    expect(w[0].message).toContain("swing");
    expect(w[0].hint).toMatch(/partforge measure/);
    // Only the gate counts toward declared/evaluated, and it read no ran row.
    expect(v.declared).toBe(1);
    expect(v.ok).toBe(true);
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

describe("the CLI sweeps line", () => {
  it("prints a contact with its value, pair, driver and free range", () => {
    const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "test/fixtures/collide-bar-sweep.js", "--no-verify"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.startsWith("  sweeps:"));
    expect(line).toMatch(/^ {2}sweeps: swing CONTACT at (59|60)\.\d\d bar×palm driven by angle, free \[0, (59|60)\.\d\d\]$/);
  }, SLOW);
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

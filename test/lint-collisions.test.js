import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (collisions) => ({
  meta: { title: "T" },
  defaults: {},
  parts: {
    base: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) },
    lid: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) },
  },
  views: { main: { label: "Main" } },
  collisions,
});
const findings = (collisions) => {
  const r = lintPart(partWith(collisions));
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule.startsWith("collisions-"));
};

test("a valid block is clean", () => {
  expect(findings({ clearance: 0.2, allow: ["lid×base"], pose: false })).toEqual([]);
  expect(findings(undefined)).toEqual([]);
});

test("collisions-unknown-part names the entry", () => {
  const f = findings({ allow: ["lid×ghost"] });
  expect(f.map((x) => x.rule)).toEqual(["collisions-unknown-part"]);
  expect(f[0].severity).toBe("error");
  expect(f[0].message).toContain("lid×ghost");
});

test("collisions-bad-pair: no × or the same part twice", () => {
  for (const entry of ["lid", "lid×lid"]) {
    const f = findings({ allow: [entry] });
    expect(f.map((x) => x.rule)).toEqual(["collisions-bad-pair"]);
    expect(f[0].severity).toBe("error");
  }
});

test("collisions-bad-clearance: negative or non-numeric", () => {
  for (const clearance of [-1, "x"]) {
    const f = findings({ clearance });
    expect(f.map((x) => x.rule)).toEqual(["collisions-bad-clearance"]);
    expect(f[0].severity).toBe("error");
  }
});

// ── sweeps ──────────────────────────────────────────────────────────────────
const control = (key, min, max) => ({ key, label: key, min, max, step: 1, description: key });
const sweepPart = (sweeps, extra = {}) => ({
  meta: { title: "S" },
  parameters: [{ id: "g", title: "G", description: "d", controls: [
    control("swing", 0, 90), control("size", 1, 10), { key: "loose", label: "loose", description: "no range" },
    { type: "preset", label: "Shape", presets: { open: { swing: 0 }, shut: { swing: 90 } } },
  ] }],
  defaults: { swing: 0, size: 5, loose: 1 },
  parts: {
    base: { views: { main: (s) => s }, build: (k, p) => k.box({ size: [p.size, 1, 1] }) },
    lid: { views: { main: (s, p) => s.rotate(p.swing, [0, 0, 0], [0, 1, 0]) }, build: (k) => k.box({ size: [1, 1, 1] }) },
  },
  views: { main: { label: "Main", animations: { close: { steps: [{ duration: 1, tracks: { swing: [[0, 0], [1, 90]] } }] } } } },
  handles: {
    hinge: { point: () => [0, 0, 0], drag: "rotary", axis: [0, 1, 0], params: ["swing"] },
    reach: { point: () => [0, 0, 0], drag: "goal", params: ["swing"] },
  },
  collisions: {},
  verify: { sweeps },
  ...extra,
});
const sweepFindings = (sweeps, extra) => {
  const r = lintPart(sweepPart(sweeps, extra));
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule.startsWith("sweep-"));
};

test("valid sweeps are clean", () => {
  expect(sweepFindings({
    p: { param: "swing" }, h: { handle: "hinge" }, path: { from: "open", to: "shut" },
    wp: { path: [{ swing: 0 }, { swing: 45 }] }, a: { animation: "close" }, r: { param: "swing", range: [0, 45] },
  })).toEqual([]);
  expect(sweepFindings(undefined)).toEqual([]);
});

test("sweep-unknown-target: an unknown param, handle, preset or animation, or a param with no range", () => {
  for (const spec of [{ param: "ghost" }, { param: "loose" }, { handle: "ghost" }, { from: "open", to: "ghost" }, { animation: "ghost" }, {}]) {
    const f = sweepFindings({ s: spec });
    expect(f.map((x) => x.rule), JSON.stringify(spec)).toEqual(["sweep-unknown-target"]);
    expect(f[0].severity).toBe("error");
    expect(f[0].path).toBe("verify.sweeps.s");
  }
});

test("sweep-goal-handle warns: a goal handle is a target, not a motion", () => {
  const f = sweepFindings({ s: { handle: "reach" } });
  expect(f.map((x) => x.rule)).toEqual(["sweep-goal-handle"]);
  expect(f[0].severity).toBe("warning");
});

test("sweep-rebuilds warns when the motion changes a build", () => {
  const f = sweepFindings({ s: { param: "size" } });
  expect(f.map((x) => x.rule)).toEqual(["sweep-rebuilds"]);
  expect(f[0].severity).toBe("warning");
  expect(f[0].message).toContain("this sweep rebuilds geometry at every step and runs slower");
});

test("sweep-rebuilds samples the whole motion, as the engine does, not only its ends", () => {
  // The base's build reads swing only inside (40, 50): its two ends build alike.
  const parts = {
    base: { views: { main: (s) => s }, build: (k, p) => k.box({ size: [p.swing > 40 && p.swing < 50 ? 2 : 1, 1, 1] }) },
    lid: { views: { main: (s, p) => s.rotate(p.swing, [0, 0, 0], [0, 1, 0]) }, build: (k) => k.box({ size: [1, 1, 1] }) },
  };
  const f = sweepFindings({ s: { param: "swing" } }, { parts });
  expect(f.map((x) => x.rule)).toEqual(["sweep-rebuilds"]);
});

test("sweep-rebuilds counts a placement that is no rigid transform", () => {
  const parts = {
    base: { views: { main: (s) => s }, build: (k) => k.box({ size: [1, 1, 1] }) },
    lid: { views: { main: (s, p) => s.scale(1 + p.swing / 90) }, build: (k) => k.box({ size: [1, 1, 1] }) },
  };
  const f = sweepFindings({ s: { param: "swing" } }, { parts });
  expect(f.map((x) => x.rule)).toEqual(["sweep-rebuilds"]);
});

test("each sweep is read once per lint pass, whatever the number of sweep rules", () => {
  let reads = 0;
  const handles = { hinge: { point: () => { reads++; return [0, 0, 0]; }, drag: "rotary", axis: [0, 1, 0], params: ["swing"] } };
  const r = lintPart(sweepPart({ h: { handle: "hinge" } }, { handles }));
  const before = reads;
  expect(r.errors.filter((x) => x.rule.startsWith("sweep-"))).toEqual([]);
  // The handle rules read the point too; the sweep rules add exactly one read (readSweep's).
  const { verify: _v, ...noSweeps } = sweepPart({}, { handles });
  reads = 0;
  lintPart(noSweeps);
  expect(before - reads).toBe(1);
});

// The sweep engine (spec "Sweeps"): a declared motion stepped end to end for contact,
// with the first contact, the param that drives it and the free range around the
// current value. Real parts built by Manifold; the bar fixtures are plain boxes.
import { beforeAll, describe, expect, it } from "vitest";
import drawerBox from "../src/parts/drawer-box.js";
import hand from "../src/parts/hand.js";
import gearbox from "../src/parts/gearbox.js";
import { bootManifoldKernel } from "../src/testing.js";
import { runSweeps, normalizeSweeps, capContacts, SWEEP_REBUILD_STEPS, SWEEP_MAX_STEPS, SWEEP_MAX_CONTACTS, DEPTH_STEP_MM } from "../src/framework/oracle/sweep.js";
import { presetMap } from "../src/framework/oracle/cases.js";
import { buildView } from "../src/framework/oracle/build.js";
import { createCollisionWorld, relativeMatsAt } from "../src/framework/collide/world.js";
import { resolveParams } from "../src/framework/part-model.js";
import { collideBar, collideBarTwo } from "./fixtures/collide-bar.js";
import { readSweep } from "../src/framework/collide/sweep-targets.js";
import { TOUCH_TOL_MM } from "../src/framework/collide/world.js";
import frameKnuckles from "./fixtures/hinge-frame-knuckles.js";
import buriedAxis from "./fixtures/hinge-buried-axis.js";
import detent from "./fixtures/hinge-detent.js";
import { buttingKnuckles } from "./fixtures/hinge-butting-knuckles.js";
import { queryingLid } from "./fixtures/querying-lid.js";
import { readFileSync } from "node:fs";

const SLOW = 120_000;
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const withSweeps = (part, sweeps, extra = {}) => ({ ...part, ...extra, verify: { ...part.verify, sweeps } });
const control = (key, min, max) => ({ key, label: key, unit: "°", min, max, step: 0.1, description: key });
const boxPart = ({ boxes, controls, defaults, views, sweeps }) => ({
  meta: { title: "sweep fixture", units: "mm" },
  parameters: [{ id: "g", title: "G", description: "d", controls }],
  defaults,
  parts: Object.fromEntries(Object.entries(boxes).map(([name, build]) => [name, { label: name, build, views: { assembly: views[name] ?? ((s) => s) } }])),
  views: { assembly: { label: "Assembly" } },
  collisions: {},
  verify: { sweeps },
});

// A 20 mm bar on a pin swinging down over [0, ang]°, and a block whose corner sits `p` mm
// inside the arc the bar's far corner sweeps: the corner grazes it between two steps.
function grazePart(p, ang) {
  const L = 20, h = 2, pin = 20, r = Math.hypot(L, h), a = (ang * Math.PI) / 180;
  const q = [(r - p) * Math.cos(a), pin - (r - p) * Math.sin(a)];
  return boxPart({
    boxes: {
      block: (kk) => kk.box({ min: [q[0], -5, q[1] - 10], max: [q[0] + 10, 5, q[1]] }),
      bar: (kk) => kk.box({ min: [0, -5, pin - h], max: [L, 5, pin + h] }),
    },
    views: { bar: (s, pp) => s.rotate(pp.angle, [0, 0, pin], [0, 1, 0]) },
    controls: [control("angle", 0, 90)],
    defaults: { angle: 0 },
    sweeps: { swing: { param: "angle", range: [0, ang] } },
  });
}

/** The first value in [lo, hi] (every `dv`) where a and b come within eps: the dense answer. */
function denseFirstContact(part, key, lo, hi, dv, eps = 1e-3) {
  const st = resolveParams(part, { [key]: lo });
  const world = createCollisionWorld({ meshes: new Map(buildView(k, part, "assembly", { [key]: lo }).map((b) => [b.name, b.mesh])) });
  const rel = relativeMatsAt(part, "assembly", st.p, st.d);
  const [a, b] = world.names();
  try {
    for (let v = lo; v <= hi; v += dv) {
      const q = resolveParams(part, { [key]: v });
      if (world.within(rel(q.p, q.d), a, b, eps)) return v;
    }
    return null;
  } finally { world.dispose(); }
}

const strip = (rows) => rows.map(({ ms: _ms, ...r }) => r);

describe("sweep engine", () => {
  it("exports its step caps", () => {
    expect(SWEEP_REBUILD_STEPS).toBe(24);
    expect(SWEEP_MAX_STEPS).toBe(2000);
    expect(DEPTH_STEP_MM).toBe(0.2);
  });

  it("drawer travel is clear", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1" } });
    const rows = runSweeps(k, part, "cabinet", part.defaults);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.name).toBe("d1.drawer1Open");
    expect(row.clear).toBe(true);
    expect(row.rebuilds).toBe(false);
    expect(row.capped).toBeUndefined();
    expect(row.minClearance.distance).toBeGreaterThan(0.95);
    expect(row.minClearance.distance).toBeLessThan(1.05);
    expect(row.freeRange).toEqual([0, 100]);
  }, SLOW);

  it("rotation finds first contact", () => {
    const part = withSweeps(collideBar, { swing: { param: "angle", range: [0, 90] } });
    const [row] = runSweeps(k, part, "assembly", { angle: 0 });
    expect(row.clear).toBe(false);
    expect(Math.abs(row.contacts[0].from - 60)).toBeLessThan(0.1);
    expect(row.contacts[0].driver).toBe("angle");
    expect(row.contacts[0].to).toBe(90);
    expect(row.freeRange[0]).toBe(0);
    expect(Math.abs(row.freeRange[1] - 60)).toBeLessThan(0.1);
    // a positive clearance: the contact carries its depth (the bar ends ploughed into the
    // slab), and no allowance
    expect(row.contacts[0].depth).toBeGreaterThan(1.5); // about 1.7 mm at 90°
    expect("allowed" in row.contacts[0]).toBe(false);
  }, SLOW);

  it("an empty sub-part in the view does not stop a sweep", () => {
    // slab, swinging bar, and a sub-part whose solid is empty: the bar's contact is still found
    const empty = (kk) => kk.box({ min: [0, 0, 0], max: [1, 1, 1] }).cut(kk.box({ min: [-1, -1, -1], max: [2, 2, 2] }));
    const base = withSweeps(collideBar, { swing: { param: "angle", range: [0, 90] } });
    const part = { ...base, parts: { ...base.parts, hollow: { label: "hollow", build: empty, views: { assembly: (s) => s } } } };
    const [row] = runSweeps(k, part, "assembly", { angle: 0 });
    expect(row.skipped).toBeUndefined();
    expect(row.clear).toBe(false);
    expect(Math.abs(row.contacts[0].from - 60)).toBeLessThan(0.1);
  }, SLOW);

  it("a graze between two clear steps is found", () => {
    const part = grazePart(0.05, 35);
    const [row] = runSweeps(k, part, "assembly", { angle: 0 });
    const truth = denseFirstContact(part, "angle", 0, 35, 0.005);
    expect(truth).toBeGreaterThan(29);
    expect(truth).toBeLessThan(29.4);
    expect(row.clear).toBe(false);
    expect(row.contacts).toHaveLength(1);
    const [c] = row.contacts;
    expect([c.a, c.b]).toEqual(["block", "bar"]);
    expect(Math.abs(c.from - truth)).toBeLessThan(0.1);
    expect(c.to).toBeGreaterThan(c.from);
    expect(c.to).toBeLessThan(35); // it grazes and leaves
    expect(c.driver).toBe("angle");
    expect(row.minClearance.distance).toBeLessThanOrEqual(1e-3);
    expect(row.freeRange[1]).toBeLessThanOrEqual(c.from);
    expect(Math.abs(row.freeRange[1] - truth)).toBeLessThan(0.1);
  }, SLOW);

  it("two grazes of one pair inside a single step are both found", () => {
    // a 2 mm square rotor spinning about the origin, and one block whose two outer corners
    // sit 0.02 mm inside the arc its corners sweep, 8° apart: a rotor corner grazes them at
    // ≈76° and ≈84°, both inside the sweep's last step (68° → 90°), so only advancing the
    // clear piece a first graze's bisection leaves finds the second
    const s = 1, r = s * Math.SQRT2, p = 0.02;
    const corner = (deg) => [(r - p) * Math.cos((deg * Math.PI) / 180), (r - p) * Math.sin((deg * Math.PI) / 180)];
    const [q1, q2] = [corner(50), corner(58)];
    const part = boxPart({
      boxes: {
        block: (kk) => kk.union([
          kk.box({ min: [q1[0], -5, q1[1]], max: [q1[0] + 5, 5, q1[1] + 5] }),
          kk.box({ min: [q2[0], -5, q2[1]], max: [q2[0] + 5, 5, q2[1] + 5] }),
        ]),
        rotor: (kk) => kk.box({ min: [-s, -5, -s], max: [s, 5, s] }),
      },
      views: { rotor: (q, pp) => q.rotate(pp.angle, [0, 0, 0], [0, 1, 0]) },
      controls: [control("angle", 0, 360)],
      defaults: { angle: 0 },
      sweeps: { spin: { param: "angle", range: [0, 90] } },
    });
    const [row] = runSweeps(k, part, "assembly", { angle: 0 });
    const truth = denseFirstContact(part, "angle", 0, 90, 0.01);
    expect(row.clear).toBe(false);
    expect(row.contacts).toHaveLength(2);
    const [c1, c2] = row.contacts;
    expect(Math.abs(c1.from - truth)).toBeLessThan(0.1);
    expect(c2.from).toBeGreaterThan(c1.to);
    expect(c1.from).toBeGreaterThan(68);
    expect(c2.from - c1.from).toBeGreaterThan(6);
    expect(c2.from - c1.from).toBeLessThan(10);
    expect(row.freeRange[0]).toBe(0);
    expect(row.freeRange[1]).toBeLessThanOrEqual(c1.from);
    expect(Math.abs(row.freeRange[1] - truth)).toBeLessThan(0.1);
  }, SLOW);

  it("a sweep capped short of its travel bound says so, and still finds contact", () => {
    const part = withSweeps(collideBar, { swing: { param: "angle", range: [0, 90] } });
    const [row] = runSweeps(k, part, "assembly", { angle: 0 }, { maxSteps: 4 });
    expect(row.capped).toBe(true);
    expect(row.steps).toBeLessThanOrEqual(4);
    expect(Math.abs(row.contacts[0].from - 60)).toBeLessThan(0.1);
  }, SLOW);

  it("a clearance requirement fails a close pass", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1", clearance: 2 } });
    const [row] = runSweeps(k, part, "cabinet", part.defaults);
    expect(row.clearance).toBe(2);
    expect(row.clear).toBe(false);
    expect(row.contacts.some((c) => c.a === "carcass" && c.b === "drawer1")).toBe(true);
    // only pairs with a moving piece: drawer2 sits just as close, but never moves here
    expect(row.contacts.every((c) => c.a === "drawer1" || c.b === "drawer1")).toBe(true);
  }, SLOW);

  it("path sweep between presets", () => {
    // open → fist on the index finger and the thumb alone (the other fingers held open),
    // over the window t ∈ [0.7, 0.95] of that blend: the thumb's tip passes through the
    // index's at t ≈ 0.777–0.875 (the whole open → fist path, every finger moving, finds the
    // same pair over the same window, but takes ~16 s)
    const presets = presetMap(hand);
    const digits = (o) => Object.fromEntries(Object.entries(o).filter(([key]) => /^(index|thumb)/.test(key)));
    const a = presets.open, b = { ...presets.open, ...digits(presets.fist) };
    const blend = (t) => Object.fromEntries(Object.keys(b).map((key) => [key, typeof b[key] === "number" ? a[key] + (b[key] - a[key]) * t : b[key]]));
    const [t0, t1] = [0.7, 0.95];
    const part = withSweeps(hand, { fist: { path: [blend(t0), blend(t1)], clearance: 0.3 } });
    const [row] = runSweeps(k, part, "assembly", hand.defaults);
    expect(row.steps).toBeGreaterThan(1);
    expect(row.rebuilds).toBe(false);
    expect(row.clear).toBe(false);
    expect(row.contacts).toHaveLength(1);
    const [c] = row.contacts;
    expect([c.a, c.b]).toEqual(["thumbDistal", "indexDistal"]);
    const along = (v) => t0 + (t1 - t0) * v;
    expect(along(c.from)).toBeGreaterThan(0.77);
    expect(along(c.from)).toBeLessThan(0.79);
    expect(along(c.to)).toBeGreaterThan(0.86);
    expect(along(c.to)).toBeLessThan(0.89);
    expect(c.driver).toBe("indexKnuckle");
    expect(row.minClearance.value).toBeGreaterThanOrEqual(0);
    expect(row.minClearance.value).toBeLessThanOrEqual(1);
    expect(row.freeRange).toBeNull(); // a path has no single param to range
  }, SLOW);

  it("presets name a path's ends", () => {
    const part = withSweeps(hand, { fist: { from: "open", to: "fist" } });
    const [s] = normalizeSweeps(part, "assembly", hand.defaults);
    expect(s.kind).toBe("path");
    expect(s.waypoints).toEqual([presetMap(hand).open, presetMap(hand).fist]);
  });

  it("coupled driver", () => {
    // a slides the bar along the slab, b swings it down: only b closes the pair
    const part = withSweeps(collideBarTwo, { both: { path: [{ a: 0, b: 0 }, { a: 20, b: 90 }] } });
    const [row] = runSweeps(k, part, "assembly", {});
    expect(row.clear).toBe(false);
    expect(Math.abs(row.contacts[0].from - 60 / 90)).toBeLessThan(2e-3);
    expect(row.contacts[0].driver).toBe("b");
  }, SLOW);

  it("shape-changing sweep rebuilds", () => {
    const part = withSweeps(drawerBox, { width: { param: "width" } });
    const [row] = runSweeps(k, part, "cabinet", part.defaults);
    expect(row.rebuilds).toBe(true);
    expect(row.steps).toBeLessThanOrEqual(24);
    expect(row.steps).toBeGreaterThan(1);
    expect(row.clear).toBe(true);
  }, SLOW);

  // A build the probe cannot trust (it queries its solid) is judged by what it reads, the
  // rule motion coverage uses (collide/untrusted-reads.js): one that never reads the swept
  // param is moved by matrix, so a contact between two of the 24 fixed rebuild steps is found.
  it("an untrusted build that does not read the param is moved rigidly, not rebuilt", () => {
    const [row] = runSweeps(k, queryingLid(), "assembly", {});
    expect(row.rebuilds).toBe(false);
    expect(row.clear).toBe(false);
    const blocking = row.contacts.filter((c) => c.allowed === false);
    expect(blocking.map((c) => [c.a, c.b].sort().join("×"))).toEqual(["bar×post"]);
    const { from } = blocking[0];
    expect(from).toBeGreaterThan(180 / SWEEP_REBUILD_STEPS);
    expect(from).toBeLessThan(2 * 180 / SWEEP_REBUILD_STEPS);
    // the build that reads the param still rebuilds, and its fixed steps miss the post
    const [rebuilt] = runSweeps(k, queryingLid({ readsOpen: true }), "assembly", {});
    expect(rebuilt.rebuilds).toBe(true);
    expect(rebuilt.clear).toBe(true);
  }, SLOW);

  it("a rebuilt sub-part's contact is bisected", () => {
    // a bar that grows toward a block at x = 30: it touches once its length reaches 30
    const part = boxPart({
      boxes: {
        block: (kk) => kk.box({ min: [30, -5, -5], max: [40, 5, 5] }),
        bar: (kk, p) => kk.box({ min: [0, -2, -2], max: [p.len, 2, 2] }),
      },
      views: {},
      controls: [control("len", 10, 50)],
      defaults: { len: 15 },
      sweeps: { grow: { param: "len" } },
    });
    const [row] = runSweeps(k, part, "assembly", { len: 15 });
    expect(row.rebuilds).toBe(true);
    expect(row.steps).toBe(24);
    expect(row.clear).toBe(false);
    const [c] = row.contacts;
    expect(Math.abs(c.from - 30)).toBeLessThan(0.05); // 1e-3 of the 40 mm range
    expect(c.to).toBe(50);
    expect(Math.abs(row.freeRange[1] - 30)).toBeLessThan(0.05);
    expect(row.freeRange[0]).toBe(10);
  }, SLOW);

  it("a free range bounded on both sides", () => {
    // the bar between a slab below and a ceiling above: swinging down meets the slab at
    // +60°, swinging up meets the ceiling at -60°
    const L = 20, h = 2, pin = L * Math.sin(Math.PI / 3) + h * Math.cos(Math.PI / 3);
    const part = boxPart({
      boxes: {
        floor: (kk) => kk.box({ min: [-60, -100, -10], max: [60, 100, 0] }),
        ceiling: (kk) => kk.box({ min: [-60, -100, 2 * pin], max: [60, 100, 2 * pin + 10] }),
        bar: (kk) => kk.box({ min: [0, -5, pin - h], max: [L, 5, pin + h] }),
      },
      views: { bar: (s, p) => s.rotate(p.angle, [0, 0, pin], [0, 1, 0]) },
      controls: [control("angle", -90, 90)],
      defaults: { angle: 10 },
      sweeps: { swing: { param: "angle" } },
    });
    const [row] = runSweeps(k, part, "assembly", { angle: 10 });
    expect(row.contacts.map((c) => c.a)).toEqual(["ceiling", "floor"]);
    expect(Math.abs(row.freeRange[0] + 60)).toBeLessThan(0.2);
    expect(Math.abs(row.freeRange[1] - 60)).toBeLessThan(0.2);
  }, SLOW);

  it("the still-pair skip changes nothing", () => {
    const part = withSweeps(hand, { thumb: { param: "thumbCurl" } });
    const on = runSweeps(k, part, "assembly", hand.defaults);
    const off = runSweeps(k, part, "assembly", hand.defaults, { skipStill: false });
    expect(strip(on)).toEqual(strip(off));
  }, SLOW);

  it("animation sweep", () => {
    // The meshing pairs (and the crank keyed to its gear) allowed: the spin still finds the
    // crank's resting touch — its hub bears on gear1's axle top, flush (distance 0), the
    // whole turn. Its arm rides ARM_LIFT clear of gear2's tooth tips, so that pair is clear.
    const meshing = ["gear1×gear2", "gear2×gear3", "crank×gear1"];
    const part = withSweeps(gearbox, { spin: { animation: "spin" } }, { collisions: { allow: meshing } });
    const [row] = runSweeps(k, part, "gearbox", gearbox.defaults);
    expect(row.name).toBe("spin");
    expect(row.rebuilds).toBe(false);
    expect(row.steps).toBeGreaterThan(1);
    expect(row.clear).toBe(false);
    expect([...new Set(row.contacts.map((c) => `${c.a}×${c.b}`))].sort()).toEqual(["plate×crank"]);
    expect(row.contacts[0].from).toBe(0);

    // The part's own declaration allows that bearing contact too: the spin is clear.
    expect(gearbox.collisions.allow).toEqual([...meshing, "plate×crank"]);
    const [clear] = runSweeps(k, gearbox, "gearbox", gearbox.defaults);
    expect(clear.clear).toBe(true);
    expect(clear.minClearance.distance).toBeGreaterThan(0.29);
  }, SLOW);

  it("no row where nothing moves", () => {
    const part = withSweeps(hand, { curl: { param: "indexCurl" } });
    expect(normalizeSweeps(part, "print", hand.defaults)).toEqual([]);
    expect(runSweeps(k, part, "print", hand.defaults)).toEqual([]);
    expect(normalizeSweeps(part, "assembly", hand.defaults)).toHaveLength(1);
  }, SLOW);

  it("a goal handle yields no sweep", () => {
    const part = { ...collideBar, handles: { tip: { on: "arm", drag: "goal", params: { position: ["angle"] } } }, verify: { sweeps: { tip: { handle: "tip" } } } };
    expect(normalizeSweeps(part, "assembly", {})).toEqual([]);
  });

  it("sweep skips an unreadable target", () => {
    const spin = gearbox.views.gearbox.animations.spin;
    const still = { ...gearbox, views: { gearbox: { ...gearbox.views.gearbox, animations: { spin: { ...spin, duration: 0 } } } } };
    const part = withSweeps(still, {
      nope: { param: "noSuchParam" },
      ghost: { animation: "noSuchAnimation" },
      gone: { from: "open", to: "noSuchPreset" },
      lost: { handle: "noSuchHandle" },
      adrift: { handle: "adrift" },
      spin: { animation: "spin" },
    }, { handles: { ...gearbox.handles, adrift: { on: "noSuchSource", at: "x", params: ["driveAngle"], drag: "rotary" } } });
    const rows = runSweeps(k, part, "gearbox", gearbox.defaults);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    for (const name of ["nope", "ghost", "gone", "lost", "adrift"]) expect(by[name].skipped).toBe("unreadable");
    expect(by.spin.skipped).toBe("no-motion");
    for (const r of rows) expect(r.clear).toBeNull();
  }, SLOW);

  it("a sweep that throws is unreadable, and the others still run", () => {
    const part = withSweeps(collideBarTwo, { slide: { param: "a" }, swing: { param: "b", range: [0, 90] } });
    const boom = { ...part, parts: { ...part.parts, palm: { ...part.parts.palm, build: (kk, p) => { if (p.a > 5) throw new Error("palm: too far"); return part.parts.palm.build(kk, p); } } } };
    const rows = runSweeps(k, boom, "assembly", {});
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.slide.skipped).toBe("unreadable");
    expect(by.slide.error).toMatch(/too far/);
    expect(by.swing.skipped).toBeUndefined();
    expect(by.swing.clear).toBe(false);
  }, SLOW);

  it("deadline", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1" }, d2: { handle: "drawer2" }, width: { param: "width" } });
    const rows = runSweeps(k, part, "cabinet", part.defaults, { deadline: 100, now: () => 1000 });
    expect(rows.map((r) => r.name)).toEqual(["d1.drawer1Open", "d2.drawer2Open", "width"]);
    for (const r of rows) { expect(r.skipped).toBe("timeout"); expect(r.clear).toBeNull(); }
  });

  it("a deadline mid-sweep keeps what it read", () => {
    const part = withSweeps(collideBar, { swing: { param: "angle" } });
    let ticks = 0;
    const [row] = runSweeps(k, part, "assembly", {}, { deadline: 5, now: () => ticks++ });
    expect(row.skipped).toBe("timeout");
    expect(row.steps).toBeGreaterThan(0);
  });

  it("a sweep's views limit where it runs", () => {
    const part = withSweeps(hand, { curl: { param: "indexCurl", views: ["print"] } });
    expect(normalizeSweeps(part, "assembly", hand.defaults)).toEqual([]);
  });
});

// Sweep clearance at and below zero (spec 2026-11-12-moving-fits-swept-design.md, B): 0 may
// touch but never press in, a negative clearance may press in up to that depth.
describe("touching and pressing-in sweeps", () => {
  const AXIS = [0, -3, 0]; // the hinge axis, along X, behind the base's back wall at the seam
  // A closed lid resting on its base, hinged on a 1 mm pin in two 1.175 mm bores (a
  // 0.175 mm running gap). `sink` sets the lid's box that far into the base at 0°.
  const pinnedLid = (sink = 0) => boxPart({
    boxes: {
      base: (kk) => [0, 14].reduce((s, x0) => s.union(kk.cylinder({ r: 2.8, h: 6 }).cut(kk.cylinder({ r: 1.175, h: 8 }).translate([0, 0, -1]))
        .along("+X").translate([x0, AXIS[1], AXIS[2]])), kk.box({ min: [0, 0, -5], max: [20, 20, 0] })),
      lid: (kk) => kk.box({ min: [0, 0, -sink], max: [20, 20, 5 - sink] })
        .union(kk.cylinder({ r: 1, h: 20 }).along("+X").translate([0, AXIS[1], AXIS[2]])),
    },
    views: { lid: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: AXIS }) },
    controls: [control("open", 0, 110)],
    defaults: { open: 0 },
    sweeps: { open: { param: "open", clearance: 0 } },
  });
  const detentAt = (clearance) => withSweeps(detent, { open: { param: "open", clearance } });

  it("a lid resting closed on a running pin is clear at clearance 0", () => {
    const [row] = runSweeps(k, pinnedLid(), "assembly", { open: 0 });
    expect(row.clearance).toBe(0);
    expect(row.clear).toBe(true);
    for (const c of row.contacts) {
      expect(c.allowed).toBe(true);
      expect(c.depth).toBeLessThanOrEqual(TOUCH_TOL_MM);
    }
    expect(row.freeRange).toEqual([0, 110]);
  }, SLOW);

  it("the same lid set 1 mm into its base is a contact, as deep as it presses", () => {
    const [row] = runSweeps(k, pinnedLid(1), "assembly", { open: 0 });
    expect(row.clear).toBe(false);
    const [c] = row.contacts;
    expect(c.from).toBe(0);
    expect(c.allowed).toBe(false);
    expect(c.depth).toBeGreaterThan(0.9);
    expect(c.depth).toBeLessThan(1.1);
    expect(row.minClearance.distance).toBeCloseTo(-c.depth, 9);
  }, SLOW);

  it("a detent within a negative clearance is an allowed rub", () => {
    const [row] = runSweeps(k, detentAt(-0.3), "assembly", { open: 0 });
    expect(row.clearance).toBe(-0.3);
    expect(row.clear).toBe(true);
    expect(row.contacts).toHaveLength(1);
    const [c] = row.contacts;
    expect(c.allowed).toBe(true);
    expect(c.depth).toBeGreaterThan(0.25);
    expect(c.depth).toBeLessThan(0.35);
    expect(c.from).toBeGreaterThan(38);
    expect(c.to).toBeLessThan(52);
    expect(row.minClearance.distance).toBeCloseTo(-c.depth, 9);
    expect(row.freeRange).toEqual([0, 110]); // an allowed rub is free
  }, SLOW);

  it("the same detent at clearance 0, or past a smaller allowance, is a contact", () => {
    for (const clearance of [0, -0.1]) {
      const [row] = runSweeps(k, detentAt(clearance), "assembly", { open: 0 });
      expect(row.clear, String(clearance)).toBe(false);
      // the rub's shallow ends are allowed stretches; its middle presses in too deep
      const blocking = row.contacts.filter((x) => !x.allowed);
      expect(blocking).toHaveLength(1);
      const [c] = blocking;
      expect(c.from).toBeGreaterThan(38);
      expect(c.to).toBeLessThan(52);
      expect(row.freeRange[1]).toBeLessThanOrEqual(c.from);
    }
  }, SLOW);

  it("knuckles centred on the axis with no relief press in all the way round", () => {
    const [row] = runSweeps(k, frameKnuckles, "assembly", frameKnuckles.defaults);
    expect(row.clear).toBe(false);
    expect(row.contacts).toHaveLength(1);
    const [c] = row.contacts;
    expect([c.a, c.b]).toEqual(["base", "lid"]);
    expect(c.from).toBe(0);
    expect(c.to).toBe(110);
    expect(c.depth).toBeGreaterThan(1);
    expect(c.allowed).toBe(false);
  }, SLOW);

  it("a buried axis rests clear closed and presses in as it opens", () => {
    const [row] = runSweeps(k, buriedAxis, "assembly", buriedAxis.defaults);
    expect(row.clear).toBe(false);
    // resting closed is an allowed touch; the contact starts where the lid presses in
    // (true onset about 0.23°: the depth reading is a lower bound, so a little later)
    const [rest, c] = row.contacts;
    expect(row.contacts).toHaveLength(2);
    expect(rest).toMatchObject({ from: 0, allowed: true });
    expect(c.from).toBeGreaterThan(0.2);
    expect(c.from).toBeLessThan(1);
    expect(c.to).toBe(110);
    expect(c.driver).toBe("open");
    expect(c.allowed).toBe(false);
    expect(c.depth).toBeGreaterThan(1);
  }, SLOW);

  it("a deadline while reading depth marks the contact unread and the row timed out", () => {
    // the sweep itself fits; the clock runs out once its contact is being read
    let ticks = 0;
    const part = withSweeps(detent, { open: { param: "open", clearance: -0.3 } });
    const steps = runSweeps(k, part, "assembly", { open: 0 })[0].steps;
    // one now() before the sweep, one at its start and one per step after the first, then
    // one per depth reading: the deadline lands after three readings
    const [row] = runSweeps(k, part, "assembly", { open: 0 }, { deadline: steps + 3, now: () => ticks++ });
    expect(row.skipped).toBe("timeout");
    expect(row.clear).toBeNull();
    expect(row.contacts).toHaveLength(1);
    expect(row.contacts[0].depthUnread).toBe(true);
    expect(row.contacts[0].depth).toBeTypeOf("number"); // the deepest read so far
    expect("allowed" in row.contacts[0]).toBe(false);
  }, SLOW);

  it("a stretch read past the allowance before the deadline is kept as a contact; only the rest is unread", () => {
    // the detent at clearance 0: its rub crosses the allowance and back. Cut the depth
    // walk at every reading in turn: once a stretch past the allowance is read, it stays a
    // blocking contact, and only what follows the last stretch read is unread
    const part = withSweeps(detent, { open: { param: "open", clearance: 0 } });
    const [whole] = runSweeps(k, part, "assembly", { open: 0 });
    const over = whole.contacts.find((c) => c.allowed === false);
    let sawBoth = false;
    for (let extra = 1; extra < 400; extra++) {
      let ticks = 0;
      const [row] = runSweeps(k, part, "assembly", { open: 0 }, { deadline: whole.steps + extra, now: () => ticks++ });
      if (!row.skipped) break; // the walk fit: nothing left to cut
      const unread = row.contacts.filter((c) => c.depthUnread);
      expect(unread).toHaveLength(1);
      const blocking = row.contacts.filter((c) => c.allowed === false);
      for (const c of blocking) {
        expect(c.from).toBeGreaterThanOrEqual(over.from - 1e-9);
        expect(c.to).toBeLessThanOrEqual(unread[0].from + 1e-9);
        expect(c.depth).toBeGreaterThan(TOUCH_TOL_MM);
      }
      expect(unread[0].to).toBe(whole.contacts.at(-1).to);
      if (blocking.length) sawBoth = true;
    }
    expect(sawBoth).toBe(true);
  }, SLOW);

  it("a row carries at most SWEEP_MAX_CONTACTS contacts, blocking ones first", () => {
    // a block sliding past 40 posts meets each in turn: 40 contacts, 32 kept
    const posts = 40;
    const part = boxPart({
      boxes: {
        comb: (kk) => Array.from({ length: posts }, (_, i) => kk.box({ min: [10 * i + 10, -1, 0], max: [10 * i + 12, 1, 5] }))
          .reduce((a, b) => a.union(b)),
        slider: (kk) => kk.box({ min: [0, -3, 1], max: [2, 3, 3] }),
      },
      views: { slider: (s, p) => s.translate([p.x, 0, 0]) },
      controls: [{ ...control("x", 0, 420), unit: "mm" }],
      defaults: { x: 0 },
      sweeps: { slide: { param: "x" } },
    });
    const [row] = runSweeps(k, part, "assembly", { x: 0 });
    expect(row.clear).toBe(false);
    expect(row.contacts).toHaveLength(SWEEP_MAX_CONTACTS);
    expect(row.contactsOmitted).toBe(posts - SWEEP_MAX_CONTACTS);
    // freeRange was read before the cap: up to the first post
    expect(row.freeRange[0]).toBe(0);
    expect(row.freeRange[1]).toBeLessThanOrEqual(8.01);
    const froms = row.contacts.map((c) => c.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
  }, SLOW);

  it("the cap keeps blocking contacts first, then unread ones, then allowed ones", () => {
    const c = (from, extra) => ({ from, to: from + 1, a: "a", b: "b", at: null, driver: "v", ...extra });
    const allowed = Array.from({ length: 30 }, (_, i) => c(i * 10, { depth: 0, allowed: true }));
    const blocking = [c(5, { depth: 1, allowed: false }), c(305, { depth: 1, allowed: false })];
    const unread = [c(400, { depth: null, depthUnread: true })];
    const row = { name: "t", clearance: 0, clear: null, skipped: "timeout", contacts: [...allowed.slice(0, 1), blocking[0], ...allowed.slice(1), blocking[1], ...unread] };
    const capped = capContacts(row);
    expect(capped.contacts).toEqual([...blocking, ...unread, ...allowed.slice(0, SWEEP_MAX_CONTACTS - 3)]);
    expect(capped.contactsOmitted).toBe(33 - SWEEP_MAX_CONTACTS);
    expect(capped.clear).toBeNull();
    // within the cap the row is unchanged, order and all
    const small = { ...row, contacts: row.contacts.slice(0, 5) };
    expect(capContacts(small)).toBe(small);
    // a positive clearance: every contact blocks, kept in order
    const pos = { name: "p", clearance: 1, clear: false, contacts: allowed.concat(allowed).map(({ allowed: _a, ...x }) => x) };
    expect(capContacts(pos).contacts).toEqual(pos.contacts.slice(0, SWEEP_MAX_CONTACTS));
    expect(capContacts(pos).contactsOmitted).toBe(60 - SWEEP_MAX_CONTACTS);
  });

  it("a dig between two butting knuckles that touch all the way round is found", () => {
    // knuckles end to end with no axial gap touch at every angle; a thin lid arm passes
    // through a 0.6 mm post on the base around 30°. Sampled at a few points the long
    // touching interval read as an allowed rub; read along it, the dig is a contact.
    const [row] = runSweeps(k, buttingKnuckles(), "assembly", { open: 0 });
    expect(row.clear).toBe(false);
    const blocking = row.contacts.filter((c) => !c.allowed);
    expect(blocking).toHaveLength(1);
    const [c] = blocking;
    expect(c.from).toBeGreaterThan(27.5);
    expect(c.from).toBeLessThan(28.2);
    expect(c.to).toBeGreaterThan(31.8);
    expect(c.to).toBeLessThan(32.5);
    expect(c.depth).toBeGreaterThan(0.25);
    expect(c.depth).toBeLessThan(0.35);
    expect(row.freeRange[1]).toBeLessThanOrEqual(c.from);
    // without the post the knuckles' touch is allowed all the way
    const [plain] = runSweeps(k, buttingKnuckles(false), "assembly", { open: 0 });
    expect(plain.clear).toBe(true);
    expect(plain.freeRange).toEqual([0, 110]);
  }, SLOW);

  it("a positive clearance's depth never changes its row", () => {
    // the deadline expires during the depth readings: the row is today's, depth left off
    const part = withSweeps(collideBar, { swing: { param: "angle", range: [0, 90] } });
    const [full] = runSweeps(k, part, "assembly", { angle: 0 });
    let ticks = 0;
    const [cut] = runSweeps(k, part, "assembly", { angle: 0 }, { deadline: full.steps + 2, now: () => ticks++ });
    const { ms: _a, ...cutRow } = cut;
    const { ms: _b, ...fullRow } = full;
    expect(fullRow.contacts[0].depth).toBeGreaterThan(1);
    expect(cutRow).toEqual({ ...fullRow, contacts: fullRow.contacts.map(({ depth: _d, ...c }) => c) });
    expect("depth" in cut.contacts[0]).toBe(false);
  }, SLOW);
});

describe("readSweep clearance", () => {
  const part = withSweeps(collideBar, {});
  const clearanceOf = (spec) => readSweep(part, "swing", { param: "angle", ...spec }, {}, 0.05).entries[0].clearance;
  it("keeps any finite clearance, zero and below included", () => {
    expect(clearanceOf({ clearance: -0.3 })).toBe(-0.3);
    expect(clearanceOf({ clearance: 0 })).toBe(0);
    expect(clearanceOf({ clearance: 0.2 })).toBe(0.2);
  });
  it("falls back to the declared default for a clearance that is no number", () => {
    for (const clearance of [NaN, "x", Infinity, -Infinity, null]) expect(clearanceOf({ clearance })).toBe(0.05);
    expect(clearanceOf({})).toBe(0.05);
  });
});

// The reference parts' declared sweeps, recorded before clearance went below 0: every one
// of them reads clear, so nothing about them may move (a contact would only gain `depth`).
describe("reference parts' sweep rows", () => {
  const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/sweep-rows-golden.json", import.meta.url), "utf8"));
  const parts = { gearbox, "drawer-box": drawerBox, hand };
  it("are unchanged", () => {
    for (const [key, rows] of Object.entries(GOLDEN)) {
      const [file, view] = key.split("#");
      const part = parts[file];
      expect(strip(runSweeps(k, part, view, part.defaults)), key).toEqual(rows);
    }
  }, SLOW);
});

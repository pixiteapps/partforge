// The sweep engine (spec "Sweeps"): a declared motion stepped end to end for contact,
// with the first contact, the param that drives it and the free range around the
// current value. Real parts built by Manifold; the bar fixtures are plain boxes.
import { beforeAll, describe, expect, it } from "vitest";
import drawerBox from "../src/parts/drawer-box.js";
import hand from "../src/parts/hand.js";
import gearbox from "../src/parts/gearbox.js";
import { bootManifoldKernel } from "../src/testing.js";
import { runSweeps, normalizeSweeps, SWEEP_REBUILD_STEPS, SWEEP_MAX_STEPS } from "../src/framework/oracle/sweep.js";
import { presetMap } from "../src/framework/oracle/cases.js";
import { buildView } from "../src/framework/oracle/build.js";
import { createCollisionWorld, relativeMatsAt } from "../src/framework/collide/world.js";
import { resolveParams } from "../src/framework/part-model.js";
import { collideBar, collideBarTwo } from "./fixtures/collide-bar.js";

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
    // crank's real touches — its hub sits on gear1's axle top, flush (distance 0), and its
    // knob arm passes flush over gear2's tooth tips (both faces at z = 15).
    const meshing = ["gear1×gear2", "gear2×gear3", "crank×gear1"];
    const part = withSweeps(gearbox, { spin: { animation: "spin" } }, { collisions: { allow: meshing } });
    const [row] = runSweeps(k, part, "gearbox", gearbox.defaults);
    expect(row.name).toBe("spin");
    expect(row.rebuilds).toBe(false);
    expect(row.steps).toBeGreaterThan(1);
    expect(row.clear).toBe(false);
    expect([...new Set(row.contacts.map((c) => `${c.a}×${c.b}`))].sort()).toEqual(["gear2×crank", "plate×crank"]);
    const pass = row.contacts.find((c) => c.b === "crank" && c.a === "gear2" && c.from > 0);
    expect(pass.driver).toBe("driveAngle");

    // With the crank's resting touches allowed too, the spin is clear.
    const allowAll = withSweeps(gearbox, { spin: { animation: "spin" } }, { collisions: { allow: [...meshing, "plate×crank", "gear2×crank"] } });
    const [clear] = runSweeps(k, allowAll, "gearbox", gearbox.defaults);
    expect(clear.clear).toBe(true);
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

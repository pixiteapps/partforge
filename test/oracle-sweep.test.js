// The sweep engine (spec "Sweeps"): a declared motion stepped end to end for contact,
// with the first contact, the param that drives it and the free range around the
// current value. Real parts built by Manifold; the bar fixtures are plain boxes.
import { beforeAll, describe, expect, it } from "vitest";
import drawerBox from "../src/parts/drawer-box.js";
import hand from "../src/parts/hand.js";
import gearbox from "../src/parts/gearbox.js";
import { bootManifoldKernel } from "../src/testing.js";
import { runSweeps, normalizeSweeps, SWEEP_REBUILD_STEPS, SWEEP_MAX_STEPS } from "../src/framework/oracle/sweep.js";
import { collideBar, collideBarTwo } from "./fixtures/collide-bar.js";

const SLOW = 120_000;
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const withSweeps = (part, sweeps, extra = {}) => ({ ...part, ...extra, verify: { ...part.verify, sweeps } });
const timed = (label, fn) => {
  const t = performance.now();
  const out = fn();
  console.log(`[sweep timing] ${label}: ${(performance.now() - t).toFixed(0)} ms`);
  return out;
};

describe("sweep engine", () => {
  it("exports its step caps", () => {
    expect(SWEEP_REBUILD_STEPS).toBe(24);
    expect(SWEEP_MAX_STEPS).toBe(2000);
  });

  it("drawer travel is clear", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1" } });
    const rows = timed("drawer d1", () => runSweeps(k, part, "cabinet", part.defaults));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    console.log("[sweep] drawer d1", JSON.stringify({ steps: row.steps, min: row.minClearance }));
    expect(row.name).toBe("d1.drawer1Open");
    expect(row.clear).toBe(true);
    expect(row.rebuilds).toBe(false);
    expect(row.minClearance.distance).toBeGreaterThan(0.95);
    expect(row.minClearance.distance).toBeLessThan(1.05);
    expect(row.freeRange).toEqual([0, 100]);
  }, SLOW);

  it("rotation finds first contact", () => {
    const part = withSweeps(collideBar, { swing: { param: "angle", range: [0, 90] } });
    const [row] = timed("bar swing", () => runSweeps(k, part, "assembly", { angle: 0 }));
    console.log("[sweep] bar", JSON.stringify({ steps: row.steps, contacts: row.contacts, freeRange: row.freeRange }));
    expect(row.clear).toBe(false);
    expect(Math.abs(row.contacts[0].from - 60)).toBeLessThan(0.1);
    expect(row.contacts[0].driver).toBe("angle");
    expect(row.contacts[0].to).toBe(90);
    expect(row.freeRange[0]).toBe(0);
    expect(Math.abs(row.freeRange[1] - 60)).toBeLessThan(0.1);
  }, SLOW);

  it("a clearance requirement fails a close pass", () => {
    const part = withSweeps(drawerBox, { d1: { handle: "drawer1", clearance: 2 } });
    const [row] = timed("drawer d1 clearance 2", () => runSweeps(k, part, "cabinet", part.defaults));
    expect(row.clearance).toBe(2);
    expect(row.clear).toBe(false);
    expect(row.contacts.some((c) => c.a === "carcass" && c.b === "drawer1")).toBe(true);
    // only pairs with a moving piece: drawer2 sits just as close, but never moves here
    expect(row.contacts.every((c) => c.a === "drawer1" || c.b === "drawer1")).toBe(true);
  }, SLOW);

  it("path sweep between presets", () => {
    const part = withSweeps(hand, { fist: { from: "open", to: "fist", clearance: 0.3 } });
    const rows = timed("hand open→fist", () => runSweeps(k, part, "assembly", hand.defaults));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    console.log("[sweep] hand fist", JSON.stringify({ steps: row.steps, clear: row.clear, min: row.minClearance, contacts: row.contacts }));
    expect(row.steps).toBeGreaterThan(1);
    expect(row.rebuilds).toBe(false);
    expect(row.minClearance.value).toBeGreaterThanOrEqual(0);
    expect(row.minClearance.value).toBeLessThanOrEqual(1);
    for (const c of row.contacts) {
      for (const v of [c.from, c.to]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
    expect(row.freeRange).toBeNull(); // a path has no single param to range
  }, SLOW);

  it("coupled driver", () => {
    // a slides the bar along the slab, b swings it down: only b closes the pair
    const part = withSweeps(collideBarTwo, { both: { path: [{ a: 0, b: 0 }, { a: 20, b: 90 }] } });
    const [row] = timed("bar two path", () => runSweeps(k, part, "assembly", {}));
    console.log("[sweep] bar two", JSON.stringify(row.contacts));
    expect(row.clear).toBe(false);
    expect(Math.abs(row.contacts[0].from - 60 / 90)).toBeLessThan(2e-3);
    expect(row.contacts[0].driver).toBe("b");
  }, SLOW);

  it("shape-changing sweep rebuilds", () => {
    const part = withSweeps(drawerBox, { width: { param: "width" } });
    const [row] = timed("drawer width", () => runSweeps(k, part, "cabinet", part.defaults));
    console.log("[sweep] drawer width", JSON.stringify({ steps: row.steps, clear: row.clear, min: row.minClearance }));
    expect(row.rebuilds).toBe(true);
    expect(row.steps).toBeLessThanOrEqual(24);
    expect(row.steps).toBeGreaterThan(1);
    expect(row.clear).toBe(true);
  }, SLOW);

  it("animation sweep", () => {
    // The meshing pairs (and the crank keyed to its gear) allowed: the spin still finds the
    // crank's real touches — its hub sits on gear1's axle top, flush (distance 0), and its
    // knob arm passes flush over gear2's tooth tips (both faces at z = 15).
    const meshing = ["gear1×gear2", "gear2×gear3", "crank×gear1"];
    const part = withSweeps(gearbox, { spin: { animation: "spin" } }, { collisions: { allow: meshing } });
    const [row] = timed("gearbox spin", () => runSweeps(k, part, "gearbox", gearbox.defaults));
    console.log("[sweep] gearbox", JSON.stringify({ steps: row.steps, clear: row.clear, min: row.minClearance, contacts: row.contacts }));
    expect(row.name).toBe("spin");
    expect(row.rebuilds).toBe(false);
    expect(row.steps).toBeGreaterThan(1);
    expect(row.clear).toBe(false);
    expect([...new Set(row.contacts.map((c) => `${c.a}×${c.b}`))].sort()).toEqual(["gear2×crank", "plate×crank"]);
    const pass = row.contacts.find((c) => c.b === "crank" && c.a === "gear2" && c.from > 0);
    expect(pass.driver).toBe("driveAngle");

    // With the crank's resting touches allowed too, the spin is clear.
    const allowAll = withSweeps(gearbox, { spin: { animation: "spin" } }, { collisions: { allow: [...meshing, "plate×crank", "gear2×crank"] } });
    const [clear] = timed("gearbox spin, crank touches allowed", () => runSweeps(k, allowAll, "gearbox", gearbox.defaults));
    console.log("[sweep] gearbox allowed", JSON.stringify({ steps: clear.steps, min: clear.minClearance }));
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
      spin: { animation: "spin" },
    });
    const rows = runSweeps(k, part, "gearbox", gearbox.defaults);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.nope.skipped).toBe("unreadable");
    expect(by.ghost.skipped).toBe("unreadable");
    expect(by.gone.skipped).toBe("unreadable");
    expect(by.spin.skipped).toBe("no-motion");
    for (const r of rows) expect(r.clear).toBeNull();
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

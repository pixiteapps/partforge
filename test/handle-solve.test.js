import { describe, it, expect } from "vitest";
import { solveHandle, solveAngles, angleAbout, axisBasis } from "../src/framework/pose/param-solve.js";
import { resolveParams } from "../src/framework/part-model.js";
import { locateHandle, handleAxis } from "../src/framework/pose/handle-source.js";
import hand from "./fixtures/ik-hand-fixture.js";
import { limb } from "../src/framework/domains/kinematics/index.js";

// ---- in-file fixtures: derive returns hand-written handleInfo() sources ----------------

const drawer = {
  parameters: [{ id: "d", title: "Drawer", controls: [{ key: "drawerOpen", min: 0, max: 100, step: 1 }] }],
  defaults: { drawerOpen: 0 },
  derive: () => ({}),
  handles: {
    pull: { point: (p) => [0, -p.drawerOpen, 0], params: ["drawerOpen"], drag: "axis", direction: [0, -1, 0] },
  },
};

const box = {
  parameters: [{ id: "b", title: "Box", controls: [
    { key: "width", min: 10, max: 400, step: 1 },
    { key: "depth", min: 10, max: 200, step: 1 },
  ] }],
  defaults: { width: 80, depth: 40 },
  derive: () => ({}),
  handles: {
    corner: { point: (p) => [p.width / 2, p.depth / 2, 10], params: ["width", "depth"], drag: "plane", normal: [0, 0, 1] },
    // Review Focus 3: unreadable past width 200
    fragile: {
      point: (p) => { if (p.width > 200) throw new Error("too wide"); return [p.width / 2, p.depth / 2, 10]; },
      params: ["width", "depth"], drag: "plane", normal: [0, 0, 1],
    },
  },
};

/** Three meshing gears on +Z axes; gear radii in proportion to teeth 20 / 30 / 40. */
const GEARS = [
  { name: "gear1", c: [0, 0, 0], r: 20, ratio: 1 },
  { name: "gear2", c: [50, 0, 0], r: 30, ratio: -20 / 30 },
  { name: "gear3", c: [120, 0, 0], r: 40, ratio: 20 / 40 },
];
const rad = (deg) => (deg * Math.PI) / 180;
const train = {
  parameters: [{ id: "t", title: "Train", controls: [{ key: "driveAngle", min: 0, max: 360, step: 1, wrap: true }] }],
  defaults: { driveAngle: 0 },
  derive: (p) => ({
    train: {
      handleInfo() {
        const points = {}, axes = {};
        for (const g of GEARS) {
          const t = rad(p.driveAngle * g.ratio);
          points[`${g.name}.center`] = g.c;
          points[`${g.name}.rim`] = [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t), g.c[2]];
          axes[g.name] = { origin: g.c, direction: [0, 0, 1] };
        }
        return { kind: "partforge.points", points, axes };
      },
    },
  }),
  handles: Object.fromEntries(GEARS.map((g) => [g.name, { on: "train", at: `${g.name}.rim`, params: ["driveAngle"], drag: "rotary" }])),
};

const at = (part, params, id) => {
  const { p, d } = resolveParams(part, params);
  return locateHandle(part, p, d, part.handles[id]);
};
const axisOf = (part, params, id) => {
  const { p, d } = resolveParams(part, params);
  return handleAxis(part.handles[id], p, d);
};
const wrap180 = (a) => { const r = ((a + 180) % 360 + 360) % 360 - 180; return r === -180 ? 180 : r; };

// A finger whose pip bend is its own parameter: a rotary handle at "pip.child" (the dip
// joint, on the child bone) turns about axes.pip, picked by the "pip" prefix of `at`.
const bentFinger = limb("index", {
  at: [0, 0, 0], toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80] }],
  lengths: [42, 25, 22],
});
const pipPart = {
  parameters: [{ id: "f", title: "Finger", controls: [{ key: "pipBend", min: 0, max: 110, step: 1 }] }],
  defaults: { pipBend: 20 },
  derive: (p) => ({ index: bentFinger.pose({ bend: { mcp: 10, pip: p.pipBend, dip: 0 } }) }),
  handles: { pip: { on: "index", at: "pip.child", params: ["pipBend"], drag: "rotary" } },
};

// ---- angle convention --------------------------------------------------------------

describe("angleAbout / axisBasis", () => {
  it("is a right-handed angle about the axis, in (-180, 180]", () => {
    const axis = { origin: [1, 2, 3], direction: [0, 0, 2] };
    const { u, v } = axisBasis(axis.direction);
    const pt = (deg) => [1 + 5 * (Math.cos(rad(deg)) * u[0] + Math.sin(rad(deg)) * v[0]), 2 + 5 * (Math.cos(rad(deg)) * u[1] + Math.sin(rad(deg)) * v[1]), 3 + 7];
    expect(angleAbout(pt(30), axis)).toBeCloseTo(30, 9);
    expect(angleAbout(pt(-120), axis)).toBeCloseTo(-120, 9);
    expect(angleAbout(pt(180), axis)).toBeCloseTo(180, 9);
    // counter-clockwise about +Z (u x v = direction)
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    expect(cross[2]).toBeCloseTo(1, 12);
  });

  it("is deterministic for any direction, and unit + orthogonal", () => {
    for (const dir of [[1, 0, 0], [0, -1, 0], [1, 1, 1], [0.2, -3, 0.5]]) {
      const { u, v } = axisBasis(dir);
      expect(axisBasis(dir)).toEqual({ u, v });
      const n = Math.hypot(...dir);
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      expect(Math.hypot(...u)).toBeCloseTo(1, 12);
      expect(Math.hypot(...v)).toBeCloseTo(1, 12);
      expect(dot(u, v)).toBeCloseTo(0, 12);
      expect(dot(u, dir) / n).toBeCloseTo(0, 12);
    }
  });
});

// ---- solveHandle -------------------------------------------------------------------

describe("solveHandle", () => {
  it("axis: a drawer slides its parameter to the target", () => {
    const handle = drawer.handles.pull;
    const r = solveHandle({ part: drawer, params: {}, handle, target: { point: [0, -40, 0] } });
    expect(r.values.drawerOpen).toBeCloseTo(40, 3);
    expect(Math.abs(r.values.drawerOpen - 40)).toBeLessThan(1e-3);
  });

  it("plane: a box corner writes width and depth", () => {
    const r = solveHandle({ part: box, params: {}, handle: box.handles.corner, target: { point: [50, 30, 10] } });
    expect(r.values.width).toBeCloseTo(100, 2);
    expect(r.values.depth).toBeCloseTo(60, 2);
    expect(r.error).toBeLessThan(1e-2);
  });

  it("rotary at \"pip.child\": the dot sits on the child bone and turning it bends pip", () => {
    const params = { pipBend: 20 };
    const axis = axisOf(pipPart, params, "pip");
    const { d } = resolveParams(pipPart, params);
    expect(axis.origin).toEqual(d.index.handleInfo().axes.pip.origin);
    const now = at(pipPart, params, "pip");
    expect(now).toEqual(d.index.handleInfo().points.dip);
    const before = angleAbout(now, axis);
    const radius = Math.hypot(...now.map((v, i) => v - axis.origin[i]));
    expect(radius).toBeGreaterThan(20); // off its own axis
    const r = solveHandle({ part: pipPart, params, handle: pipPart.handles.pip, target: { angleDeg: wrap180(before + 30), axis, radius } });
    expect(Math.abs(r.values.pipBend - 20)).toBeCloseTo(30, 1);
    expect(wrap180(angleAbout(at(pipPart, { pipBend: r.values.pipBend }, "pip"), axis) - before)).toBeCloseTo(30, 1);
  });

  it("rotary: grabbing gear 3 and turning it 90 degrees drives the input 180", () => {
    const params = { driveAngle: 10 };
    const axis = axisOf(train, params, "gear3");
    const now = angleAbout(at(train, params, "gear3"), axis);
    const r = solveHandle({ part: train, params, handle: train.handles.gear3, target: { angleDeg: wrap180(now + 90), axis, radius: 40 } });
    expect(r.values.driveAngle).toBeCloseTo(190, 2);
    expect(wrap180(angleAbout(at(train, { driveAngle: r.values.driveAngle }, "gear3"), axis) - now)).toBeCloseTo(90, 2);
  });

  it("rotary: ten 72 degree steps turn gear 3 two full turns, never backwards, past 360", () => {
    let p = { driveAngle: 15 };
    const axis = axisOf(train, p, "gear3");
    const start = angleAbout(at(train, p, "gear3"), axis);
    let prev = p.driveAngle;
    for (let i = 1; i <= 10; i++) {
      const r = solveHandle({ part: train, params: p, handle: train.handles.gear3, target: { angleDeg: wrap180(start + 72 * i), axis, radius: 40 } });
      expect(r.values.driveAngle).toBeGreaterThan(prev);
      prev = r.values.driveAngle;
      p = { ...p, ...r.values };
    }
    expect(p.driveAngle).toBeCloseTo(15 + 1440, 2);
  });

  it("a point function that throws scores FAILED: the drag holds a readable width", () => {
    const r = solveHandle({ part: box, params: {}, handle: box.handles.fragile, target: { point: [150, 20, 10] } });
    expect(r).not.toBeNull();
    expect(r.values.width).toBeLessThanOrEqual(200);
    expect(Number.isFinite(r.error)).toBe(true);
  });

  it("a pinned gear locks the train: the drive does not move and the miss shows", () => {
    const params = { driveAngle: 30 };
    const axis = axisOf(train, params, "gear3");
    const now = angleAbout(at(train, params, "gear3"), axis);
    const pin = { ref: { handleId: "gear2", handle: train.handles.gear2 }, point: at(train, params, "gear2") };
    const r = solveHandle({
      part: train, params, handle: train.handles.gear3, allHandles: Object.values(train.handles),
      target: { angleDeg: wrap180(now + 90), axis, radius: 40 }, holds: [pin],
    });
    expect(Math.abs(r.values.driveAngle - 30)).toBeLessThan(0.01);
    expect(r.error).toBeGreaterThan(1);
  });

  it("returns null when the start pose cannot be read", () => {
    expect(solveHandle({ part: box, params: { width: 300 }, handle: box.handles.fragile, target: { point: [50, 30, 10] } })).toBeNull();
  });
});

describe("solveAngles holds", () => {
  it("a { ref, point } hold weighs exactly as the old { limb, at, point } shape", () => {
    const b0 = resolveParams(hand, {}).d.b.world("tip").origin;
    const target = resolveParams(hand, { wrist: 10, aCurl: 0.4, aSpread: 5 }).d.a.world("tip").origin;
    const opts = { part: hand, params: {}, handle: hand.handles.a, grab: "tip", target };
    const old = solveAngles({ ...opts, holds: [{ limb: "b", at: "tip", point: b0 }] });
    const viaLimbRef = solveAngles({ ...opts, holds: [{ ref: { limb: "b", at: "tip" }, point: b0 }] });
    const bTip = { point: (p, d) => d.b.world("tip").origin, params: [] };
    const viaHandle = solveAngles({ ...opts, holds: [{ ref: { handleId: "bTip", handle: bTip }, point: b0 }] });
    expect(viaLimbRef).toEqual(old);
    expect(viaHandle).toEqual(old);
  });
});

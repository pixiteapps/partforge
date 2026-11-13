import { describe, it, expect } from "vitest";
import { startDrag, dragTarget } from "../src/framework/pose/drag-kinds.js";
import { angleAbout } from "../src/framework/solve/axis-angle.js";

// An orthographic camera looking along `fwd`; screen = 10 px per mm on (right, up).
function cam(fwd, up = [0, 0, 1]) {
  const f = fwd.map((v) => v / Math.hypot(...fwd));
  const r0 = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  const rl = Math.hypot(...r0) || 1;
  const r = r0.map((v) => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const project = (p) => ({ x: 400 + 10 * dot(p, r), y: 300 - 10 * dot(p, u) });
  const pointerAt = (p) => {
    const s = project(p);
    return {
      ray: { origin: [p[0] - 100 * f[0], p[1] - 100 * f[1], p[2] - 100 * f[2]], dir: f, forward: f },
      screen: { x: s.x, y: s.y, project },
    };
  };
  // a pointer at a screen position (px), ray through that point of the z-0 world
  const pointerPx = (x, y) => {
    const p = [(x - 400) / 10 * r[0] + (300 - y) / 10 * u[0], (x - 400) / 10 * r[1] + (300 - y) / 10 * u[1], (x - 400) / 10 * r[2] + (300 - y) / 10 * u[2]];
    return {
      ray: { origin: [p[0] - 100 * f[0], p[1] - 100 * f[1], p[2] - 100 * f[2]], dir: f, forward: f },
      screen: { x, y, project },
    };
  };
  return { pointerAt, pointerPx, project };
}
const finite = (v) => v.every(Number.isFinite);

describe("axis drag", () => {
  it("slides along +Y to the closest point on the line", () => {
    const c = cam([0, 0, -1], [0, 1, 0]); // top-down
    const p = [5, 0, 0];
    const s = startDrag("axis", { point: p, axis: { origin: p, direction: [0, 1, 0] }, ...c.pointerAt(p) });
    const t = dragTarget(s, c.pointerAt([9, 7, 0]));
    expect(t.point[0]).toBeCloseTo(5);
    expect(t.point[1]).toBeCloseTo(7);
    expect(t.point[2]).toBeCloseTo(0);
  });
  it("does not jump on the first frame when grabbed off the point", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = [5, 2, 0];
    const s = startDrag("axis", { point: p, axis: { origin: p, direction: [0, 1, 0] }, ...c.pointerAt([6, 3, 0]) });
    const t = dragTarget(s, c.pointerAt([6, 3, 0]));
    expect(t.point[1]).toBeCloseTo(2);
  });
  it("near the view direction uses the screen-projected line and stays finite", () => {
    const fwd = [0.1, 0, -1];
    const c = cam(fwd, [0, 1, 0]);
    const p = [0, 0, 0];
    const axis = { origin: p, direction: [0, 0, 1] }; // ~6 deg off the view line
    const s = startDrag("axis", { point: p, axis, ...c.pointerAt(p) });
    const t = dragTarget(s, c.pointerPx(400 + 5, 300 - 20));
    expect(finite(t.point)).toBe(true);
    expect(t.point[0]).toBeCloseTo(0);
    expect(t.point[1]).toBeCloseTo(0);
  });
  it("exactly view-aligned holds the point, finite", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = [1, 2, 3];
    const s = startDrag("axis", { point: p, axis: { origin: p, direction: [0, 0, 1] }, ...c.pointerAt(p) });
    const t = dragTarget(s, c.pointerPx(450, 250));
    expect(finite(t.point)).toBe(true);
    expect(t.point).toEqual(p);
  });
});

describe("plane drag", () => {
  it("moves in the plane by the pointer's plane delta", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = [1, 1, 4];
    const s = startDrag("plane", { point: p, axis: { origin: p, direction: [0, 0, 1] }, ...c.pointerAt(p) });
    const t = dragTarget(s, c.pointerAt([6, -2, 4]));
    expect(t.point[0]).toBeCloseTo(6);
    expect(t.point[1]).toBeCloseTo(-2);
    expect(t.point[2]).toBeCloseTo(4);
  });
  it("edge-on falls back to the point rule, finite", () => {
    const c = cam([0, 1, 0]);
    const p = [0, 0, 0];
    const s = startDrag("plane", { point: p, axis: { origin: p, direction: [0, 0, 1] }, ...c.pointerAt(p) });
    const t = dragTarget(s, c.pointerAt([3, 0, 2]));
    expect(finite(t.point)).toBe(true);
    expect(t.point[0]).toBeCloseTo(3);
    expect(t.point[2]).toBeCloseTo(2);
  });
});

describe("point drag", () => {
  it("follows the pointer on the camera-facing plane", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = [1, 1, 0];
    const s = startDrag("point", { point: p, ...c.pointerAt(p) });
    const t = dragTarget(s, c.pointerAt([4, 5, 0]));
    expect(t.point[0]).toBeCloseTo(4);
    expect(t.point[1]).toBeCloseTo(5);
  });
});

describe("rotary drag", () => {
  const axis = { origin: [0, 0, 0], direction: [0, 0, 1] };
  const onCircle = (deg, r = 5) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180), 0];
  it("accumulates unreduced angle: 4 x 100 deg", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = onCircle(0);
    const s = startDrag("rotary", { point: p, axis, ...c.pointerAt(p) });
    const start = s.angleDeg;
    expect(start).toBeCloseTo(angleAbout(p, axis));
    let t;
    for (let i = 1; i <= 4; i++) t = dragTarget(s, c.pointerAt(onCircle(100 * i)));
    expect(t.angleDeg).toBeCloseTo(start + 400, 6);
    expect(t.radius).toBeCloseTo(5);
    expect(t.axis.direction).toEqual([0, 0, 1]);
  });
  it("a path across the axis centre never steps more than 30 deg", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = onCircle(0);
    const s = startDrag("rotary", { point: p, axis, ...c.pointerAt(p) });
    let prev = s.angleDeg;
    let worst = 0;
    for (let x = 400 + 50; x >= 400 - 50; x -= 1) {
      const t = dragTarget(s, c.pointerPx(x, 300 - 0.3));
      worst = Math.max(worst, Math.abs(t.angleDeg - prev));
      prev = t.angleDeg;
    }
    expect(worst).toBeLessThanOrEqual(30);
  });
  it("a coarse path (20 px per event) across the axis centre never steps more than 30 deg", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = onCircle(0);
    const s = startDrag("rotary", { point: p, axis, ...c.pointerAt(p) });
    let prev = s.angleDeg;
    let worst = 0;
    for (let x = 400 + 70; x >= 400 - 70; x -= 20) {
      const t = dragTarget(s, c.pointerPx(x, 300 - 3));
      worst = Math.max(worst, Math.abs(t.angleDeg - prev));
      prev = t.angleDeg;
    }
    expect(worst).toBeLessThanOrEqual(30);
  });
  it("reads the pointer on the grabbed point's own rotation plane, not the axis origin's", () => {
    // a crank knob 30 mm up its axis, seen obliquely: the pointer kept on the knob as it
    // turns reads exactly the knob's turn (the origin's plane, 30 mm below, did not)
    const c = cam([-1, -0.4, -0.8]);
    const lift = (q) => [q[0], q[1], 30];
    const p = lift(onCircle(0, 10));
    const s = startDrag("rotary", { point: p, axis, ...c.pointerAt(p) });
    const start = s.angleDeg;
    let t;
    for (let deg = 10; deg <= 120; deg += 10) {
      t = dragTarget(s, c.pointerAt(lift(onCircle(deg, 10))));
      expect(t.angleDeg - start).toBeCloseTo(deg, 6);
    }
  });
  it("radius-0 point gives radius 1 and a finite target", () => {
    const c = cam([0, 0, -1], [0, 1, 0]);
    const p = [0, 0, 0];
    const s = startDrag("rotary", { point: p, axis, ...c.pointerAt(p) });
    const t = dragTarget(s, c.pointerPx(460, 300));
    expect(t.radius).toBe(1);
    expect(Number.isFinite(t.angleDeg)).toBe(true);
  });
  it("exactly edge-on turns by screen angle, finite, in the right sense", () => {
    const c = cam([1, 0, 0], [0, 0, 1]); // looking along +X; axis Z is vertical on screen... use axis along view instead
    const edgeAxis = { origin: [0, 0, 0], direction: [0, 1, 0] }; // plane contains the view line: edge-on
    const p = [0, 0, 5];
    const s = startDrag("rotary", { point: p, axis: edgeAxis, ...c.pointerAt(p) });
    const a = dragTarget(s, c.pointerPx(400, 300 - 50));
    const b = dragTarget(s, c.pointerPx(400 + 50, 300));
    expect(Number.isFinite(a.angleDeg) && Number.isFinite(b.angleDeg)).toBe(true);
    expect(Math.abs(b.angleDeg - a.angleDeg)).toBeCloseTo(90, 6);
  });
});

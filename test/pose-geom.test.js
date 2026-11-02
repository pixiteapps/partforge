import { describe, it, expect } from "vitest";
import { dragPlaneNormal, dragPlanePoint, hitHandle, limitArc, ALONG_VIEW_LIMIT } from "../src/framework/pose/pose-geom.js";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe("dragPlanePoint", () => {
  it("intersects the plane for a ray facing it", () => {
    const p = dragPlanePoint([0, 0, 10], [0, 0, -1], [0, 0, 0], [0, 0, 1], 100);
    expect(p[0]).toBeCloseTo(0); expect(p[1]).toBeCloseTo(0); expect(p[2]).toBeCloseTo(0);
  });
  it("returns a finite point within maxDist for a grazing ray", () => {
    const p = dragPlanePoint([0, 0, 0.001], [1, 0, -1e-6], [0, 0, 0], [0, 0, 1], 50);
    expect(p.every(Number.isFinite)).toBe(true);
    expect(dist(p, [0, 0, 0])).toBeLessThanOrEqual(50 + 1e-9);
  });
  it("clamps a far intersection to maxDist", () => {
    const p = dragPlanePoint([0, 0, 10], [1, 0, -0.1], [0, 0, 0], [0, 0, 1], 20);
    expect(dist(p, [0, 0, 0])).toBeCloseTo(20);
  });
  it("falls back when the plane is behind the ray", () => {
    const p = dragPlanePoint([0, 0, 10], [0, 0, 1], [0, 0, 0], [0, 0, 1], 30);
    expect(p.every(Number.isFinite)).toBe(true);
    expect(dist(p, [0, 0, 0])).toBeLessThanOrEqual(30 + 1e-9);
  });
});

describe("dragPlaneNormal", () => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const deg = (d) => (d * Math.PI) / 180;
  // The camera looks down -Z; the limb leans `off` degrees off the line of sight, toward
  // the camera, in the XZ plane.
  const toward = (off) => [Math.sin(deg(off)), 0, Math.cos(deg(off))];

  it("seen from the side, it is the camera-facing plane", () => {
    expect(dragPlaneNormal([0, 0, -1], [1, 0, 0])).toEqual([0, 0, -1]);
    const n = dragPlaneNormal([0, 0, -1], [0.6, 0.8, 0]);
    expect(dist(n, [0, 0, -1])).toBeLessThan(1e-12);
  });

  it("holds the limb, and faces the camera as squarely as a plane holding it can", () => {
    const d = toward(30);
    const n = dragPlaneNormal([0, 0, -1], d);
    expect(dot(n, d)).toBeCloseTo(0, 12);
    // the most camera-facing such plane: its normal is the view less its share along d
    expect(Math.abs(dot(n, [0, 0, -1]))).toBeCloseTo(Math.sin(deg(30)), 12);
    expect(n[1]).toBeCloseTo(0, 12);
  });

  it("end-on: a pull along the limb's screen line moves the point along the limb, not across it", () => {
    // The limb leans 30° off the line of sight; its screen line is +X. An orthographic
    // cursor ray moved 10 mm along +X lands on the limb, 20 mm out (10 / sin 30°).
    const d = toward(30), grab = [0, 0, 0];
    const at = (x) => dragPlanePoint([x, 0, 100], [0, 0, -1], grab, dragPlaneNormal([0, 0, -1], d), 1000);
    const moved = at(10);
    expect(dot(moved, d) / Math.hypot(...moved)).toBeCloseTo(1, 9);
    expect(dot(moved, d)).toBeCloseTo(20, 9);
    // The camera-facing plane moved it 10 mm across the screen: only 5 mm along the limb.
    const flat = dragPlanePoint([10, 0, 100], [0, 0, -1], grab, [0, 0, -1], 1000);
    expect(dot(flat, d)).toBeCloseTo(5, 9);
  });

  for (const off of [25, 30]) {
    it(`perspective, ${off}° off the limb: sweeping the cursor through the plane's horizon never jumps the point`, () => {
      // An eye at the origin looking +Z; a finger 300 mm out, leaning `off` degrees off the
      // line of sight. The plane holding it is tilted, so its horizon is on screen: the
      // cursor's ray turns out past it (0.02° a step, a fraction of a pixel at 45° fov).
      const th = deg(off), d = [Math.sin(th), 0, Math.cos(th)];
      const tip = [d[0] * 90, 0, 300 + d[2] * 90];
      const n = dragPlaneNormal([0, 0, 1], d);
      const maxDist = 440;
      const from = Math.atan2(tip[0], tip[2]);
      let prev = null, worst = 0, last = null;
      for (let a = from; a <= deg(60); a += deg(0.02)) {
        last = dragPlanePoint([0, 0, 0], [Math.sin(a), 0, Math.cos(a)], tip, n, maxDist);
        if (prev) worst = Math.max(worst, dist(last, prev));
        prev = last;
      }
      expect(worst).toBeLessThan(3);
      // past the horizon it rests at the clamp, out along the limb's in-plane direction
      expect(dist(last, tip)).toBeCloseTo(maxDist, 6);
      expect(dot(sub3(last, tip), d) / maxDist).toBeGreaterThan(0.9);
    });
  }

  it("falls back to the camera-facing plane when the limb points nearly down the line of sight", () => {
    const limit = (Math.acos(ALONG_VIEW_LIMIT) * 180) / Math.PI; // ~18.2°
    expect(dragPlaneNormal([0, 0, -1], toward(limit - 1))).toEqual([0, 0, -1]);
    expect(dragPlaneNormal([0, 0, -1], toward(-5))).toEqual([0, 0, -1]);
    expect(dragPlaneNormal([0, 0, -1], toward(180))).toEqual([0, 0, -1]); // pointing away
    expect(dragPlaneNormal([0, 0, -1], toward(limit + 1))).not.toEqual([0, 0, -1]);
    // no direction to read (the base joint grabbed)
    expect(dragPlaneNormal([0, 0, -2], [0, 0, 0])).toEqual([0, 0, -1]);
  });
});

describe("hitHandle", () => {
  const pts = [{ id: "a", x: 100, y: 100 }, { id: "b", x: 108, y: 100 }];
  it("picks the nearest within the radius", () => {
    expect(hitHandle(pts, 106, 100)).toBe("b");
    expect(hitHandle(pts, 101, 100)).toBe("a");
  });
  it("returns null outside the radius", () => {
    expect(hitHandle(pts, 140, 100)).toBeNull();
    expect(hitHandle([], 0, 0)).toBeNull();
  });
  it("honours a custom radius", () => {
    expect(hitHandle(pts, 100, 120, 25)).toBe("a");
    expect(hitHandle(pts, 100, 120, 12)).toBeNull();
  });
});

describe("limitArc", () => {
  const ang = (pt, origin, axis, ref) => {
    const v = pt.map((c, i) => c - origin[i]);
    const b = [axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]];
    return Math.atan2(v[0] * b[0] + v[1] * b[1] + v[2] * b[2], v[0] * ref[0] + v[1] * ref[1] + v[2] * ref[2]) * 180 / Math.PI;
  };
  it("ends at lo and hi about the axis, at the radius", () => {
    const o = [1, 2, 3];
    const arc = limitArc(o, [0, 0, 1], [1, 0, 0], [-30, 90], 5, 16);
    expect(arc).toHaveLength(17);
    expect(ang(arc[0], o, [0, 0, 1], [1, 0, 0])).toBeCloseTo(-30);
    expect(ang(arc.at(-1), o, [0, 0, 1], [1, 0, 0])).toBeCloseTo(90);
    for (const p of arc) expect(dist(p, o)).toBeCloseTo(5);
  });
  it("projects refDir off the axis", () => {
    const arc = limitArc([0, 0, 0], [0, 0, 1], [1, 0, 1], [0, 0], 2, 4);
    expect(arc[0][0]).toBeCloseTo(2); expect(arc[0][2]).toBeCloseTo(0);
  });
});

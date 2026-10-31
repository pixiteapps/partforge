import { describe, it, expect } from "vitest";
import { dragPlanePoint, hitHandle, limitArc } from "../src/framework/pose/pose-geom.js";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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

// test/mesh-fillet-general-shading.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { surfaceNormal, mapSurface } from "../src/framework/geometry/blend-surfaces.js";
import { FIXTURES, GENUS } from "./fixtures/fillet-general-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const deg = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

describe("spine blend descriptor", () => {
  it("normal points from the nearest spine point, and survives mapping", () => {
    const d = { kind: "spine", pts: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: false, r: 1 };
    expect(deg(surfaceNormal(d, [5, 0, 2]), [0, 0, 1])).toBeLessThan(1e-9);
    expect(deg(surfaceNormal(d, [11, 5, 0]), [1, 0, 0])).toBeLessThan(1e-9);
    const moved = mapSurface(d, [1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 4, 5]); // translate by (3,4,5)
    expect(deg(surfaceNormal(moved, [8, 4, 7]), [0, 0, 1])).toBeLessThan(1e-9);
    expect(moved.r).toBeCloseTo(1, 12);
  });
  it("the tee's junction band shades with the analytic rolling-ball normal", () => {
    const r = 2, out = FIXTURES.tee(k)._filletRaw(r);
    const { positions, normals } = out.toMesh();
    // the ball touches tube (axis X, R=10) and boss (axis Z, R=5) from outside: its
    // centre lies at distance 10+r from X and 5+r from Z — sample that spine densely
    const spine = [];
    for (let i = 0; i < 7200; i++) {
      const ph = (2 * Math.PI * i) / 7200, x = (5 + r) * Math.cos(ph), y = (5 + r) * Math.sin(ph);
      spine.push([x, y, Math.sqrt((10 + r) ** 2 - y * y)]);
    }
    let checked = 0, worst = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const p = [positions[i], positions[i + 1], positions[i + 2]];
      const dTube = Math.hypot(p[1], p[2]), dBoss = Math.hypot(p[0], p[1]);
      // strictly inside the band: off both cylinders by more than 0.2 r, near the junction
      if (p[2] < 0 || dTube < 10 + 0.2 * r || dBoss < 5 + 0.2 * r || dTube > 10 + r || dBoss > 5 + r) continue;
      let best = Infinity, c = null;
      for (const s of spine) { const dd = (s[0] - p[0]) ** 2 + (s[1] - p[1]) ** 2 + (s[2] - p[2]) ** 2; if (dd < best) { best = dd; c = s; } }
      worst = Math.max(worst, deg([normals[i], normals[i + 1], normals[i + 2]], unit([p[0] - c[0], p[1] - c[1], p[2] - c[2]])));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(worst).toBeLessThan(2);
  });
  it("the cross hole's rim band shades with the analytic rolling-ball normal", () => {
    const r = 1.5, out = FIXTURES.crossHole(k)._filletRaw(r);
    const { positions, normals } = out.toMesh();
    // the ball touches hole (axis Z, R=3) and tube (axis X, R=10) from inside both:
    // its centre lies at distance 3+r from Z and 10−r from X (top rim, z > 0)
    const spine = [];
    for (let i = 0; i < 7200; i++) {
      const ph = (2 * Math.PI * i) / 7200, x = (3 + r) * Math.cos(ph), y = (3 + r) * Math.sin(ph);
      spine.push([x, y, Math.sqrt((10 - r) ** 2 - y * y)]);
    }
    let checked = 0, worst = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const p = [positions[i], positions[i + 1], positions[i + 2]];
      const dTube = Math.hypot(p[1], p[2]), dHole = Math.hypot(p[0], p[1]);
      if (p[2] < 0 || dTube > 10 - 0.2 * r || dHole < 3 + 0.2 * r || dTube < 10 - r || dHole > 3 + r) continue;
      let best = Infinity, c = null;
      for (const s of spine) { const dd = (s[0] - p[0]) ** 2 + (s[1] - p[1]) ** 2 + (s[2] - p[2]) ** 2; if (dd < best) { best = dd; c = s; } }
      worst = Math.max(worst, deg([normals[i], normals[i + 1], normals[i + 2]], unit([p[0] - c[0], p[1] - c[1], p[2] - c[2]])));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(worst).toBeLessThan(2.5);
  });
  it("draws no stray lines across the tee's and cross hole's bands", () => {
    const r = 1;
    const bandLen = (out, inBand) => {
      const { edges } = out.toMesh();
      let L = 0;
      for (let i = 0; i + 5 < edges.length; i += 6) {
        const m = [(edges[i] + edges[i + 3]) / 2, (edges[i + 1] + edges[i + 4]) / 2, (edges[i + 2] + edges[i + 5]) / 2];
        if (inBand(m)) L += Math.hypot(edges[i + 3] - edges[i], edges[i + 4] - edges[i + 1], edges[i + 5] - edges[i + 2]);
      }
      return L;
    };
    const tee = bandLen(FIXTURES.tee(k)._filletRaw(r), (m) => {
      const dT = Math.hypot(m[1], m[2]), dB = Math.hypot(m[0], m[1]);
      return m[2] > 0 && dT > 10 + 0.1 * r && dB > 5 + 0.1 * r && dT < 10 + 0.9 * r && dB < 5 + 0.9 * r;
    });
    const hole = bandLen(FIXTURES.crossHole(k)._filletRaw(r), (m) => {
      const dT = Math.hypot(m[1], m[2]), dH = Math.hypot(m[0], m[1]);
      return dT < 10 - 0.1 * r && dT > 10 - 0.9 * r && dH > 3 + 0.1 * r && dH < 3 + 0.9 * r;
    });
    // a saddle junction is ~35 mm long; stray lines would run along it
    expect(tee).toBeLessThan(0.05 * 35);
    expect(hole).toBeLessThan(0.05 * 2 * 22);
  });
  it("a mirror after the fillet keeps finite normals and the genus", () => {
    const out = FIXTURES.tee(k)._filletRaw(1).mirror("YZ");
    expect(out.genus()).toBe(GENUS.tee);
    const { normals } = out.toMesh();
    expect(normals.every((x) => Number.isFinite(x))).toBe(true);
  });
});

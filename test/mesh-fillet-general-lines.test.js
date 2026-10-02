// test/mesh-fillet-general-lines.test.js
// A general-chain band must end on the wall along ONE clean line at each rolling-ball
// contact — the CAD overlay (creased-normals.js) draws every seam between a blend band
// and its wall, so a band that grazes the faceted wall near the contact leaves a
// staircase of lens edges there instead. Exact references: the ball rolls between two
// cylinders on perpendicular axes, so its centre (spine) is known in closed form and
// each contact is the spine point pushed r along the wall's normal.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { FIXTURES, coarseKernel } from "./fixtures/fillet-general-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const N = 3600;
// crossHole: hole Rh = 3 (axis Z) through tube R = 10 (axis X); the ball sits inside
// both walls (convex rim): centre at Rh + r from Z and 10 − r from X. tee: boss Rh = 5
// on the tube; the ball sits outside both (concave): Rh + r from Z, 10 + r from X.
function exact(name, r) {
  const Rh = name === "crossHole" ? 3 : 5, s = name === "crossHole" ? 1 : -1;
  const wall = [], tube = [];
  for (let i = 0; i < N; i++) {
    const ph = (2 * Math.PI * i) / N, x = (Rh + r) * Math.cos(ph), y = (Rh + r) * Math.sin(ph);
    const z = Math.sqrt((10 - s * r) ** 2 - y * y), d = Math.hypot(y, z);
    wall.push([Rh * Math.cos(ph), Rh * Math.sin(ph), z]);
    tube.push([x, (y * 10) / d, (z * 10) / d]);
  }
  const length = (c) => c.reduce((L, a, i) => { const b = c[(i + 1) % c.length]; return L + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }, 0);
  return { Rh, s, wall, tube, wallLen: length(wall), tubeLen: length(tube) };
}
const distTo = (c, p) => Math.sqrt(Math.min(...c.map((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2)));

// Drawn boundary segments of the top junction, classified by which wall they lie on.
// The rim region reaches 2r from the hole/boss axis: the cross hole's tube contact
// sits up to (Rh + r)·10/(10 − r) from it (5.29 mm at r = 1.5, past Rh + 1.5r).
function boundaryLines(name, r, kk = k) {
  const ex = exact(name, r);
  const { edges } = FIXTURES[name](kk)._filletRaw(r).toMesh();
  const res = { ex, wallLen: 0, tubeLen: 0, wallDev: 0, tubeDev: 0 };
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const a = [edges[i], edges[i + 1], edges[i + 2]], b = [edges[i + 3], edges[i + 4], edges[i + 5]];
    const m = a.map((v, j) => (v + b[j]) / 2);
    if (m[2] < 0) continue;
    const dT = Math.hypot(m[1], m[2]), dH = Math.hypot(m[0], m[1]);
    if (!(dH < ex.Rh + 2 * r && (ex.s > 0 ? dT > 10 - 1.5 * r : dT < 10 + 1.5 * r))) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (Math.abs(dH - ex.Rh) < 0.08) {
      // the wall contact at this azimuth sits at the spine point's height
      const y = (ex.Rh + r) * Math.sin(Math.atan2(m[1], m[0]));
      res.wallLen += L;
      res.wallDev = Math.max(res.wallDev, Math.abs(m[2] - Math.sqrt((10 - ex.s * r) ** 2 - y * y)));
    } else if (Math.abs(dT - 10) < 0.08) {
      res.tubeLen += L;
      res.tubeDev = Math.max(res.tubeDev, distTo(ex.tube, m));
    }
  }
  return res;
}

describe("general-chain bands end on one clean line per contact", () => {
  for (const [name, r, both] of [["crossHole", 1.5, false], ["crossHole", 1, false], ["tee", 1.5, true], ["tee", 1, true]]) {
    it(`${name} r=${r}: boundary lines follow the exact contact curves`, () => {
      const { ex, wallLen, tubeLen, wallDev, tubeDev } = boundaryLines(name, r);
      expect(Math.abs(wallLen / ex.wallLen - 1)).toBeLessThan(0.1);
      expect(Math.abs(tubeLen / ex.tubeLen - 1)).toBeLessThan(0.1);
      expect(wallDev).toBeLessThan(0.02); // no staircase: every segment on the contact
      if (both) expect(tubeDev).toBeLessThan(0.02);
    });
  }
  // Coarse 32-gon walls: the ball touches the FACETS, which sit up to their sag inside
  // the exact cylinders (hole 3·(1 − cos π/32) = 14 µm, tube 48 µm), so the solved
  // centre and with it each contact move off the exact curves by up to about both sags
  // combined, and the chords between stations ~11° apart add as much again: the bound
  // is 2·(14 + 48) ≈ 125 µm (measured 66 µm on the hole, 102 µm on the tube). Length
  // is held on the hole side (measured +7.5%). The tube side is not: where a tube facet
  // ridge crosses between two coarse stations the straight ring stack dips under it,
  // and the wall-to-band seam and the band's own contact edge are both drawn there,
  // ~25–50 µm apart (+12.5% of tube line at r = 1.5, no stray lines elsewhere). r = 1
  // is where an uncapped contact margin shows (hole line +10.6% uncapped, −0.1% capped).
  for (const r of [1.5, 1]) {
    it(`crossHole r=${r} on 32-gon walls: the hole line stays single and on the contact`, () => {
      const { ex, wallLen, wallDev, tubeDev } = boundaryLines("crossHole", r, coarseKernel(k, 32));
      expect(Math.abs(wallLen / ex.wallLen - 1)).toBeLessThan(0.1);
      expect(wallDev).toBeLessThan(0.125);
      expect(tubeDev).toBeLessThan(0.125);
    });
  }
});

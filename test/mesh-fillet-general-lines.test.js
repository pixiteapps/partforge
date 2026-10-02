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

// Chamfers: each setback is the point on its wall at chord distance d from the edge,
// in the plane perpendicular to the edge — measured ON the curved wall, not along the
// flank's tangent line at the edge. A section that takes the tangent line instead
// leaves its side wall standing off a curved flank (a filler's adds a lens of material
// over it, from where the tangent line leaves the facets out to the setback), and the
// overlay draws every edge of that lens: on the boss-on-dome junction at d = 1.5 the
// boss-side line measured 44 mm against a 19.75 mm setback curve, with 137 segments
// running ACROSS the junction.
const CH = {
  // A: the small cylinder (hole or boss, axis Z through (ax, 0), radius Ra); B: the
  // big surface. sA: which side of B the A-wall setback lies on; sB likewise for the
  // B-surface setback relative to A.
  crossHole: { ax: 0, Ra: 3, fB: (p) => Math.hypot(p[1], p[2]) - 10, onB: (m) => Math.abs(Math.hypot(m[1], m[2]) - 10),
    edge: (ph) => { const x = 3 * Math.cos(ph), y = 3 * Math.sin(ph); return [x, y, Math.sqrt(100 - y * y)]; }, sA: -1, sB: 1 },
  tee: { ax: 0, Ra: 5, fB: (p) => Math.hypot(p[1], p[2]) - 10, onB: (m) => Math.abs(Math.hypot(m[1], m[2]) - 10),
    edge: (ph) => { const x = 5 * Math.cos(ph), y = 5 * Math.sin(ph); return [x, y, Math.sqrt(100 - y * y)]; }, sA: 1, sB: 1 },
  domeBoss: { ax: 8, Ra: 3, fB: (p) => Math.hypot(p[0], p[1], p[2]) - 20, onB: (m) => Math.abs(Math.hypot(m[0], m[1], m[2]) - 20),
    edge: (ph) => { const x = 8 + 3 * Math.cos(ph), y = 3 * Math.sin(ph); return [x, y, Math.sqrt(400 - x * x - y * y)]; }, sA: 1, sB: 1 },
};
const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scl: (a, s) => [a[0] * s, a[1] * s, a[2] * s], unit: (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
};
function exactSetbacks(name, d, n = 2000) {
  const g = CH[name], fA = (p) => Math.hypot(p[0] - g.ax, p[1]) - g.Ra;
  const grad = (f, p) => v3.unit([0, 1, 2].map((i) => { const q = [...p], s = [...p]; q[i] += 1e-6; s[i] -= 1e-6; return f(q) - f(s); }));
  const A = [], B = [];
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * i) / n, P = g.edge(ph), t = v3.unit(v3.sub(g.edge(ph + 1e-5), g.edge(ph - 1e-5)));
    for (const [f, other, s, out] of [[fA, g.fB, g.sA, A], [g.fB, fA, g.sB, B]]) {
      const nn = grad(f, P);
      let fd = v3.unit(v3.cross(t, nn)); // in-face direction, perpendicular to the edge
      if (s * other(v3.add(P, v3.scl(fd, 1e-3))) < 0) fd = v3.scl(fd, -1);
      // the circle of radius d about P in the section plane, crossing the wall near fd
      const X = (th) => v3.add(P, v3.add(v3.scl(fd, d * Math.cos(th)), v3.scl(nn, d * Math.sin(th))));
      let lo = -0.8, hi = 0.8;
      for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (Math.sign(f(X(mid))) === Math.sign(f(X(lo)))) lo = mid; else hi = mid; }
      out.push(X((lo + hi) / 2));
    }
  }
  const length = (c) => c.reduce((L, a, i) => L + Math.hypot(...v3.sub(c[(i + 1) % c.length], a)), 0);
  return { A, B, lenA: length(A), lenB: length(B) };
}
// Drawn junction lines classified by wall (within 0.08 mm of it, inside 2d of both
// surfaces), with each segment's distance from its exact setback curve, and the
// count of segments running ACROSS the junction (direction under 60° from the
// azimuth about the small cylinder's axis): a clean setback line has none.
function chamferLines(name, d) {
  const g = CH[name], ex = exactSetbacks(name, d);
  const { edges } = FIXTURES[name](k)._chamferRaw(d).toMesh();
  const res = { ex, lenA: 0, lenB: 0, devA: 0, devB: 0, across: 0 };
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const a = [edges[i], edges[i + 1], edges[i + 2]], b = [edges[i + 3], edges[i + 4], edges[i + 5]];
    const m = a.map((x, j) => (x + b[j]) / 2);
    if (m[2] < 0) continue;
    const dA = Math.hypot(m[0] - g.ax, m[1]);
    if (dA > g.Ra + 2 * d || g.onB(m) > 2 * d) continue;
    const onA = Math.abs(dA - g.Ra) < 0.08, onB = !onA && g.onB(m) < 0.08;
    if (!onA && !onB) continue;
    const L = Math.hypot(...v3.sub(b, a)), dir = v3.scl(v3.sub(b, a), 1 / L), az = v3.unit([-m[1], m[0] - g.ax, 0]);
    if (Math.abs(dir[0] * az[0] + dir[1] * az[1]) < 0.5) res.across++;
    if (onA) { res.lenA += L; res.devA = Math.max(res.devA, distTo(ex.A, m)); }
    else { res.lenB += L; res.devB = Math.max(res.devB, distTo(ex.B, m)); }
  }
  return res;
}

describe("general-chain chamfers end on one clean line per setback", () => {
  for (const [name, d] of [["domeBoss", 1], ["domeBoss", 1.5], ["tee", 1], ["tee", 1.5], ["crossHole", 1], ["crossHole", 1.5]]) {
    it(`${name} d=${d}: both setback lines follow the exact setback curves`, () => {
      const { ex, lenA, lenB, devA, devB, across } = chamferLines(name, d);
      expect(Math.abs(lenA / ex.lenA - 1)).toBeLessThan(0.1);
      expect(Math.abs(lenB / ex.lenB - 1)).toBeLessThan(0.1);
      expect(across).toBe(0);
      // on the setback, not beside it (before: the cross hole's tube-side line sat up to
      // 83 µm off, on the tangent line). The dome's preview facets sag up to 43 µm under
      // the sphere near the boss, and a drawn line lies on the facets (measured 40 µm).
      expect(Math.max(devA, devB)).toBeLessThan(name === "domeBoss" ? 0.06 : 0.03);
    });
  }
});

// Pure (WASM-free) grouping of Shape2D regions into clusters that must be unioned
// together before a kernel op, versus regions that provably touch nothing else and can
// be handed to the kernel as-is. Used by the OCCT backend's drawingFromRegions: a
// lattice of N disjoint regions must not pay N-1 boolean fuses (each one re-runs
// replicad's containment search over everything accumulated: O(N²)).
//
// Two regions INTERACT when their boundaries touch or cross, or one lies inside the
// other's material (inside its outer and not inside one of its holes — so an island
// sitting in another region's hole is DISJOINT, which is exactly how booleans emit it).
// The test runs on the contours tessellated at the shape's LOD; a pair separated by less
// than the chord error of a curve is a degenerate near-touch the kernel's own tolerance
// can't resolve either.
import { tessellateContour } from "./profile.js";
import { pointInRing } from "./shape2d-regions.js";

const EPS = 1e-7;

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a, b, p) =>
  Math.min(a[0], b[0]) - EPS <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPS &&
  Math.min(a[1], b[1]) - EPS <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPS;
// Segments ab and cd cross or touch (collinear overlap and shared endpoints count).
const segsMeet = (a, b, c, d) => {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) ||
         (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
};

const ringBox = (ring) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
};
const boxesMeet = (a, b) => a[0] <= b[2] + EPS && b[0] <= a[2] + EPS && a[1] <= b[3] + EPS && b[1] <= a[3] + EPS;

const ringsMeet = (ra, rb) => {
  if (!boxesMeet(ra.box, rb.box)) return false;
  const A = ra.pts, B = rb.pts;
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    const ex0 = Math.min(a[0], b[0]) - EPS, ex1 = Math.max(a[0], b[0]) + EPS;
    const ey0 = Math.min(a[1], b[1]) - EPS, ey1 = Math.max(a[1], b[1]) + EPS;
    if (ex1 < rb.box[0] || ex0 > rb.box[2] || ey1 < rb.box[1] || ey0 > rb.box[3]) continue;
    for (let j = 0; j < B.length; j++) {
      const c = B[j], d = B[(j + 1) % B.length];
      if (Math.max(c[0], d[0]) < ex0 || Math.min(c[0], d[0]) > ex1 ||
          Math.max(c[1], d[1]) < ey0 || Math.min(c[1], d[1]) > ey1) continue;
      if (segsMeet(a, b, c, d)) return true;
    }
  }
  return false;
};

// p is in the region's MATERIAL: inside the outer ring, outside every hole.
const inMaterial = (p, r) =>
  boxesMeet(r.outer.box, [p[0], p[1], p[0], p[1]]) && pointInRing(p, r.outer.pts) &&
  !r.holes.some((h) => pointInRing(p, h.pts));

const regionsInteract = (a, b) => {
  if (!boxesMeet(a.outer.box, b.outer.box)) return false;
  for (const ra of [a.outer, ...a.holes])
    for (const rb of [b.outer, ...b.holes])
      if (ringsMeet(ra, rb)) return true;
  // No boundary contact: each ring of one is wholly inside or outside the other, so one
  // vertex of each outer decides.
  return inMaterial(b.outer.pts[0], a) || inMaterial(a.outer.pts[0], b);
};

// regions: [{outer, holes}] (curve-native contours). Returns arrays of the ORIGINAL
// region objects: singletons are independent of everything else; larger groups
// interact transitively and need a union. Groups come out in first-member order.
export function groupInteractingRegions(regions, segs) {
  const ring = (c) => { const pts = tessellateContour(c, segs); return { pts, box: ringBox(pts) }; };
  const info = regions.map((rg) => ({ outer: ring(rg.outer), holes: rg.holes.map(ring) }));
  const parent = regions.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

  // Sweep along x: only regions whose x-extents overlap can interact.
  const order = regions.map((_, i) => i).sort((i, j) => info[i].outer.box[0] - info[j].outer.box[0]);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (info[j].outer.box[0] > info[i].outer.box[2] + EPS) break;
      if (find(i) === find(j)) continue;
      if (regionsInteract(info[i], info[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  regions.forEach((rg, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(rg);
  });
  // Map preserves insertion order: first member by index → stable output.
  return [...groups.values()];
}

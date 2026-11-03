// The drag guard's lazy rows (guard.js: pending rows, the lazy beginFrame, the order
// restored on the first measurement) must read bit for bit what EAGER rows read — every
// row measured at every beginFrame and linearisation, nearest first. Held here against an
// eager reference written out in full, on cubes that a sequence of poses walks toward a
// base cube and back: rows cross the margin and fall out of it, some stay far all along,
// and two tie.
import { describe, expect, it } from "vitest";
import { createDragGuard, COLLIDE_BAND_MM, COLLIDE_WEIGHT, MAX_ROWS } from "../src/framework/collide/guard.js";
import { createCollisionWorld } from "../src/framework/collide/world.js";
import { CONTACT_EPS, pairKey } from "../src/framework/collide/pairs.js";
import { invertRigid } from "../src/framework/geometry/pose.js";

function cube(s = 10) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return { positions: new Float64Array(v.flat()), indices: new Uint32Array(f.flat()) };
}
const rotZ = (deg, x, y, z) => {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, z, 1];
};
// a base cube and four movers: m1 and m2 close in along x and y (m2 a little turned), m3
// rides above m1 at a fixed offset (it moves, but never relative to m1), m4 stays far but
// moves fast, so its travel widens the window over pairs that barely move
const matsAt = (q) => new Map([
  ["base", undefined],
  ["m1", rotZ(0, 13 - q.u, 0, 0)],
  ["m2", rotZ(q.r, 0, 13 - q.v, 0)],
  ["m3", rotZ(0, 13 - q.u, 0, 13)],
  ["m4", rotZ(0, 60 + q.w, 60, 0)],
]);
const MOVING = ["m1", "m2", "m3", "m4"];
const margin = CONTACT_EPS + COLLIDE_BAND_MM;
const apply = (m, [x, y, z]) => (m ? [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]] : [x, y, z]);

/** The eager guard rows, written out: every row measured at every frame and linearisation. */
function eagerRows(world, start) {
  let rows = [], last = null, window = margin;
  const exempt = new Set();
  for (const r of world.distances(matsAt(start), { names: MOVING, within: COLLIDE_BAND_MM })) exempt.add(pairKey(r.a, r.b));
  const store = (row, r, mats) => {
    if (!r) { row.active = false; return; }
    const ma = mats.get(row.a), mb = mats.get(row.b);
    row.active = true; row.gap = r.distance;
    row.pa = apply(ma ? invertRigid(ma) : undefined, row.a === r.a ? r.pointA : r.pointB);
    row.pb = apply(mb ? invertRigid(mb) : undefined, row.a === r.a ? r.pointB : r.pointA);
    row.normal = r.normal && (row.a === r.a ? r.normal : r.normal.map((x) => -x));
  };
  return {
    beginFrame(q) {
      const mats = matsAt(q);
      window = margin + (last ? world.travel(matsAt(last), mats, MOVING) : 0);
      last = q;
      rows = [];
      for (const r of world.distances(mats, { names: MOVING, within: window, skip: exempt, limit: MAX_ROWS })) {
        const row = { a: r.a, b: r.b, key: pairKey(r.a, r.b) };
        store(row, r, mats);
        rows.push(row);
      }
    },
    linearise(q) {
      const mats = matsAt(q);
      const byKey = new Map(world.distances(mats, { within: window, pairs: new Set(rows.map((r) => r.key)) }).map((r) => [pairKey(r.a, r.b), r]));
      for (const row of rows) store(row, byKey.get(row.key), mats);
    },
    rows(q) {
      const mats = matsAt(q);
      return Float64Array.from(rows, (row) => {
        if (!row.active) return 0;
        if (!row.normal) return COLLIDE_WEIGHT * margin;
        const wa = apply(mats.get(row.a), row.pa), wb = apply(mats.get(row.b), row.pb), n = row.normal;
        return COLLIDE_WEIGHT * Math.max(0, margin - (n[0] * (wa[0] - wb[0]) + n[1] * (wa[1] - wb[1]) + n[2] * (wa[2] - wb[2])));
      });
    },
    get rowCount() { return rows.length; },
    get active() { return rows.some((row) => row.active && row.gap < margin); },
  };
}

describe("lazy guard rows", () => {
  it("read bit for bit what eager rows read, frame after frame", () => {
    const world = createCollisionWorld({ meshes: new Map(["base", "m1", "m2", "m3", "m4"].map((n) => [n, cube()])) });
    const guard = createDragGuard({ world, matsAt, start: { u: -1.5, v: -1.5, r: 0, w: 0 }, moving: MOVING });
    const eager = eagerRows(world, { u: -1.5, v: -1.5, r: 0, w: 0 });
    let seed = 99;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    // u and v walk in to about 0.3 mm from the base and back out, m2 turning, while m4
    // leaps 6 mm a frame: the window then spans pairs 4-8 mm apart whose bounds hold
    // (lazy frames with rows), and the evaluations' long steps pull them inside the margin
    const path = Array.from({ length: 28 }, (_, f) => {
      const s = Math.sin((Math.PI * f) / 27);
      return { u: -1.5 + 4.2 * s, v: -1.5 + 3.9 * s, r: 4 * s, w: 6 * f };
    });
    let nonZero = 0, zero = 0, rowsSeen = 0;
    for (const p of path) {
      guard.beginFrame(p); eager.beginFrame(p);
      expect(guard.rowCount).toBe(eager.rowCount);
      expect(guard.active).toBe(eager.active);
      rowsSeen = Math.max(rowsSeen, guard.rowCount);
      let x = p;
      for (let it = 0; it < 4; it++) {
        if (it > 0) { guard.linearise(x); eager.linearise(x); expect(guard.active).toBe(eager.active); }
        // the evaluations a DLS iteration makes: central differences, then trial steps
        for (const dx of [1e-4, -1e-4, 0.05, -0.3, 0.6 * (rnd() - 0.5), 2.5]) {
          for (const key of ["u", "v", "r"]) {
            const q = { ...x, [key]: x[key] + dx };
            const want = eager.rows(q), got = guard.rows(q);
            expect(Array.from(got)).toEqual(Array.from(want));
            for (const v of want) if (v === 0) zero++; else nonZero++;
          }
        }
        x = { ...x, u: x.u + 0.5 * (rnd() - 0.3), v: x.v + 0.5 * (rnd() - 0.3), r: x.r + rnd() - 0.5 };
      }
    }
    // the walk exercised both kinds of row, and more than one row at a time
    expect(nonZero).toBeGreaterThan(20);
    expect(zero).toBeGreaterThan(20);
    expect(rowsSeen).toBeGreaterThan(1);
    world.dispose();
  });
});

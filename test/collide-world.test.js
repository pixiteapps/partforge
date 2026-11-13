import { describe, it, expect } from "vitest";
import { createCollisionWorld, buildIndex, poseMatrices, relativeMatsAt, TOUCH_TOL_MM } from "../src/framework/collide/world.js";
import { normalizeCollisions } from "../src/framework/collide/declaration.js";
import { resolveParams } from "../src/framework/part-model.js";
import drawerBox from "../src/parts/drawer-box.js";

function cube(s = 10) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return { positions: new Float64Array(v.flat()), indices: new Uint32Array(f.flat()) };
}
const T = (x, y = 0, z = 0) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
const meshes = () => new Map([["a", cube()], ["b", cube()], ["c", cube()]]);

describe("collision world", () => {
  it("distances honours allow", () => {
    const decl = normalizeCollisions({ collisions: { allow: ["a×b"] } });
    const w = createCollisionWorld({ meshes: meshes(), decl });
    const r = w.distances(new Map([["a", T(0)], ["b", T(15)], ["c", T(40)]]));
    expect(r.map((x) => [x.a, x.b].join())).not.toContain("a,b");
    expect(r.length).toBe(2);
    w.dispose();
  });
  it("an empty member reads clear, never throws, and moves nothing", () => {
    const empty = { positions: new Float64Array(0), indices: new Uint32Array(0) };
    const w = createCollisionWorld({ meshes: new Map([["a", cube()], ["b", cube()], ["e", empty]]) });
    const R = [0,1,0,0, -1,0,0,0, 0,0,1,0, 3,4,5,1]; // a turn: an Infinity box would go NaN under it
    const mats = new Map([["a", T(0)], ["b", T(15)], ["e", R]]);
    const r = w.distances(mats, { within: Infinity });
    expect(r.map((x) => [x.a, x.b].join())).toEqual(["a,b"]);
    expect(r[0].distance).toBeCloseTo(5);
    expect(w.distances(mats, { within: Infinity, names: ["e"] })).toEqual([]);
    expect(w.boundsOf("e")).toBeNull();
    expect(w.travel(new Map([["e", T(0)]]), new Map([["e", R]]), ["e"])).toBe(0);
    w.dispose();
  });
  it("names lists every indexed mesh", () => {
    const w = createCollisionWorld({ meshes: meshes() });
    expect(w.names()).toEqual(["a", "b", "c"]);
    w.dispose();
  });
  it("within prunes far pairs", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube()], ["b", cube()]]) });
    const mats = new Map([["a", T(0)], ["b", T(20)]]);
    expect(w.distances(mats, { within: 2 })).toEqual([]);
    expect(w.distances(mats, { within: 20 })[0].distance).toBeCloseTo(10);
    w.dispose();
  });
  it("pairs and skip pick pairs before any query", () => {
    const w = createCollisionWorld({ meshes: meshes() });
    const mats = new Map([["a", T(0)], ["b", T(12)], ["c", T(24)]]);
    const keys = (r) => r.map((x) => [x.a, x.b].join());
    expect(keys(w.distances(mats))).toEqual(["a,b", "b,c", "a,c"]);
    expect(keys(w.distances(mats, { pairs: new Set(["b×c"]) }))).toEqual(["b,c"]);
    expect(keys(w.distances(mats, { skip: new Set(["a×b"]) }))).toEqual(["b,c", "a,c"]);
    // same numbers as the unfiltered query
    expect(w.distances(mats, { pairs: new Set(["a×c"]) })[0]).toEqual(w.distances(mats)[2]);
    w.dispose();
  });
  it("a small cutoff reads exactly what the plain query reads", () => {
    // five cubes at assorted gaps, two tied: the boolean prefilter (a cutoff under 0.5 mm)
    // changes the work, never the answer
    const names = ["a", "b", "c", "d", "e"];
    const w = createCollisionWorld({ meshes: new Map(names.map((n) => [n, cube()])) });
    const mats = new Map([["a", T(0)], ["b", T(10.3)], ["c", T(20.6, 0.2)], ["d", T(0, 10.3)], ["e", T(31, 1, 0.1)]]);
    const all = w.distances(mats);
    for (const within of [0.29, 0.3, 0.31, 0.4]) expect(w.distances(mats, { within })).toEqual(all.filter((r) => r.distance <= within));
    w.dispose();
  });
  it("a bounds map reused across a walk of poses reads exactly what the plain query reads", () => {
    // three cubes jiggling near a fourth: relative moves both under and past the bound
    // pad (0.05 mm), turns included, gaps crossing the cutoffs; one bounds map for the walk
    const w = createCollisionWorld({ meshes: new Map(["a", "b", "c", "d"].map((n) => [n, cube()])) });
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    // a cube turned about z through its own centre (5, 5), then moved by (x, y, z)
    const pose = (deg, x, y, z) => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x + 5 - (5 * c - 5 * s), y + 5 - (5 * s + 5 * c), z, 1]; };
    // each cube's offset from its base pose wanders (clamped) and turns a few degrees, so
    // the pairs stay close: touching, a hair apart, or a few tenths
    const base = { b: [10.6, 0, 0, 0], c: [0, 10.5, 0, 0], d: [10.8, 10.8, 0, 0] }; // x, y, z, deg
    for (const within of [1e-3, 0.3, 0.45]) {
      const bounds = new Map();
      const off = { b: [0, 0, 0, 0], c: [0, 0, 0, 0], d: [0, 0, 0, 0] };
      let hits = 0, candidates = 0;
      for (let step = 0; step < 200; step++) {
        const size = step % 7 === 0 ? 0.4 : step % 3 === 0 ? 0.08 : 0.01; // past the pad, near it, well inside it
        for (const k of Object.keys(off)) {
          off[k] = off[k].map((v, i) => { const lim = i === 3 ? 6 : 0.35; return Math.max(-lim, Math.min(lim, v + (i === 3 ? 20 * size : size) * (rnd() - 0.5))); });
        }
        const mats = new Map([["a", T(0)], ...Object.entries(base).map(([k, p]) => {
          const [x, y, z, deg] = p.map((v, i) => v + off[k][i]);
          return [k, pose(deg, x, y, z)];
        })]);
        const got = w.distances(mats, { within, bounds });
        const want = w.distances(mats, { within });
        expect(got).toEqual(want);
        hits += want.length;
        candidates += w.candidates(mats, { within }).length;
      }
      // the walk met pairs whose boxes were within the cutoff (so bounds were kept and read)
      expect(candidates).toBeGreaterThan(100);
      expect(bounds.size).toBeGreaterThan(0);
      if (within > 0.1) expect(hits).toBeGreaterThan(0);
    }
    w.dispose();
  });
  it("null matrix excludes a name", () => {
    const w = createCollisionWorld({ meshes: meshes() });
    const r = w.distances(new Map([["a", T(0)], ["b", null], ["c", T(40)]]));
    expect(r.length).toBe(1);
    expect([r[0].a, r[0].b].sort()).toEqual(["a", "c"]);
    w.dispose();
  });
  it("normal points from b to a", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube()], ["b", cube()]]) });
    const [r] = w.distances(new Map([["a", T(0)], ["b", T(15)]]));
    const sign = r.a === "a" ? 1 : -1; // normal = pointA - pointB for the pair as reported
    expect(r.normal[0] * sign).toBeCloseTo(-1);
    expect(Math.hypot(...r.normal)).toBeCloseTo(1);
    const [t] = w.distances(new Map([["a", T(0)], ["b", T(5)]]));
    expect(t.distance).toBe(0);
    expect(t.normal).toBeNull();
    w.dispose();
  });
  it("inside sees a cube within a larger one", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube(10)], ["b", cube(2)]]) });
    expect(w.inside(new Map([["a", T(0)], ["b", T(4, 4, 4)]]), "a", "b")).toBe(true);
    expect(w.inside(new Map([["a", T(0)], ["b", T(40)]]), "a", "b")).toBe(false);
    w.dispose();
  });
  it("travel of a 90 degree turn", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube(10)]]) });
    const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
    const rotZ = [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]; // about the origin
    // farthest corner (10,10) sits at radius 10*sqrt2; a quarter turn moves it a chord of r*sqrt2 = 20
    expect(w.travel(new Map([["a", T(0)]]), new Map([["a", rotZ]]), ["a"])).toBeCloseTo(20, 6);
    w.dispose();
  });
});

describe("mats contract", () => {
  it("travel skips a name that is null in either set; a missing key is the identity", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube(10)]]) });
    const far = new Map([["a", T(50)]]);
    expect(w.travel(new Map([["a", null]]), far, ["a"])).toBe(0);
    expect(w.travel(far, new Map([["a", null]]), ["a"])).toBe(0);
    expect(w.travel(new Map(), far, ["a"])).toBeCloseTo(50);
    w.dispose();
  });
  it("inside is false when either matrix is null; a missing key is the identity", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube(10)], ["b", cube(2)]]) });
    const nested = new Map([["b", T(4, 4, 4)]]); // a missing -> identity
    expect(w.inside(nested, "a", "b")).toBe(true);
    expect(w.inside(new Map([["a", null], ["b", T(4, 4, 4)]]), "a", "b")).toBe(false);
    expect(w.inside(new Map([["a", T(0)], ["b", null]]), "a", "b")).toBe(false);
    w.dispose();
  });
  it("distances treats a missing key as the identity", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube()], ["b", cube()]]) });
    expect(w.distances(new Map([["b", T(15)]]))[0].distance).toBeCloseTo(5);
    w.dispose();
  });
});

describe("pose matrices", () => {
  it("moves a drawer on the drawer box", () => {
    const { p, d } = resolveParams(drawerBox, { drawer1Open: 50 });
    const m = poseMatrices(drawerBox, "cabinet", p, d).get("drawer1");
    expect(m[12]).toBeCloseTo(0);
    expect(m[13]).toBeCloseTo(-0.5 * (p.depth - 10));
    expect(m[14]).toBeCloseTo(0);
  });
  it("does not call derive", () => {
    let calls = 0;
    const part = { ...drawerBox, derive: (...a) => { calls++; return drawerBox.derive(...a); } };
    const { p, d } = resolveParams(drawerBox, {});
    poseMatrices(part, "cabinet", p, d);
    expect(calls).toBe(0);
  });
  it("relativeMatsAt is identity at the start pose", () => {
    const s = resolveParams(drawerBox, {});
    const at = relativeMatsAt(drawerBox, "cabinet", s.p, s.d);
    const moved = resolveParams(drawerBox, { drawer2Open: 100 });
    const rel = at(moved.p, moved.d);
    expect(rel.get("drawer1")[13]).toBeCloseTo(0);
    const base = resolveParams(drawerBox, {});
    expect(rel.get("drawer2")[13]).toBeCloseTo(-0.6 * (base.p.depth - 10));
  });
});

// An axis-aligned box from min to max, 12 triangles wound outward.
function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return { positions: new Float64Array(v.flat()), indices: new Uint32Array(f.flat()) };
}
// A closed cylinder along z: radius r, z from z0 to z1, n segments, `rings` bands, as a soup.
function cylinder(r, z0, z1, n = 64, rings = 1) {
  const pos = [];
  const pt = (i, j) => { const a = (2 * Math.PI * i) / n; return [r * Math.cos(a), r * Math.sin(a), z0 + ((z1 - z0) * j) / rings]; };
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < rings; j++) pos.push(...pt(i, j), ...pt(i2, j), ...pt(i2, j + 1), ...pt(i, j), ...pt(i2, j + 1), ...pt(i, j + 1));
    pos.push(0, 0, z0, ...pt(i2, 0), ...pt(i, 0)); // bottom cap, facing -z
    pos.push(0, 0, z1, ...pt(i, rings), ...pt(i2, rings)); // top cap, facing +z
  }
  return { positions: new Float64Array(pos) };
}
// A tube along z (a block with a bore): radii rIn < rOut, z from z0 to z1, as a soup.
function tube(rIn, rOut, z0, z1, n = 64, rings = 1) {
  const pos = [];
  const pt = (r, i, j) => { const a = (2 * Math.PI * i) / n; return [r * Math.cos(a), r * Math.sin(a), z0 + ((z1 - z0) * j) / rings]; };
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < rings; j++) {
      pos.push(...pt(rOut, i, j), ...pt(rOut, i2, j), ...pt(rOut, i2, j + 1), ...pt(rOut, i, j), ...pt(rOut, i2, j + 1), ...pt(rOut, i, j + 1));
      pos.push(...pt(rIn, i, j), ...pt(rIn, i2, j + 1), ...pt(rIn, i2, j), ...pt(rIn, i, j), ...pt(rIn, i, j + 1), ...pt(rIn, i2, j + 1));
    }
    pos.push(...pt(rIn, i, 0), ...pt(rOut, i2, 0), ...pt(rOut, i, 0), ...pt(rIn, i, 0), ...pt(rIn, i2, 0), ...pt(rOut, i2, 0));
    pos.push(...pt(rIn, i, rings), ...pt(rOut, i, rings), ...pt(rOut, i2, rings), ...pt(rIn, i, rings), ...pt(rOut, i2, rings), ...pt(rIn, i2, rings));
  }
  return { positions: new Float64Array(pos) };
}

describe("penetration depth", () => {
  const depthOf = (ma, mb, a = cube(), b = cube()) => {
    const w = createCollisionWorld({ meshes: new Map([["a", a], ["b", b]]) });
    const mats = new Map([["a", ma], ["b", mb]]);
    const d = w.depth("a", "b", mats);
    expect(w.depth("b", "a", mats)).toBeCloseTo(d, 9); // the same reading either way round
    w.dispose();
    return d;
  };
  it("names the touching tolerance", () => {
    expect(TOUCH_TOL_MM).toBe(0.02);
  });
  it("two boxes overlapping by 0.3 mm along X read 0.3", () => {
    const d = depthOf(T(0), T(9.7));
    expect(d).toBeGreaterThanOrEqual(0.25);
    expect(d).toBeLessThanOrEqual(0.35);
  });
  it("box presses of 0.1 to 2 mm read within 0.05 mm", () => {
    for (const press of [0.1, 0.5, 1, 2]) expect(Math.abs(depthOf(T(0), T(10 - press)) - press)).toBeLessThanOrEqual(0.05);
  });
  it("face-to-face touching reads within the touching tolerance", () => {
    expect(depthOf(T(0), T(10))).toBeLessThanOrEqual(TOUCH_TOL_MM);
  });
  it("1 mm apart reads 0", () => {
    expect(depthOf(T(0), T(11))).toBe(0);
  });
  it("a 3 mm pin in a 2.8 mm bore reads the 0.1 mm radial press", () => {
    const d = depthOf(T(0), T(0), cylinder(1.5, -5, 15), tube(1.4, 5, 0, 10));
    expect(d).toBeGreaterThanOrEqual(0.05);
    expect(d).toBeLessThanOrEqual(0.15);
  });
  it("cylinder-in-bore presses of 0.1 to 2 mm read within 0.05 mm", () => {
    for (const press of [0.1, 0.5, 1, 2]) {
      const d = depthOf(T(0), T(0), cylinder(3, -5, 15), tube(3 - press, 8, 0, 10));
      expect(Math.abs(d - press)).toBeLessThanOrEqual(0.05);
    }
  });
  it("a 0.4 mm wall pressed 0.3 mm into a block reads 0.3", () => {
    const d = depthOf(T(0), T(0), box([3, -5, 9.7], [3.4, 15, 20]), cube(10));
    expect(d).toBeGreaterThanOrEqual(0.25);
    expect(d).toBeLessThanOrEqual(0.35);
  });
  it("a small cube wholly inside a large one reads at least its distance to the wall", () => {
    expect(depthOf(T(0), T(2, 4, 4), cube(10), cube(2))).toBeGreaterThanOrEqual(2);
  });
  it("two crossed bars with no vertex inside the other read the overlap", () => {
    // a bar along X and a bar along Y crossing off-centre, overlapping 1 mm in z: no vertex
    // of either lies inside the other, only the stretch of the edges through it
    const d = depthOf(T(0), T(0), box([-50, -1, -1], [50, 1, 1]), box([6, -50, 0], [8, 50, 2]));
    expect(d).toBeGreaterThan(TOUCH_TOL_MM);
    expect(Math.abs(d - 1)).toBeLessThanOrEqual(0.05);
  });
  // Two meshes merged into one (a non-convex piece: two walls, two knuckles).
  const merged = (...ms) => ({ positions: new Float64Array(ms.flatMap((m) => [...(m.indices ? [...m.indices].flatMap((i) => [...m.positions.slice(3 * i, 3 * i + 3)]) : m.positions)])) });
  it("a bar ploughing through two separate walls of one mesh reads the depth in each wall", () => {
    // walls x 0..2 and 8..10 (y 0..10, z 0..10) as ONE mesh; a bar x -5..15, y 1..2.5,
    // z 5..7 passes through both. No vertex of either is inside the other, and no wall
    // edge crosses the bar (each side face's diagonal passes above or below it); the bar's
    // long edges' one midpoint over the walls' combined box is x 5, in the gap. Deepest bar
    // point inside a wall: its long edges' stretch through the wall, midpoint x 1 — 1 mm
    // from both wall faces (x 0, x 2), and 1 to 2.5 mm from the wall's y 0 face, 3 to 5 mm
    // from z 0 / z 10. So 1. (Through one solid block x 0..10 the same midpoint is x 5 and
    // the y 2.5 edge reads 2.5, the y-limited depth.)
    const bar = box([-5, 1, 5], [15, 2.5, 7]);
    const walls = merged(box([0, 0, 0], [2, 10, 10]), box([8, 0, 0], [10, 10, 10]));
    expect(Math.abs(depthOf(T(0), T(0), bar, walls) - 1)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(depthOf(T(0), T(0), bar, box([0, 0, 0], [10, 10, 10])) - 2.5)).toBeLessThanOrEqual(0.1);
  });
  it("a pin through two knuckles of one mesh reads its radial press", () => {
    // knuckles: bores of r 2.9 in two tubes (z 0..5 and 10..15) merged into one mesh; a
    // r 3 pin (z -5..20), one band, so its side edges run the whole length and their
    // midpoint (z 7.5) is in the gap. The pin's surface inside each knuckle is 0.1 mm past
    // the bore (radially): 0.1, less the faceting (64 segments, cos(pi/64) of it).
    const knuckles = merged(tube(2.9, 6, 0, 5), tube(2.9, 6, 10, 15));
    const d = depthOf(T(0), T(0), cylinder(3, -5, 20), knuckles);
    expect(Math.abs(d - 0.1)).toBeLessThanOrEqual(0.02);
  });
  // A mesh moved by (x, y, z), as a soup.
  const moved = (m, x, y, z) => {
    const s = merged(m).positions;
    for (let i = 0; i < s.length; i += 3) { s[i] += x; s[i + 1] += y; s[i + 2] += z; }
    return { positions: s };
  };
  it("a body of one mesh buried in the other with no surface contact reads its depth, whatever its order", () => {
    // B: a 100 mm box at 0..100. A: two cubes in one mesh, a 10 mm one at x 150..160
    // (outside B) and a 20 mm one at 40..60 on every axis (buried in B, no surface
    // contact). The buried cube's vertices, e.g. (40, 40, 40), are 40 mm from B's nearest
    // faces, and no sample of it is deeper (every point of it is at least 40 from B's
    // faces); nothing of B is inside A. So 40, with either cube listed first.
    const outside = moved(cube(10), 150, 45, 45), buried = moved(cube(20), 40, 40, 40);
    for (const a of [merged(outside, buried), merged(buried, outside)]) {
      expect(Math.abs(depthOf(T(0), T(0), a, cube(100)) - 40)).toBeLessThanOrEqual(0.05);
    }
  });
  it("a single body wholly nested with no surface contact reads its depth", () => {
    // a 20 mm cube at 40..60 in a 100 mm box: every vertex 40 from the box's faces
    expect(Math.abs(depthOf(T(0), T(40, 40, 40), cube(100), cube(20)) - 40)).toBeLessThanOrEqual(0.05);
  });
  it("two apart meshes whose boxes overlap read 0 without sampling", () => {
    // an L of two bars and a cube in its crook: the boxes overlap, the surfaces are 1 mm apart
    const ell = merged(box([0, 0, 0], [30, 5, 5]), box([0, 5, 0], [5, 30, 5]));
    const ixA = buildIndex(ell), ixB = buildIndex(moved(cube(10), 6, 6, 0));
    // the sampler asks closestPoint of every sample; the shortcut (a distance check and one
    // parity ray per connected component) never does
    let queries = 0;
    for (const ix of [ixA, ixB]) { const f = ix.bvh.closestPoint; ix.bvh.closestPoint = (...args) => { queries++; return f(...args); }; }
    const w = createCollisionWorld({ indexes: new Map([["a", ixA], ["b", ixB]]) });
    const mats = new Map();
    expect(w.depth("a", "b", mats)).toBe(0);
    expect(w.depth("b", "a", mats)).toBe(0);
    expect(queries).toBe(0); // no sample was looked at
    w.dispose();
  });
  it("follows the mats contract: null excludes, a missing key is the identity", () => {
    const w = createCollisionWorld({ meshes: new Map([["a", cube()], ["b", cube()]]) });
    expect(w.depth("a", "b", new Map([["b", T(9.5)]]))).toBeCloseTo(0.5, 6);
    expect(w.depth("a", "b", new Map([["a", null], ["b", T(9.5)]]))).toBe(0);
    expect(w.depth("a", "b", new Map([["b", null]]))).toBe(0);
    w.dispose();
  });
  it("reads a turned placement", () => {
    // b turned a quarter about z ((x, y) -> (-y, x): x from -10 to 0), then moved 19.6 along
    // X, so it spans 9.6 to 19.6 and presses 0.4 into a
    const d = depthOf(T(0), [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 19.6, 0, 0, 1]);
    expect(Math.abs(d - 0.4)).toBeLessThanOrEqual(0.05);
  });
});

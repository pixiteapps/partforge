import { describe, it, expect } from "vitest";
import { createCollisionWorld, poseMatrices, relativeMatsAt } from "../src/framework/collide/world.js";
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

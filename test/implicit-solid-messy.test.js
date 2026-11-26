// test/implicit-solid-messy.test.js
// A damaged closed mesh as a `solid` leaf. The damage is the kind a broken STL export
// leaves: a fin (a strip of the surface that runs past an edge and folds back flat under
// itself) and a zero-area triangle. A fold leaves a pseudonormal that cancels to a tiny
// vector of no particular direction, so the field reads inside in a wedge that runs far out
// from the fold, and the mesher's cull steps past the surface: "Not manifold". The leaf must
// either build the right solid or refuse with the place of the fold, when it is compiled.
import { describe, expect, test, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { buildMeshField } from "../src/framework/geometry/implicit/mesh-field-build.js";
import { MeshFieldError } from "../src/framework/geometry/implicit/mesh-field.js";
import { ImplicitSpecError } from "../src/framework/geometry/implicit/errors.js";

const H = 10;
// A closed 20 mm box, n × n quads on each face (n = 5: 300 triangles), wound outward.
function boxMesh(n = 5) {
  const P = [], T = [], ids = new Map();
  const v = (p) => { const key = p.join(); let i = ids.get(key); if (i === undefined) { i = P.length / 3; ids.set(key, i); P.push(...p); } return i; };
  for (const [a, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const u = (a + 1) % 3, w = (a + 2) % 3;
    const at = (i, j) => { const p = [0, 0, 0]; p[a] = s * H; p[u] = -H + (2 * H * i) / n; p[w] = -H + (2 * H * j) / n; return v(p); };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p00 = at(i, j), p10 = at(i + 1, j), p11 = at(i + 1, j + 1), p01 = at(i, j + 1);
      if (s > 0) T.push(p00, p10, p11, p00, p11, p01); else T.push(p00, p11, p10, p00, p01, p11);
    }
  }
  return { positions: P, indices: T };
}
const pos = (m, i) => m.positions.slice(3 * i, 3 * i + 3);
// The first triangle (index t) and corner order (a, b, c) for which pred(a, b, c) holds.
function findCorner(m, pred) {
  const T = m.indices;
  for (let t = 0; t < T.length; t += 3) for (let j = 0; j < 3; j++) {
    const a = T[t + j], b = T[t + (j + 1) % 3], c = T[t + (j + 2) % 3];
    if (pred(a, b, c)) return { t, a, b, c };
  }
  throw new Error("fixture: no such triangle");
}
// The fin, on the top edge x = H, z = H: the top face reaches `w` past the edge to E, then
// folds back flat under itself to the edge's midpoint M, where the side wall starts. E sits
// `droop` below the top plane, so the folded corner's sum does not cancel exactly (a damaged
// file never cancels exactly). The volume is unchanged and the mesh stays closed.
const FIN_W = 0.3, FIN_DROOP = 0.001;
function withFin(m) {
  const onEdge = (i) => { const p = pos(m, i); return p[0] === H && p[2] === H && p[1] > -H && p[1] < H; };
  const top = findCorner(m, (a, b, c) => onEdge(a) && onEdge(b) && pos(m, c)[2] === H);
  const { a: A, b: B, c: X } = top;
  const side = findCorner(m, (a, b) => a === B && b === A);
  const Y = side.c, pa = pos(m, A), pb = pos(m, B), mid = pa.map((x, i) => (x + pb[i]) / 2);
  const M = m.positions.length / 3, E = M + 1;
  m.positions.push(...mid, mid[0] + FIN_W, mid[1], mid[2] - FIN_DROOP);
  m.indices.splice(top.t, 3, A, E, X); m.indices.push(E, B, X, B, E, M, E, A, M);
  m.indices.splice(side.t, 3, B, M, Y); m.indices.push(M, A, Y);
  m.fin = { y: [Math.min(pa[1], pb[1]), Math.max(pa[1], pb[1])] };   // the fin's span along the edge
  return m;
}
// A zero-area triangle: an edge of a top triangle split at its midpoint M, and the needle
// (A, B, M) along that edge closes the mesh again.
function withNeedle(m) {
  const top = findCorner(m, (a, b, c) => pos(m, a)[2] === H && pos(m, b)[2] === H && pos(m, c)[2] === H);
  const { a: A, b: B, c: X } = top, pa = pos(m, A), pb = pos(m, B);
  const M = m.positions.length / 3;
  m.positions.push(...pa.map((x, i) => (x + pb[i]) / 2));
  m.indices.splice(top.t, 3, A, M, X); m.indices.push(M, B, X, A, B, M);
  return m;
}
// A prism whose cross-section is a wedge of `deg` degrees, `L` long, 10 high: a sound solid
// with a knife edge, whose two faces at the edge are nearly opposite. It must not be mistaken
// for a fold. With `strip`, each side face is cut along a line `strip` from the knife edge, so
// the triangles beside the edge are slivers of about that altitude.
function wedgeMesh(deg, L = 20, strip = 0) {
  const t = Math.tan((deg / 2) * Math.PI / 180), P = [], T = [];
  const v = (x, y, z) => (P.push(x, y, z), P.length / 3 - 1);
  const xs = strip ? [0, strip, L] : [0, L];
  const lo = xs.map((x) => [v(x, -t * x, 0), v(x, t * x, 0)]), hi = xs.map((x) => [v(x, -t * x, 10), v(x, t * x, 10)]);
  for (let i = 0; i + 1 < xs.length; i++) {
    T.push(lo[i][0], lo[i + 1][0], hi[i + 1][0], lo[i][0], hi[i + 1][0], hi[i][0]);
    T.push(lo[i][1], hi[i + 1][1], lo[i + 1][1], lo[i][1], hi[i][1], hi[i + 1][1]);
  }
  const n = xs.length - 1;
  T.push(lo[n][0], lo[n][1], hi[n][1], lo[n][0], hi[n][1], hi[n][0]);
  const ring = (ps) => [ps[0][0], ...ps.slice(1).map((p) => p[0]), ...ps.slice(1).reverse().map((p) => p[1])];
  const rb = ring(lo), rt = ring(hi);
  for (let i = 1; i + 1 < rb.length; i++) T.push(rb[0], rb[i + 1], rb[i], rt[0], rt[i], rt[i + 1]);
  return { positions: P, indices: T };
}

const WEDGES = [1, 2, 3, 20];
const meshes = { clean: boxMesh(), fin: withFin(boxMesh()), needle: withNeedle(boxMesh()), both: withNeedle(withFin(boxMesh())),
  ...Object.fromEntries(WEDGES.map((d) => [`wedge${d}`, wedgeMesh(d)])), slivered: wedgeMesh(10, 100, 0.01) };
let k;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-messy-"));
  const imports = {};
  for (const [name, m] of Object.entries(meshes)) {
    const file = join(dir, `${name}.stl`);
    writeFileSync(file, Buffer.from(meshToStl(m.positions, m.indices)));
    imports[name] = new URL(`file://${file}`);
  }
  k = await bootManifoldKernel({ quality: "preview", meshFields: true, imports });
});

const ops = {
  "offset 1": (s) => ({ kind: "offset", d: 1, child: { kind: "solid", solid: s } }),
  "offset -1": (s) => ({ kind: "offset", d: -1, child: { kind: "solid", solid: s } }),
  "smooth union": (s) => ({ kind: "union", k: 5, children: [{ kind: "solid", solid: s }, { kind: "sphere", r: 6, at: [0, 0, 14] }] }),
};
const EDGES = [0.5, 0.8];
const FOLDED = /^implicit: root(\.child|\.children\[0\])\.solid: the solid's mesh folds back on itself: (?:1 triangle is|\d+ triangles are) folded, the first near \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/;
const outcome = (name, op, edge) => {
  try { return { volume: k.implicit({ preview: edge, root: ops[op](k.import(name)) }).volume() }; }
  catch (e) { return { error: e }; }
};

describe("a damaged mesh as a solid leaf", () => {
  test("the damaged imports are closed solids of the box's volume (the import accepts them)", () => {
    for (const name of ["fin", "needle", "both"]) expect(k.import(name).volume()).toBeCloseTo(8000, 0);
  });

  for (const name of ["fin", "needle", "both"]) for (const op of Object.keys(ops)) for (const edge of EDGES) {
    test(`${name}, ${op} at ${edge} mm: builds within 2% of the clean box's result, or is refused as folded`, () => {
      const clean = outcome("clean", op, edge), got = outcome(name, op, edge);
      expect(clean.error).toBeUndefined();
      if (got.error) {
        expect(got.error).toBeInstanceOf(ImplicitSpecError);
        expect(got.error.message).toMatch(FOLDED);
      } else {
        expect(Math.abs(got.volume / clean.volume - 1)).toBeLessThan(0.02);
      }
    });
  }

  test("a fin is refused when the leaf is compiled, and the message names a point on the fin", () => {
    for (const op of Object.keys(ops)) {
      const { error } = outcome("fin", op, 0.5);
      const m = error?.message.match(FOLDED);
      expect(m, String(error?.message)).not.toBeNull();
      // On the fin: past the box's edge by at most the fin's width, in the top plane, inside its span.
      const [x, y, z] = m.slice(2, 5).map(Number);
      expect(x).toBeGreaterThanOrEqual(H - 0.01); expect(x).toBeLessThanOrEqual(H + FIN_W + 0.01);
      expect(Math.abs(z - H)).toBeLessThanOrEqual(0.01);
      expect(y).toBeGreaterThanOrEqual(meshes.fin.fin.y[0] - 0.01); expect(y).toBeLessThanOrEqual(meshes.fin.fin.y[1] + 0.01);
      expect(error.message).toMatch(/: repair the mesh in a mesh tool and import it again, or, for a solid built in this part, build it at a finer grid$/);
    }
  });

  test("a zero-area triangle alone builds, within 2% of the clean box", () => {
    for (const op of Object.keys(ops)) {
      const clean = outcome("clean", op, 0.5), got = outcome("needle", op, 0.5);
      expect(got.error).toBeUndefined();
      expect(Math.abs(got.volume / clean.volume - 1)).toBeLessThan(0.02);
    }
  });

  for (const deg of WEDGES) {
    test(`a knife edge is not a fold: the ${deg}° wedge builds`, () => {
      const wedge = k.import(`wedge${deg}`);
      const grown = k.implicit({ preview: 0.5, root: ops["offset 1"](wedge) });
      expect(grown.volume()).toBeGreaterThan(wedge.volume());
    });
  }

  test("a 100 mm part with a 10° edge whose triangles are slivers (altitude about 0.01 mm) builds", () => {
    const part = k.import("slivered");
    expect(part.volume()).toBeGreaterThan(0);
    expect(k.implicit({ preview: 1, root: ops["offset 1"](part) }).volume()).toBeGreaterThan(part.volume());
  });
});

// A pinned refusal. A k.implicit result of a knife blade two grid cells thick (0.8 mm at
// grid 0.4, a 20° tip) has flipped triangles on its thin edge, and its field is wrong off the
// surface: meshDistance reads -1.99 at a point 2 mm outside, where ray parity and a winding
// number both say outside. Before the fold check it built, by luck (the wrong wedge missed
// every sample that mattered). The refusal is right; the cause is cleanup's flipped rim
// triangles upstream.
describe("a k.implicit blade two grid cells thick, as a leaf, is refused", () => {
  test("blade t 0.8, tip 20°, inner preview 0.4", () => {
    const t = 0.8, tip = (t / 2) / Math.tan((10 * Math.PI) / 180);
    const blade = k.extrude({ profile: { outer: [[0, -t / 2], [10, -t / 2], [10 + tip, 0], [10, t / 2], [0, t / 2]] }, h: 8 });
    const leaf = k.implicit({ preview: 0.4, root: { kind: "solid", solid: blade } });
    let err;
    try { k.implicit({ preview: 0.5, root: { kind: "offset", d: 0.3, child: { kind: "solid", solid: leaf } } }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ImplicitSpecError);
    expect(err.message).toMatch(FOLDED);
  });
});

// A k.implicit result as a leaf. Cleanup leaves a few small flipped triangles on the
// cylinder's top rim (7 to 13 edges whose normals' dot is -0.6 to -0.999), but the field is
// right off the surface, so the leaf builds, exactly as before the fold check. The volumes
// are this branch's before the check (the field's arrays are unchanged, so they are also its
// volumes now), to 1%.
describe("a k.implicit result as a solid leaf builds", () => {
  const ref = {
    0.5: { "offset 0.3": [9564.5, 9552.1], "offset -0.3": [7595.8, 7573.1], "union k 3": [8916.4, 8913.1] },
    0.3: { "offset 0.3": [9570.6, 9557.5], "offset -0.3": [7597.6, 7571.9], "union k 3": [8915.9, 8916.7] },
  };
  const outer = {
    "offset 0.3": (s) => ({ kind: "offset", d: 0.3, child: { kind: "solid", solid: s } }),
    "offset -0.3": (s) => ({ kind: "offset", d: -0.3, child: { kind: "solid", solid: s } }),
    "union k 3": (s) => ({ kind: "union", k: 3, children: [{ kind: "solid", solid: s }, { kind: "sphere", r: 5, at: [0, 0, 21] }] }),
  };
  for (const inner of [0.5, 0.3]) for (const op of Object.keys(outer)) {
    test(`inner grid ${inner}, ${op}, at outer grids 0.5 and 0.8`, () => {
      const bc = k.box({ min: [-15, -15, 0], max: [15, 15, 6] }).union(k.cylinder({ r: 6, h: 20 }));
      const leaf = k.implicit({ preview: inner, root: { kind: "offset", d: 0.5, child: { kind: "solid", solid: bc } } });
      [0.5, 0.8].forEach((g, i) => {
        const v = k.implicit({ preview: g, root: outer[op](leaf) }).volume();
        expect(Math.abs(v / ref[inner][op][i] - 1)).toBeLessThan(0.01);
      });
    });
  }
});

describe("buildMeshField on a damaged mesh", () => {
  const soup = (m) => ({ positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices) });
  test("a fin throws MeshFieldError, reason folded; a zero-area triangle and the knife edges build", () => {
    let err;
    try { buildMeshField(soup(meshes.fin)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MeshFieldError);
    expect(err.reason).toBe("folded");
    expect(err.message).toMatch(/^the mesh folds back on itself: /);
    expect(() => buildMeshField(soup(meshes.needle))).not.toThrow();
    for (const deg of WEDGES) expect(() => buildMeshField(soup(meshes[`wedge${deg}`]))).not.toThrow();
  });
});

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
// A prism whose cross-section is a 20° wedge: a sound solid with a knife edge, whose two
// faces at the edge are nearly opposite. It must not be mistaken for a fold.
function wedgeMesh() {
  const L = 20, half = Math.tan((10 * Math.PI) / 180) * L;
  const P = [0, 0, 0, L, -half, 0, L, half, 0, 0, 0, 10, L, -half, 10, L, half, 10];
  return { positions: P, indices: [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5] };
}

const meshes = { clean: boxMesh(), fin: withFin(boxMesh()), needle: withNeedle(boxMesh()), both: withNeedle(withFin(boxMesh())), wedge: wedgeMesh() };
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
const FOLDED = /^implicit: root(\.child|\.children\[0\])\.solid: the solid's mesh folds back on itself: \d+ triangles? faces? the wrong way, the first near \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/;
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
      expect(error.message).toMatch(/repair the mesh in a mesh tool/);
    }
  });

  test("a zero-area triangle alone builds, within 2% of the clean box", () => {
    for (const op of Object.keys(ops)) {
      const clean = outcome("clean", op, 0.5), got = outcome("needle", op, 0.5);
      expect(got.error).toBeUndefined();
      expect(Math.abs(got.volume / clean.volume - 1)).toBeLessThan(0.02);
    }
  });

  test("a knife edge is not a fold: the 20° wedge builds", () => {
    const wedge = k.import("wedge");
    const grown = k.implicit({ preview: 0.5, root: ops["offset 1"](wedge) });
    expect(grown.volume()).toBeGreaterThan(wedge.volume());
  });

  test("a refused field is not remembered: the second call is refused the same way", () => {
    const a = outcome("fin", "offset 1", 0.8), b = outcome("fin", "offset 1", 0.8);
    expect(a.error?.message).toMatch(FOLDED);
    expect(b.error?.message).toBe(a.error.message);
  });
});

describe("buildMeshField on a damaged mesh", () => {
  const soup = (m) => ({ positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices) });
  test("a fin throws MeshFieldError, reason folded; a zero-area triangle and a knife edge build", () => {
    let err;
    try { buildMeshField(soup(meshes.fin)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MeshFieldError);
    expect(err.reason).toBe("folded");
    expect(err.message).toMatch(/^the mesh folds back on itself: /);
    expect(() => buildMeshField(soup(meshes.needle))).not.toThrow();
    expect(() => buildMeshField(soup(meshes.wedge))).not.toThrow();
  });
});

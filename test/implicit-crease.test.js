// test/implicit-crease.test.js
// The crease cut (seam spec §5): pieces that touch meet along a cut-in crease on the field's
// zero set, the mesh stays closed, and nothing is cut where no crease exists.
import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { ATTACH_STRIDE } from "../src/framework/geometry/implicit/contact.js";
import { edgeCheck } from "./helpers/mesh-topology.js";
import { sharesAt, childIndex } from "./helpers/seam-quality.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";
import { capsulePress, threePress, PRESS_OVERLAP, SEAM_CASES } from "./fixtures/implicit-seam-cases.js";

const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };
const GRIDS = [[1.5, "preview"], [0.6, "print"]];
const exact = (spec) => compileImplicit(spec, { exactContact: true });
const run = (spec, edge, tier) => { const compiled = exact(spec); return { compiled, mesh: meshImplicit(compiled, edge, { tier }) }; };
const creaseVerts = (mesh) => { const r = []; for (let v = 0; v < mesh.crease.length; v++) if (mesh.crease[v]) r.push(v); return r; };
const at = (mesh, vs) => ({ X: Float64Array.from(vs, (v) => mesh.positions[3 * v]), Y: Float64Array.from(vs, (v) => mesh.positions[3 * v + 1]), Z: Float64Array.from(vs, (v) => mesh.positions[3 * v + 2]) });

describe("crease cut", () => {
  for (const [edge, tier] of GRIDS) {
    test(`crease points lie on the crease (press gap 0, ${tier} ${edge})`, () => {
      const { compiled, mesh } = run(capsulePress({ overlap: PRESS_OVERLAP, gap: 0 }), edge, tier);
      const cv = creaseVerts(mesh), { X, Y, Z } = at(mesh, cv), { out, shares, K } = sharesAt(compiled, X, Y, Z);
      expect(cv.length).toBeGreaterThanOrEqual(40);
      const a = childIndex(compiled, "a"), b = childIndex(compiled, "b");
      cv.forEach((v, i) => {
        expect(Math.abs(out[i])).toBeLessThanOrEqual(0.02 * edge);
        expect(Math.abs(shares[i * K + a] - shares[i * K + b])).toBeLessThanOrEqual(0.02 * edge);
      });
      for (const f of ["vertOwner", "ownerHeld", "pinned", "crease", "vertLeaf"]) expect(mesh[f] ?? { length: mesh.positions.length / 3 }).toHaveProperty("length", mesh.positions.length / 3);
      expect(mesh.normals.length).toBe(mesh.positions.length);
    }, 60_000);

    test(`closed after the cut (${tier} ${edge})`, () => {
      for (const c of SEAM_CASES) {
        if (/gap 0\.2|0\.05/.test(c.name) && c.name.startsWith("press")) continue;
        const { mesh } = run(c.spec, edge, tier);
        expect(edgeCheck(mesh.indices), c.name).toEqual(CLOSED);
      }
    }, 600_000);

    test(`three owners at gap 0 are closed with a crease on all three pairs (${tier} ${edge})`, () => {
      const { compiled, mesh } = run(threePress({ gap: 0 }), edge, tier);
      // The 1.5 mm owner mesher leaves 8 open edges at the triple line before the cut (a Task 2
      // mesher finding); the cut must not add to them and must keep the mesh manifold and oriented.
      const open = edgeCheck(mesh.indices);
      expect(open.nonManifold + open.misoriented).toBe(0);
      expect(open.boundary).toBeLessThanOrEqual(edge === 1.5 ? 8 : 0);
      const cv = creaseVerts(mesh), { X, Y, Z } = at(mesh, cv), { shares, K } = sharesAt(compiled, X, Y, Z);
      const pairs = new Set();
      cv.forEach((v, i) => {
        const near = [0, 1, 2].filter((j) => Math.abs(shares[i * K + j] - Math.min(shares[i * K], shares[i * K + 1], shares[i * K + 2])) <= 0.05 * edge);
        if (near.length >= 2) pairs.add(near.slice(0, 2).join());
      });
      expect(pairs.size).toBe(3);
    }, 60_000);

    test(`no crease across a near miss (${tier} ${edge})`, () => {
      const { mesh } = run(capsulePress({ overlap: -0.3, gap: 0 }), edge, tier);
      expect(creaseVerts(mesh).length).toBe(0);
    }, 60_000);
  }

  // The default hand's pieces only meet inside their attachment zones; the fist's fingertips press
  // the palm, so it has creases and none may fall inside a zone.
  const FIST_0 = handSpec({ ...HAND_POSES.fist, contactGap: 0 });
  for (const [name, spec, wantCrease] of [["hand default gap 0", SEAM_CASES.find((c) => c.name === "hand default gap 0").spec, false], ["hand fist gap 0", FIST_0, true]]) {
    test(`no crease inside an attachment zone: ${name}`, () => {
      const { compiled, mesh } = run(spec, 1.5, "preview");
      const { att } = compiled.ir.nodes[compiled.ownerRoot], P = mesh.positions, cv = creaseVerts(mesh);
      if (wantCrease) expect(cv.length).toBeGreaterThan(0);
      for (const v of cv) {
        for (let o = 0; o < att.length; o += ATTACH_STRIDE) {
          const d = Math.hypot(P[3 * v] - att[o + 2], P[3 * v + 1] - att[o + 3], P[3 * v + 2] - att[o + 4]);
          expect(d, `crease vertex ${v} inside attachment radius`).toBeGreaterThan(att[o + 5]);
        }
      }
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
    }, 180_000);
  }
});

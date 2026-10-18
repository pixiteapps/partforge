// test/implicit-crease.test.js
// The crease cut (seam spec §5): pieces that touch meet along a cut-in crease on the field's
// zero set, the mesh stays closed, and nothing is cut where no crease exists.
import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { attachWeight, ATTACH_STRIDE } from "../src/framework/geometry/implicit/contact.js";
import { edgeCheck } from "./helpers/mesh-topology.js";
import { sharesAt, childIndex, flippedTriangles } from "./helpers/seam-quality.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";
import { capsulePress, threePress, fingersOnPalm, PRESS_OVERLAP, SEAM_CASES } from "./fixtures/implicit-seam-cases.js";

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
      for (const f of ["vertOwner", "ownerHeld", "pinned", "crease"]) {
        expect(mesh[f], f).toBeDefined();
        expect(mesh[f].length, f).toBe(mesh.positions.length / 3);
      }
      expect(mesh.normals.length).toBe(mesh.positions.length);
    }, 60_000);

    test(`closed after the cut (${tier} ${edge})`, () => {
      for (const c of SEAM_CASES) {
        const { mesh } = run(c.spec, edge, tier);
        expect(edgeCheck(mesh.indices), c.name).toEqual(CLOSED);
      }
    }, 600_000);

    test(`three owners at gap 0 have a crease on all three pairs (${tier} ${edge})`, () => {
      const { compiled, mesh } = run(threePress({ gap: 0 }), edge, tier);
      const cv = creaseVerts(mesh), { X, Y, Z } = at(mesh, cv), { shares, K } = sharesAt(compiled, X, Y, Z);
      const pairs = new Set();
      cv.forEach((v, i) => {
        const near = [0, 1, 2].filter((j) => Math.abs(shares[i * K + j] - Math.min(shares[i * K], shares[i * K + 1], shares[i * K + 2])) <= 0.05 * edge);
        if (near.length >= 2) pairs.add(near.slice(0, 2).join());
      });
      expect(pairs.size).toBe(3);
    }, 60_000);

    test(`three owners at gap 0 are closed (${tier} ${edge})`, () => {
      expect(edgeCheck(run(threePress({ gap: 0 }), edge, tier).mesh.indices)).toEqual(CLOSED);
    }, 60_000);

    for (const [name, spec] of [["press gap 0", capsulePress({ overlap: PRESS_OVERLAP, gap: 0 })], ["three owners gap 0", threePress({ gap: 0 })]]) {
      test(`no flipped triangles after the cut: ${name} (${tier} ${edge})`, () => {
        const { compiled, mesh } = run(spec, edge, tier);
        expect(flippedTriangles(compiled, mesh, edge)).toBe(0);
      }, 60_000);
    }

    // Triangles above the palm (z >= 9) that cross the finger gap's bisector x = offset.
    const bridging = (mesh, offset) => {
      const P = mesh.positions, I = mesh.indices;
      let n = 0;
      for (let t = 0; t < I.length; t += 3) {
        const xs = [0, 1, 2].map((k) => P[3 * I[t + k]] - offset), zs = [0, 1, 2].map((k) => P[3 * I[t + k] + 2]);
        if (Math.min(...zs) >= 9 && Math.min(...xs) < -0.02 && Math.max(...xs) > 0.02) n++;
      }
      return n;
    };
    test(`fingers on a palm never bridge the finger gap (${tier} ${edge})`, () => {
      for (const fingerGap of [0.1, 0.3, 0.6]) for (const offset of [0, 0.37]) {
        const { mesh } = run(fingersOnPalm({ gap: 0, fingerGap, offset }), edge, tier);
        expect(bridging(mesh, offset), `gap ${fingerGap} offset ${offset}`).toBe(0);
      }
    }, 120_000);

    test(`fingers on a palm, finger gap 0.3, are closed (${tier} ${edge})`, () => {
      const { mesh } = run(fingersOnPalm({ gap: 0, fingerGap: 0.3 }), edge, tier);
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      expect(bridging(mesh, 0)).toBe(0);
    }, 60_000);

    test(`no crease across a near miss (${tier} ${edge})`, () => {
      const { mesh } = run(capsulePress({ overlap: -0.3, gap: 0 }), edge, tier);
      expect(creaseVerts(mesh).length).toBe(0);
    }, 60_000);
  }

  // Wherever a pair's own attachment weight is above 0 its two pieces are one owner: no crease may
  // lie there. A crease vertex must lie where two pieces whose shares make the field (to within
  // the crease tolerance) are NOT attached there. (Inside two digits' webs the palm's share ties
  // with both, so "the owner and the next least share" is no way to name the crease's pair.) The
  // fist's fingertips press the palm, so it has creases to check.
  test("no crease where the crossing pair's attachment weight is > 0: hand fist gap 0", () => {
    const { compiled, mesh } = run(handSpec({ ...HAND_POSES.fist, contactGap: 0 }), 1.5, "preview");
    const { att } = compiled.ir.nodes[compiled.ownerRoot], P = mesh.positions, cv = creaseVerts(mesh);
    expect(cv.length).toBeGreaterThan(0);
    const { out, shares, K } = sharesAt(compiled, ...["X", "Y", "Z"].map((_, k) => Float64Array.from(cv, (v) => P[3 * v + k])));
    const weight = (X, Y, v) => {
      let w = 0;
      for (let o = 0; o < att.length; o += ATTACH_STRIDE) {
        if ((att[o] === X && att[o + 1] === Y) || (att[o] === Y && att[o + 1] === X)) w = Math.max(w, attachWeight(att, o, P[3 * v], P[3 * v + 1], P[3 * v + 2]));
      }
      return w;
    };
    let attachedPairsSeen = 0;
    cv.forEach((v, i) => {
      const making = [];   // the pieces whose shares make the field at the crease vertex
      for (let j = 0; j < K; j++) if (Math.abs(shares[i * K + j] - out[i]) <= 0.005 * 1.5) making.push(j);
      expect(making.length, `crease vertex ${v}`).toBeGreaterThanOrEqual(2);
      let unattached = false;
      for (let a = 0; a < making.length; a++) for (let b = a + 1; b < making.length; b++) {
        if (weight(making[a], making[b], v) === 0) unattached = true; else attachedPairsSeen++;
      }
      expect(unattached, `crease vertex ${v}`).toBe(true);
    });
    expect(attachedPairsSeen).toBeGreaterThan(0);   // the check meets attached pairs, so it is not vacuous
    expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
  }, 180_000);
});

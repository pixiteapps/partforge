// test/implicit-cleanup.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh, CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { edgeCheck, eulerChar } from "./helpers/mesh-topology.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const minAngles = (P, T) => {
  const out = [];
  for (let t = 0; t < T.length; t += 3) {
    const v = [0, 1, 2].map((c) => [P[3 * T[t + c]], P[3 * T[t + c] + 1], P[3 * T[t + c] + 2]]);
    let m = Math.PI;
    for (let c = 0; c < 3; c++) {
      const a = v[c], b = v[(c + 1) % 3], d = v[(c + 2) % 3];
      const u = b.map((x, i) => x - a[i]), w = d.map((x, i) => x - a[i]);
      const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
      m = Math.min(m, Math.acos(Math.max(-1, Math.min(1, cos))));
    }
    out.push(m);
  }
  return out.sort((a, b) => a - b);
};

describe("cleanup", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: topology kept, slivers gone, vertices on the surface, triangles better`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      const edge = 0.8, store = sampleField(c, edge), raw = meshStore(store);
      const out = cleanupMesh(store, raw);
      expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      expect(eulerChar(out.positions, out.indices)).toBe(eulerChar(raw.positions, raw.indices));
      // A bend's branch cut makes the field discontinuous; "distance to the surface" means nothing
      // within a cell of the jump (the bendCut tree puts it inside the rounded surface on purpose).
      const nearJump = (x, y, z, d) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .some(([a, b, e]) => Math.abs(evalReference(c, x + a * edge, y + b * edge, z + e * edge) - d) > 4 * edge);
      let worst = 0, skipped = 0;
      for (let v = 0; v < out.positions.length / 3; v++) {
        const x = out.positions[3 * v], y = out.positions[3 * v + 1], z = out.positions[3 * v + 2], d = evalReference(c, x, y, z);
        if (nearJump(x, y, z, d)) { skipped++; continue; }
        worst = Math.max(worst, Math.abs(d));
      }
      // The skipped share moves with the grid's phase against the cut, not with cleanup: bendCut
      // measured 0.075–0.109 over edges 0.6–1.0 (0.103 at 0.8 once round pads by r / G). Bound 0.12.
      expect(skipped).toBeLessThan(0.12 * (out.positions.length / 3));
      expect(worst).toBeLessThan(0.05 * edge);
      const before = minAngles(raw.positions, raw.indices), after = minAngles(out.positions, out.indices);
      expect(after[Math.floor(after.length * 0.05)]).toBeGreaterThan(before[Math.floor(before.length * 0.05)]);
      expect(out.normals.length).toBe(out.positions.length);
    });
  }
  test("deterministic: two runs are byte-identical", () => {
    const c = lowerSpec(TREES.blobs, { images: new Map() });
    const run = () => { const s = sampleField(c, 0.8); return cleanupMesh(s, meshStore(s)); };
    const a = run(), b = run();
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
  test("defaults are the documented ones", () => {
    expect(CLEANUP).toEqual({ collapseFrac: 0.2, relaxPasses: 2, relaxWeight: 0.5, maxMoveCells: 0.5 });
  });
});

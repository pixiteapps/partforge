// test/implicit-seam-quality.test.js
// The seam gate (seam spec "Testing", the plan's Global Constraints): on every seam fixture,
// at the preview (1.5 mm) and print (0.6 mm) grids, the owner-meshed contact has no flipped
// triangle, no more folds than the plain mesher on the same exact field, is closed, manifold
// and oriented, has no zero-volume component, and never crosses a near miss's bisector.
import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { ATTACH_STRIDE } from "../src/framework/geometry/implicit/contact.js";
import { edgeCheck, componentCount } from "./helpers/mesh-topology.js";
import { flippedTriangles, seamFolds, childIndex, sharesAt, gapHolds, worldAttachments, ownerFrame, creaseInAttachment } from "./helpers/seam-quality.js";
import { xformPoint } from "../src/framework/geometry/implicit/frames.js";
import { evalNodeAt } from "../src/framework/geometry/implicit/reference.js";
import { hypot3 } from "../src/framework/geometry/js-math.js";
import { capsulePress, threePress, PRESS_OVERLAP, SEAM_CASES, GATE_EXTRA_CASES, MOVED_CASES, fingerAttached } from "./fixtures/implicit-seam-cases.js";

const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };
const GRIDS = [[1.5, "preview"], [0.6, "print"]];

// Each case is meshed once per grid (owners and the plain baseline), shared by its tests.
const cache = new Map();
function meshed(c, edge, tier) {
  const key = `${c.name}@${edge}`;
  if (!cache.has(key)) {
    const compiled = compileImplicit(c.spec);
    cache.set(key, { compiled, mesh: meshImplicit(compiled, edge, { tier }), baseline: meshImplicit(compiled, edge, { tier, owners: false }) });
  }
  return cache.get(key);
}

/** Signed volume of each connected component (triangles joined through shared vertices). */
function componentVolumes(P, I) {
  const nv = P.length / 3, parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < I.length; t += 3) {
    const r = find(I[t]);
    for (let k = 1; k < 3; k++) { const s = find(I[t + k]); if (s !== r) parent[s] = r; }
  }
  const vol = new Map();
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const v = P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    const r = find(I[t]);
    vol.set(r, (vol.get(r) ?? 0) + v / 6);
  }
  return [...vol.values()];
}

/**
 * Triangles crossing the bisector of the near-miss pair (labels a, b): corners on both sides
 * of d_a = d_b (the pieces' raw values, evalNodeAt), every corner nearer a or b than any other
 * piece. One whose centroid lies inside both pieces' attachment zones is let off only when it
 * lies on the surface (|field| ≤ WEB_TOL there): neighbouring digits web together at the palm,
 * but a triangle across air between them is a bridge wherever it is.
 */
function bisectorCrossings(compiled, mesh, a, b) {
  const P = mesh.positions, I = mesh.indices, nv = P.length / 3;
  const ia = childIndex(compiled, a), ib = childIndex(compiled, b);
  const node = compiled.ir.nodes[compiled.ownerRoot], att = worldAttachments(compiled), ids = node.children;   // P is world
  // Raw child distances, so the classification never depends on the mesher's own labels.
  const X = new Float64Array(nv), Y = new Float64Array(nv), Z = new Float64Array(nv);
  for (let v = 0; v < nv; v++) { X[v] = P[3 * v]; Y[v] = P[3 * v + 1]; Z[v] = P[3 * v + 2]; }
  const raw = ids.map((id) => rawAt(compiled, id, X, Y, Z));
  const side = new Int8Array(nv);
  for (let v = 0; v < nv; v++) {
    const da = raw[ia][v], db = raw[ib][v];
    let nearest = true;
    for (let k = 0; k < ids.length; k++) if (k !== ia && k !== ib && raw[k][v] < Math.min(da, db)) nearest = false;
    side[v] = nearest ? Math.sign(da - db) : 0;
  }
  const inZone = (o, q) => hypot3(q[0] - att[o + 2], q[1] - att[o + 3], q[2] - att[o + 4]) < att[o + 5] + att[o + 6];
  const zoneOf = (k, q) => { for (let o = 0; o < att.length; o += ATTACH_STRIDE) if ((att[o] === k || att[o + 1] === k) && inZone(o, q)) return true; return false; };
  const webbed = [];
  let n = 0;
  for (let t = 0; t < I.length; t += 3) {
    const s = [side[I[t]], side[I[t + 1]], side[I[t + 2]]];
    if (s.includes(0) || !(s.includes(1) && s.includes(-1))) continue;
    const q = [0, 1, 2].map((k) => (P[3 * I[t] + k] + P[3 * I[t + 1] + k] + P[3 * I[t + 2] + k]) / 3);
    if (zoneOf(ia, q) && zoneOf(ib, q)) webbed.push(...q); else n++;
  }
  if (webbed.length) {
    const { out } = sharesAt(compiled, Float64Array.from(webbed.filter((_, i) => i % 3 === 0)), Float64Array.from(webbed.filter((_, i) => i % 3 === 1)), Float64Array.from(webbed.filter((_, i) => i % 3 === 2)));
    for (const f of out) if (Math.abs(f) > WEB_TOL) n++;
  }
  return n;
}

// A child node's raw value at the (world) points: evalNodeAt reads a child in its parent's frame,
// so each point is first carried into the owner root's frame (identity unless the root is moved).
function rawAt(compiled, id, X, Y, Z) {
  const M = ownerFrame(compiled), q = [0, 0, 0];
  return Float64Array.from(X, (x, v) => { xformPoint(q, M, x, Y[v], Z[v]); return evalNodeAt(compiled, id, q[0], q[1], q[2]); });
}

/** A webbed triangle's centroid is on the surface within this (mm); a bridge across the 0.75 mm near miss sits far above it. */
const WEB_TOL = 0.1;
const NEAR_MISS = {
  "near miss 0.3 gap 0": ["a", "b"], "hand nearMiss gap 0": ["index", "middle"], "hand nearMiss gap 0.2": ["index", "middle"],
  "hand nearMiss gap 0 (palm last)": ["index", "middle"], "fingers on palm 0.3": ["a", "b"], "fingers on palm 0.3 offset 0.37": ["a", "b"],
  "hand nearMiss gap 0.2 (moved root)": ["index", "middle"],
};
// The seam fixtures, the hand with its palm listed last (a part may list its hub after its
// digits), two fingers 0.3 mm apart pressing a palm, and parts moved off the origin through
// their root (an `at` over a rotated frame), whose attachment anchors live in a non-world frame.
const GATE_CASES = [...SEAM_CASES, ...GATE_EXTRA_CASES, ...MOVED_CASES];

describe("seam gate", () => {
  for (const [edge, tier] of GRIDS) {
    for (const c of GATE_CASES) {
      describe(`${c.name} (${tier} ${edge})`, () => {
        test("no flipped triangles", () => {
          const { compiled, mesh } = meshed(c, edge, tier);
          expect(flippedTriangles(compiled, mesh, edge)).toBe(0);
        }, 600_000);
        test("folds no more than the plain mesher's", () => {
          const { mesh, baseline } = meshed(c, edge, tier);
          expect(seamFolds(mesh)).toBeLessThanOrEqual(seamFolds(baseline));
        }, 600_000);
        test("no crease inside an attachment", () => {
          // Every crease vertex has two pieces making the field there that are NOT attached at it.
          const { compiled, mesh } = meshed(c, edge, tier);
          const { attachedOnly, unmade } = creaseInAttachment(compiled, mesh, edge);
          expect(attachedOnly).toBe(0);
          expect(unmade).toBe(0);
        }, 600_000);
        test("closed, manifold, oriented", () => {
          expect(edgeCheck(meshed(c, edge, tier).mesh.indices)).toEqual(CLOSED);
        }, 600_000);
        test("no zero-volume component", () => {
          const { mesh } = meshed(c, edge, tier);
          const tiny = componentVolumes(mesh.positions, mesh.indices).filter((v) => Math.abs(v) < 1e-6);
          expect(tiny).toEqual([]);
        }, 600_000);
        if ((c.spec.root.gap ?? 0) > 0) test("every gap holds outside the attachment zones", () => {
          // No triangle joins two pieces that are not attached at its centroid, and no vertex of
          // one piece comes nearer another (not attached there) than the gap, to 0.01 mm.
          const { compiled, mesh } = meshed(c, edge, tier);
          const { spans, shortfall } = gapHolds(compiled, mesh, c.spec.root.gap);
          expect(spans).toBe(0);
          expect(shortfall).toBeLessThanOrEqual(0.01);
        }, 600_000);
        if (NEAR_MISS[c.name]) test("no triangle crosses the near miss's bisector", () => {
          const { compiled, mesh } = meshed(c, edge, tier);
          expect(bisectorCrossings(compiled, mesh, ...NEAR_MISS[c.name])).toBe(0);
        }, 600_000);
      });
    }

    test(`a moved root cuts the attached finger as the unmoved one does (${tier} ${edge})`, () => {
      // fingerAttached's every crossing is inside its attachment: no crease, wherever the part sits.
      const at = MOVED_CASES.find((m) => m.name === "finger attached (moved root)");
      const moved = meshed(at, edge, tier), still = meshImplicit(compileImplicit(fingerAttached()), edge, { tier });
      expect(still.crease.reduce((s, x) => s + x, 0)).toBe(0);
      expect(moved.mesh.crease.reduce((s, x) => s + x, 0)).toBe(0);
      // The engine's world-space table is the node table carried through the root's transforms.
      const node = moved.compiled.ir.nodes[moved.compiled.ownerRoot], W = worldAttachments(moved.compiled);
      expect(node.attWorld.length).toBe(W.length);
      node.attWorld.forEach((v, i) => expect(Math.abs(v - W[i]), `attWorld[${i}]`).toBeLessThan(1e-9));
      expect(Math.abs(node.att[2] - W[2]) + Math.abs(node.att[3] - W[3]) + Math.abs(node.att[4] - W[4])).toBeGreaterThan(1);   // really moved
    }, 600_000);

    test(`gap-0 contacts stay one piece (${tier} ${edge})`, () => {
      for (const spec of [capsulePress({ overlap: PRESS_OVERLAP, gap: 0 }), threePress({ gap: 0 })]) {
        const mesh = meshImplicit(compileImplicit(spec), edge, { tier });
        expect(componentCount(mesh.indices)).toBe(1);
      }
    }, 600_000);
  }
});

// The Manifold kernel's mesh field memo (manifold-backend.js meshFieldOf): k.implicit's
// `solid` leaf fields by solid hash, bounded by count AND by estimated bytes (270 per
// triangle). The least recently used field goes first; a field over the budget is built
// and returned but not kept; an evicted field is built again when it is needed again.
// Each test counts builds by wrapping the installed builder, and restores it after.
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { loadFullCore } from "../src/framework/core/core.js";
import { loadMeshFieldBuilder, meshFieldBuilder } from "../src/framework/geometry/implicit/mesh-field-loader.js";
import { installMeshFieldBuilder } from "../src/framework/geometry/implicit/mesh-field-slot.js";

const PER_TRI = 270;
let wasm, original, builds;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
  await loadFullCore();
  await loadMeshFieldBuilder();
  original = meshFieldBuilder();
});
const counting = () => { builds = 0; installMeshFieldBuilder((mesh) => { builds++; return original(mesh); }); };
afterEach(() => installMeshFieldBuilder(original));

const leaf = (solid) => ({ kind: "solid", solid });
const trisOf = (solid) => original(solid.toMesh()).tris;

describe("the mesh field memo", () => {
  test("evicts by bytes, least recently used first, and rebuilds an evicted field", () => {
    const probe = createManifoldKernel(wasm);
    const a = probe.sphere(16), b = probe.box({ min: [0, 0, 0], max: [4, 4, 4] }), c = probe.sphere(17);
    const [ta, tb, tc] = [a, b, c].map(trisOf);
    // Room for a and b together, and for b and c together, but not for all three.
    const budget = (Math.max(ta, tc) + tb) * PER_TRI;
    expect((ta + tb + tc) * PER_TRI).toBeGreaterThan(budget);
    const k = createManifoldKernel(wasm, { meshFieldBudget: budget });
    counting();
    const [sa, sb, sc] = [k.sphere(16), k.box({ min: [0, 0, 0], max: [4, 4, 4] }), k.sphere(17)];
    k.implicitFrames({ root: leaf(sa) });
    k.implicitFrames({ root: leaf(sb) });
    expect(builds).toBe(2);
    expect(k._meshFieldMemo()).toEqual({ entries: 2, bytes: (ta + tb) * PER_TRI });
    k.implicitFrames({ root: leaf(sb) });   // a hit: b is now the most recently used
    k.implicitFrames({ root: leaf(sa) });   // a hit: a is now the most recently used
    expect(builds).toBe(2);
    k.implicitFrames({ root: leaf(sc) });   // c does not fit beside both: b (least recent) goes first, then a
    expect(builds).toBe(3);
    expect(k._meshFieldMemo().bytes).toBeLessThanOrEqual(budget);
    expect(k._meshFieldMemo()).toEqual({ entries: 1, bytes: tc * PER_TRI });
    // a was evicted: it is built again, and its solid is the same as a fresh kernel's.
    const again = k.implicit({ root: leaf(sa), preview: 1 });
    expect(builds).toBe(4);
    const fresh = createManifoldKernel(wasm).implicit({ root: leaf(createManifoldKernel(wasm).sphere(16)), preview: 1 });
    expect(again._hash).toBe(fresh._hash);
    expect(again.toMesh().positions).toEqual(fresh.toMesh().positions);
  });

  test("a field larger than the budget is built and returned, but not kept", () => {
    const probe = createManifoldKernel(wasm);
    const big = trisOf(probe.sphere(20)), small = trisOf(probe.box({ min: [0, 0, 0], max: [4, 4, 4] }));
    const k = createManifoldKernel(wasm, { meshFieldBudget: (big - 1) * PER_TRI });
    counting();
    k.implicitFrames({ root: leaf(k.box({ min: [0, 0, 0], max: [4, 4, 4] })) });
    const s = k.sphere(20), solid = k.implicit({ root: leaf(s), preview: 2 });
    expect(solid.toMesh().positions.length).toBeGreaterThan(0);
    expect(builds).toBe(2);
    // Not kept, and it evicted nothing to make room.
    expect(k._meshFieldMemo()).toEqual({ entries: 1, bytes: small * PER_TRI });
    k.implicitFrames({ root: leaf(s) });
    expect(builds).toBe(3);
  });

  test("a spec that uses one solid twice builds its field once", () => {
    const k = createManifoldKernel(wasm, { meshFieldBudget: 1 });   // nothing is kept
    counting();
    const s = k.sphere(16);
    k.implicit({ root: { kind: "union", k: 2, children: [leaf(s), { kind: "offset", d: 1, child: leaf(s) }] }, preview: 2 });
    expect(builds).toBe(1);
    const roomy = createManifoldKernel(wasm);
    counting();
    const t = roomy.sphere(16);
    roomy.implicit({ root: { kind: "union", k: 2, children: [leaf(t), leaf(t)] }, preview: 2 });
    expect(builds).toBe(1);
    expect(roomy._meshFieldMemo().entries).toBe(1);
  });

  test("dropCache empties the memo", () => {
    const k = createManifoldKernel(wasm);
    k.implicitFrames({ root: leaf(k.sphere(16)) });
    expect(k._meshFieldMemo().entries).toBe(1);
    k.dropCache();
    expect(k._meshFieldMemo()).toEqual({ entries: 0, bytes: 0 });
  });
});

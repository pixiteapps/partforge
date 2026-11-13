// test/manifold-cache.test.js
import { beforeAll, beforeEach, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { meshVolume, bboxSize } from "../src/framework/oracle/mesh.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
beforeEach(() => k.resetCacheStats());

// Two-boundary build: a flanged barrel (union) bored through (cut). `bore` feeds
// only the cut, so changing it must HIT the union and MISS only the cut.
const barrel = (od, h, flangeD, flangeH, boreR) => {
  let s = k.union([k.cylinder({ r: od / 2, h }), k.cylinder({ r: flangeD / 2, h: flangeH })]);
  return s.cut(k.cylinder({ r: boreR, h: h + 4 }).translate([0, 0, -2]));
};

test("an identical rebuild is all hits, zero new misses", () => {
  k.beginSubPart("x"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  const first = k.cacheStats().misses;
  expect(first).toBeGreaterThan(0); // union + cut were computed cold

  k.resetCacheStats();
  k.beginSubPart("x"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(0);  // nothing recomputed
  expect(k.cacheStats().hits).toBeGreaterThan(0);
});

test("changing a late-stage param resumes — union hits, only the cut misses", () => {
  k.beginSubPart("y"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  k.resetCacheStats();
  k.beginSubPart("y"); barrel(8, 10, 16, 2, 2.1).toMesh(); k.endSubPart(); k.cleanup(); // bore changed only
  // The primitives are cache nodes too (their run ids must outlive a build for face
  // provenance): the two union cylinders and the union hit; the new bore cylinder
  // and the cut miss.
  expect(k.cacheStats()).toEqual({ hits: 3, misses: 2 });
});

test("a cached-resume mesh equals a cold-built mesh", async () => {
  k.beginSubPart("z"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  k.beginSubPart("z"); const resumed = barrel(8, 10, 16, 2, 2.1).toMesh(); k.endSubPart(); k.cleanup();

  // Cold reference on a fresh kernel (no cache history).
  const m2 = await freshKernel().then((kk) => { const r = kk.barrel(2.1); return r; });
  expect(meshVolume(resumed.positions)).toBeCloseTo(m2.vol, 1);
  bboxSize(resumed.positions).forEach((s, i) => expect(s).toBeCloseTo(m2.bbox[i], 2));

  async function freshKernel() {
    const kk = await bootManifoldKernel();
    return {
      barrel: (boreR) => {
        let s = kk.union([kk.cylinder({ r: 4, h: 10 }), kk.cylinder({ r: 8, h: 2 })]);
        const mesh = s.cut(kk.cylinder({ r: boreR, h: 14 }).translate([0, 0, -2])).toMesh();
        const vol = meshVolume(mesh.positions), bbox = bboxSize(mesh.positions);
        kk.cleanup();
        return { vol, bbox };
      },
    };
  }
});

test("determinism guard: building the same thing twice yields the same final hash", () => {
  const a = barrel(8, 10, 16, 2, 1.7)._hash;
  const b = barrel(8, 10, 16, 2, 1.7)._hash;
  expect(a).toBe(b);
});

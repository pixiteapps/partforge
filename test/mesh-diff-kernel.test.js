import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, bootOcctKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const meshOf = (s) => s.toIndexedMesh();

test("added material is measured and located", () => {
  const before = meshOf(k.cylinder({ d: 10, h: 10 }));
  const after = meshOf(k.cylinder({ d: 10, h: 10 }).union(k.cylinder({ d: 4, h: 4 }).at([0, 0, 10])));
  const d = k._meshDiff(before, after);
  expect(d.ok).toBe(true);
  expect(d.removedMm3).toBeLessThan(0.5);
  expect(d.addedMm3).toBeGreaterThan(40); // π·2²·4 ≈ 50
  expect(d.added[0].at[2]).toBeGreaterThan(10);
  k.cleanup();
});

test("removed material lands in removed, split into components", () => {
  const plate = () => k.cylinder({ d: 40, h: 4 });
  const before = meshOf(plate());
  const after = meshOf(plate().cut(k.cylinder({ d: 4, h: 10 }).at([10, 0, -2])).cut(k.cylinder({ d: 4, h: 10 }).at([-10, 0, -2])));
  const d = k._meshDiff(before, after);
  expect(d.added).toEqual([]);
  expect(d.removed).toHaveLength(2);
  k.cleanup();
});

test("caps refuse rather than run", () => {
  const m = meshOf(k.cylinder({ d: 10, h: 10 }));
  expect(k._meshDiff(m, m, { maxTriangles: 10 })).toEqual({ ok: false, reason: "too-large" });
  k.cleanup();
});

test("OCCT solids expose a pose-free _baseHash", async () => {
  const o = await bootOcctKernel();
  const s = o.cylinder({ d: 10, h: 10 });
  expect(s.translate([5, 0, 0])._baseHash).toBe(s._baseHash);
  expect(s.translate([5, 0, 0])._hash).not.toBe(s._hash);
}, 60_000);

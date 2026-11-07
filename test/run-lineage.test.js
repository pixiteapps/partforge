// Per-run lineage on Manifold solids: every wrapper answers _runs() — the
// (originalID, runTransform) pairs its mesh carries — structurally, without
// materializing booleans or transforms, and the answer agrees with the mesh.
import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import {
  IDENTITY12, composeAffine, dedupeRuns, mirrorAffine, rotateAffine, runKey, scaleAffine, translateAffine,
} from "../src/framework/geometry/run-lineage.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const apply = (M, p) => [0, 1, 2].map((i) => M[i] * p[0] + M[3 + i] * p[1] + M[6 + i] * p[2] + M[9 + i]);
const close = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

// Every run the mesh carries must be one the lineage names.
const expectLineageCoversMesh = (solid) => {
  const keys = new Set(solid._runs().map((r) => runKey(r.id, r.mat)));
  const g = solid._m.getMesh();
  try {
    for (let r = 0; r < g.runOriginalID.length; r++) {
      const mat = g.runTransform?.length >= (r + 1) * 12 ? Array.from(g.runTransform.subarray(r * 12, r * 12 + 12)) : null;
      expect(keys.has(runKey(g.runOriginalID[r], mat))).toBe(true);
    }
  } finally {
    g.delete?.();
  }
};

test("affine constructors and composition follow the runTransform layout", () => {
  close(apply(translateAffine([1, 2, 3]), [1, 1, 1]), [2, 3, 4]);
  close(apply(rotateAffine(90, [1, 0, 0], [0, 0, 1]), [2, 0, 0]), [1, 1, 0]);
  close(apply(mirrorAffine([0, 0, 1]), [1, 2, 3]), [1, 2, -3]);
  close(apply(scaleAffine(2, [1, 1, 1]), [2, 2, 2]), [3, 3, 3]);
  const M = composeAffine(translateAffine([5, 0, 0]), rotateAffine(90, [0, 0, 0], [0, 0, 1]));
  close(apply(M, [1, 0, 0]), [5, 1, 0]); // inner (rotate) first, then outer (translate)
  expect(composeAffine(IDENTITY12, null)).toEqual(IDENTITY12);
  expect(runKey(4, null)).toBe(runKey(4, IDENTITY12));
  expect(runKey(4, [1, 0, 0, 0, 1, 0, 0, 0, 1, 1e-7, -1e-7, 0])).toBe(runKey(4, null));
  expect(dedupeRuns([{ id: 1, mat: null }, { id: 1, mat: IDENTITY12 }, { id: 2, mat: null }]))
    .toEqual([{ id: 1, mat: null }, { id: 2, mat: null }]);
});

test("a primitive has one identity run; a transform composes it", () => {
  const c = k.cylinder({ r: 2, h: 5 });
  expect(c._runs()).toEqual([{ id: expect.any(Number), mat: null }]);
  const t = c.translate([3, 0, 0]);
  expect(t._runs()[0].id).toBe(c._runs()[0].id);
  expect(runKey(t._runs()[0].id, t._runs()[0].mat)).toBe(runKey(c._runs()[0].id, translateAffine([3, 0, 0])));
});

test("a boolean keeps both operands' runs and lineage matches the mesh", () => {
  const tool = k.cylinder({ r: 2, h: 12 }).translate([5, 5, -1]);
  const body = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).cut(tool);
  const keys = new Set(body._runs().map((r) => runKey(r.id, r.mat)));
  const g = body._m.getMesh();
  for (let r = 0; r < g.runOriginalID.length; r++) {
    const mat = g.runTransform?.length >= (r + 1) * 12 ? Array.from(g.runTransform.subarray(r * 12, r * 12 + 12)) : null;
    expect(keys.has(runKey(g.runOriginalID[r], mat))).toBe(true);
  }
  g.delete?.();
});

test("two instances of one primitive are distinct runs", () => {
  // k.cylinder is not cached, so one primitive instanced twice is the shared-id case
  // (the same shape hoistBoolean produces when it collapses identical copies).
  const c = k.cylinder({ r: 1, h: 4 });
  const a = c.translate([2, 0, 0]);
  const b = c.translate([6, 0, 0]);
  expect(a._runs()[0].id).toBe(b._runs()[0].id);
  expect(runKey(a._runs()[0].id, a._runs()[0].mat)).not.toBe(runKey(b._runs()[0].id, b._runs()[0].mat));
});

test("a fillet adds blend runs and keeps the base's", () => {
  const base = k.box({ min: [0, 0, 0], max: [10, 10, 10] });
  const f = base.fillet(1);
  const baseIds = new Set(base._runs().map((r) => r.id));
  const ids = f._runs().map((r) => r.id);
  expect(ids.some((id) => baseIds.has(id))).toBe(true);
  expect(ids.some((id) => !baseIds.has(id))).toBe(true);
  expectLineageCoversMesh(f);
});

test("lineage matches the mesh through every transform and boolean", () => {
  const peg = k.cylinder({ r: 1, h: 6 });
  const solids = [
    k.box({ min: [1, 2, 3], max: [10, 10, 10] }),
    k.roundedBox({ size: [10, 10, 10], round: 1, center: true }),
    peg.rotate(30, [1, 2, 0], [1, 1, 0]),
    peg.rotateX(90).translate([0, 4, 0]),
    peg.mirror("XZ"),
    peg.scale(2, [1, 0, 0]),
    k.union([peg.translate([0, 0, 0]), peg.translate([3, 0, 0]), peg.translate([6, 0, 0])]),
    k.box({ min: [0, 0, 0], max: [8, 8, 2] }).cutAll([peg.translate([2, 2, -1]), peg.translate([6, 6, -1])]),
    k.box({ min: [0, 0, 0], max: [8, 8, 8] }).intersect(k.sphere(6).translate([4, 4, 4])),
    k.box({ min: [0, 0, 0], max: [8, 8, 8] }).cut(peg.translate([4, 4, -1])).translate([1, 1, 1]).rotateZ(45),
  ];
  for (const s of solids) expectLineageCoversMesh(s);
});

test("booleans and transforms answer _runs without materializing a mesh", () => {
  const peg = k.cylinder({ r: 1, h: 6 });
  const body = k.box({ min: [0, 0, 0], max: [8, 8, 2] })
    .cut(peg.translate([2, 2, -1])).union(k.sphere(1).translate([4, 4, 2])).rotateZ(30);
  const proto = Object.getPrototypeOf(body._m);
  const spy = vi.spyOn(proto, "getMesh");
  try {
    body._runs();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
  expect(body._runs()).toBe(body._runs()); // memoized
  expectLineageCoversMesh(body);
});

test("roundAll's restamp reports the id map it applied", () => {
  const plate = k.box({ min: [0, 0, 0], max: [20, 12, 4] });
  const r = plate.roundAll(0.5);
  expectLineageCoversMesh(r);
  expect(r._idMap).toBeInstanceOf(Map);
  const newIds = new Set(r._runs().map((x) => x.id));
  for (const id of r._idMap.values()) expect(newIds.has(id)).toBe(true);
  expect(new Set(r._idMap.values()).size).toBeGreaterThan(1); // base id plus blend ids
});

test("factory primitives answer _runs without materializing a mesh", () => {
  const sq = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const solids = [
    k.cylinder({ r: 2, h: 5 }),
    k.sphere(3),
    k.box({ min: [1, 2, 3], max: [10, 10, 10] }),
    k.roundedBox({ size: [10, 10, 10], round: 1, center: true }),
    k.roundedBox({ size: [10, 10, 10], round: 1 }),
    k.prism(sq, 3),
    k.extrude(sq, 3),
    k.revolve([[1, 0], [3, 0], [3, 2], [1, 2]]),
    k.loft([{ z: 0, polygon: sq }, { z: 4, polygon: sq }]),
  ];
  const proto = Object.getPrototypeOf(solids[0]._m);
  const spy = vi.spyOn(proto, "getMesh");
  let runs;
  try {
    runs = solids.map((s) => s._runs());
  } finally {
    spy.mockRestore();
  }
  expect(spy).not.toHaveBeenCalled();
  for (const r of runs) expect(r).toHaveLength(1);
  for (const s of solids) expectLineageCoversMesh(s);
});

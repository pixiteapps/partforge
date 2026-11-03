import { describe, it, expect, vi } from "vitest";
import {
  createDragGuard, COLLIDE_BAND_MM, COLLIDE_WEIGHT, MAX_ROWS, MAX_SUBSTEPS, SETTLE_BISECTIONS, COLLIDE_IN_SOLVE,
} from "../src/framework/collide/guard.js";
import { createCollisionWorld, poseMatrices } from "../src/framework/collide/world.js";
import { CONTACT_EPS } from "../src/framework/collide/pairs.js";
import { resolveParams } from "../src/framework/part-model.js";
import { collideBar, collideBarThrough, barMeshes } from "./fixtures/collide-bar.js";

// Meshes are hand-built in each sub-part's own frame (barMeshes), placed per params by
// poseMatrices: no kernel boots.
const matsAtFor = (part) => (params) => {
  const { p, d } = resolveParams(part, params);
  return poseMatrices(part, "assembly", p, d);
};

function setup(part, start, { meshes = barMeshes(part), clearance = CONTACT_EPS } = {}) {
  const world = createCollisionWorld({ meshes });
  const matsAt = matsAtFor(part);
  const guard = createDragGuard({ world, matsAt, start, moving: ["bar"], clearance });
  return { world, matsAt, guard };
}

const margin = CONTACT_EPS + COLLIDE_BAND_MM;

describe("drag guard constants", () => {
  it("exports the tuning values", () => {
    expect(COLLIDE_BAND_MM).toBe(2);
    expect(COLLIDE_WEIGHT).toBe(10);
    expect(MAX_ROWS).toBe(8);
    expect(MAX_SUBSTEPS).toBe(32);
    expect(SETTLE_BISECTIONS).toBeGreaterThan(0);
    expect(COLLIDE_IN_SOLVE).toBe(true);
  });
});

describe("drag guard rows", () => {
  it("rows are zero far from contact", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    guard.beginFrame({ angle: 0 });
    expect(guard.rowCount).toBe(0);
    expect(guard.rows({ angle: 0 }).length).toBe(0);
    // a row chosen near contact reads zero once the bar swings back up
    guard.beginFrame({ angle: 58 });
    guard.linearise({ angle: 58 });
    expect(guard.rowCount).toBe(1);
    expect([...guard.rows({ angle: 0 })]).toEqual([0]);
    world.dispose();
  });

  it("rows rise inside the band", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    guard.beginFrame({ angle: 58 });
    guard.linearise({ angle: 58 });
    const [r] = guard.rows({ angle: 58 });
    expect(r).toBeGreaterThan(0);
    expect(guard.rows({ angle: 59 })[0]).toBeGreaterThan(r);
    world.dispose();
  });

  it("rows match exact distances near the linearisation point", () => {
    const { guard, world, matsAt } = setup(collideBar, { angle: 0 });
    guard.beginFrame({ angle: 58 });
    guard.linearise({ angle: 58 });
    const [exact] = world.distances(matsAt({ angle: 58.5 }));
    const want = COLLIDE_WEIGHT * (margin - exact.distance);
    const [got] = guard.rows({ angle: 58.5 });
    expect(Math.abs(got - want) / want).toBeLessThan(0.02);
    world.dispose();
  });

  it("rowCount is fixed until the next beginFrame", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    guard.beginFrame({ angle: 58 });
    expect(guard.rowCount).toBe(1);
    guard.linearise({ angle: 20 });
    expect(guard.rowCount).toBe(1);
    expect(guard.rows({ angle: 20 }).length).toBe(1);
    world.dispose();
  });

  it("rows read matrices only, never the BVH", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    guard.beginFrame({ angle: 58 });
    guard.linearise({ angle: 58 });
    const spy = vi.spyOn(world, "distances");
    guard.rows({ angle: 58.3 });
    expect(spy).not.toHaveBeenCalled();
    world.dispose();
  });
});

describe("drag guard settle", () => {
  it("settle stops at the surface", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    const { params, blocked } = guard.settle({ angle: 0 }, { angle: 90 });
    expect(params.angle).toBeGreaterThanOrEqual(59.5);
    expect(params.angle).toBeLessThanOrEqual(60);
    expect([blocked.a, blocked.b].sort()).toEqual(["bar", "palm"]);
    expect(guard.isClear(params)).toBe(true);
    world.dispose();
  });

  it("settle passes in open air", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    expect(guard.settle({ angle: 0 }, { angle: 40 })).toEqual({ params: { angle: 40 }, blocked: null });
    world.dispose();
  });

  it("settle caps sub-steps and stops short", () => {
    // frame after frame, the drag catches up but never past first contact
    const { guard, world } = setup(collideBarThrough, { angle: 0 });
    let at = { angle: 0 }, blocked = null;
    for (let frame = 0; frame < 20 && !blocked; frame++) {
      const r = guard.settle(at, { angle: 180 });
      expect(r.params.angle).toBeLessThanOrEqual(60);
      at = r.params; blocked = r.blocked;
    }
    expect(blocked).not.toBeNull();
    expect(at.angle).toBeGreaterThan(59);
    world.dispose();

    // with no slab, 180° in one frame needs more than MAX_SUBSTEPS sub-steps: the drag lags
    const meshes = barMeshes(collideBarThrough);
    meshes.delete("palm");
    const free = setup(collideBarThrough, { angle: 0 }, { meshes });
    const r = free.guard.settle({ angle: 0 }, { angle: 180 });
    expect(r.blocked).toBeNull();
    expect(r.params.angle).toBeGreaterThan(0);
    expect(r.params.angle).toBeLessThan(180);
    free.world.dispose();
  });

  it("custom blend is used", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    const blend = vi.fn((t) => ({ angle: 90 * t }));
    const { params } = guard.settle({ angle: 0 }, { angle: 90 }, { blend });
    expect(blend).toHaveBeenCalled();
    for (const [t] of blend.mock.calls) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    expect(params.angle).toBeGreaterThanOrEqual(59.5);
    expect(params.angle).toBeLessThanOrEqual(60);
    world.dispose();
  });
});

describe("drag guard exemptions", () => {
  it("exempts a pair inside at begin", () => {
    const { guard, world } = setup(collideBar, { angle: 70 });
    expect(guard.settle({ angle: 70 }, { angle: 80 })).toEqual({ params: { angle: 80 }, blocked: null });
    expect(guard.settle({ angle: 70 }, { angle: 50 })).toEqual({ params: { angle: 50 }, blocked: null });
    // the pair opened past clearance on the way out: it can no longer move in
    const { params, blocked } = guard.settle({ angle: 50 }, { angle: 80 });
    expect(params.angle).toBeGreaterThanOrEqual(59.5);
    expect(params.angle).toBeLessThanOrEqual(60);
    expect(blocked).not.toBeNull();
    world.dispose();
  });

  it("exempts a pair wholly inside at begin", () => {
    const palm = barMeshes(collideBar).get("palm"); // z from -10 to 0
    const cube = barMeshes(collideBarThrough).get("bar"); // a 4 x 10 x 3 block
    const world = createCollisionWorld({ meshes: new Map([["palm", palm], ["cube", cube]]) });
    const bottom = cube.positions.reduce((m, v, i) => (i % 3 === 2 ? Math.min(m, v) : m), Infinity);
    // place the block by its bottom face: z is the bottom's height
    const matsAt = ({ z }) => new Map([["cube", [1,0,0,0, 0,1,0,0, 0,0,1,0, -38, 0, z - bottom, 1]]]);
    expect(world.inside(matsAt({ z: -7 }), "palm", "cube")).toBe(true);
    expect(world.distances(matsAt({ z: -7 }))[0].distance).toBeGreaterThan(1);
    const guard = createDragGuard({ world, matsAt, start: { z: -7 }, moving: ["cube"], clearance: CONTACT_EPS });
    expect(guard.isClear({ z: -1 })).toBe(true);
    expect(guard.settle({ z: -7 }, { z: 8 })).toEqual({ params: { z: 8 }, blocked: null });
    // out now, and not exempt any more: coming back down stops at the top face
    const back = guard.settle({ z: 8 }, { z: -7 });
    expect(back.blocked).not.toBeNull();
    expect(back.params.z).toBeGreaterThan(0);
    expect(back.params.z).toBeLessThan(0.05);
    world.dispose();
  });

  it("a pair below the band at start gets no rows", () => {
    const { guard, world } = setup(collideBar, { angle: 59 });
    guard.beginFrame({ angle: 59 });
    expect(guard.rowCount).toBe(0);
    guard.beginFrame({ angle: 59.5 });
    expect(guard.rowCount).toBe(0);
    // but settle still stops it at contact
    const { params, blocked } = guard.settle({ angle: 59 }, { angle: 90 });
    expect(params.angle).toBeGreaterThanOrEqual(59.5);
    expect(params.angle).toBeLessThanOrEqual(60);
    expect(blocked).not.toBeNull();
    world.dispose();
  });

  it("isClear sees a non-exempt pair inside clearance", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    expect(guard.isClear({ angle: 40 })).toBe(true);
    expect(guard.isClear({ angle: 65 })).toBe(false);
    world.dispose();
  });
});

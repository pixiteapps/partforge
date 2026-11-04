import { describe, it, expect, vi } from "vitest";
import {
  createDragGuard, SETTLE_STEP_MM, MAX_SUBSTEPS, SETTLE_BISECTIONS,
  COLLIDE_SLIDE, SLIDE_BISECTIONS, SLIDE_SKIN_MM, SLIDE_ROUNDS, PIN_SLIDE_MM,
} from "../src/framework/collide/guard.js";
import { createCollisionWorld, poseMatrices } from "../src/framework/collide/world.js";
import { CONTACT_EPS } from "../src/framework/collide/pairs.js";
import { resolveParams } from "../src/framework/part-model.js";
import { collideBar, collideBarThrough, collideBarTwo, barMeshes } from "./fixtures/collide-bar.js";

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

// settle's pinDrift option, reading every slide as moving a pin: the stop-dead walk
const stopDead = () => Infinity;

describe("drag guard constants", () => {
  it("exports the tuning values", () => {
    expect(SETTLE_STEP_MM).toBe(1);
    expect(MAX_SUBSTEPS).toBe(32);
    expect(SETTLE_BISECTIONS).toBe(12);
    expect(COLLIDE_SLIDE).toBe(true);
    expect(SLIDE_BISECTIONS).toBe(6);
    expect(SLIDE_SKIN_MM).toBe(0.05);
    expect(SLIDE_ROUNDS).toBe(2);
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
  it("a non-linear blend decides the path and never passes contact", () => {
    const { guard, world } = setup(collideBar, { angle: 0 });
    const blend = vi.fn((t) => ({ angle: 90 * t * t }));
    const { params, blocked } = guard.settle({ angle: 0 }, { angle: 90 }, { blend, pinDrift: stopDead });
    expect(params.angle).toBeGreaterThanOrEqual(59.5);
    expect(params.angle).toBeLessThanOrEqual(60);
    expect(blocked).not.toBeNull();
    // the returned params are the blend's own output: t² of 90, not a linear t
    const t = Math.sqrt(params.angle / 90);
    expect(blend.mock.results.some((r) => r.value === params)).toBe(true);
    expect(t).toBeGreaterThan(0.8);
    world.dispose();
  });

  it("a blend that jumps lags rather than tunnels", () => {
    const { guard, world } = setup(collideBarThrough, { angle: 0 });
    // any t > 0 lands wholly inside the slab at 90°: no step of it fits in BAND / 2
    const jump = (t) => ({ angle: t > 0 ? 90 : 0 });
    expect(guard.settle({ angle: 0 }, { angle: 90 }, { blend: jump })).toEqual({ params: { angle: 0 }, blocked: null });
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
    const back = guard.settle({ z: 8 }, { z: -7 }, { pinDrift: stopDead });
    expect(back.blocked).not.toBeNull();
    expect(back.params.z).toBeGreaterThan(0);
    expect(back.params.z).toBeLessThan(0.05);
    world.dispose();
  });

  it("a pair close at start, but clear of it, is not exempt: settle stops it at contact", () => {
    const { guard, world } = setup(collideBar, { angle: 59 });
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

describe("drag guard slide", () => {
  const two = (start) => {
    const world = createCollisionWorld({ meshes: barMeshes(collideBarTwo) });
    const guard = createDragGuard({ world, matsAt: matsAtFor(collideBarTwo), start, moving: ["bar"] });
    return { world, guard, matsAt: matsAtFor(collideBarTwo) };
  };

  it("keeps the part of the move that does not close the pair", () => {
    const { world, guard, matsAt } = two({ a: 0, b: 50 });
    // a straight walk to (10, 80) meets the slab at b = 60, a third of the way: a ≈ 3.3
    const { params, blocked } = guard.settle({ a: 0, b: 50 }, { a: 10, b: 80 });
    expect(params.a).toBeCloseTo(10, 6);
    expect(params.b).toBeGreaterThan(59.5);
    expect(params.b).toBeLessThan(60);
    expect([blocked.a, blocked.b].sort()).toEqual(["bar", "palm"]);
    expect(world.distances(matsAt(params), { within: CONTACT_EPS }).length).toBe(0);
    world.dispose();
  });

  it("reports no block when the slide reaches the target", () => {
    const { world, guard } = two({ a: 0, b: 59.9 });
    // the walk's first sub-step meets the slab, the slide in a alone then finishes the move
    const r = guard.settle({ a: 0, b: 59.9 }, { a: 10, b: 59.95 });
    expect(r.params.a).toBeCloseTo(10, 6);
    world.dispose();
  });

  it("a slide that moves a pin past PIN_SLIDE_MM stops dead, and still reports the normal", () => {
    const { world, guard } = two({ a: 0, b: 50 });
    const pinDrift = vi.fn((p) => Math.abs(p.a)); // a pin that only `a` moves
    const { params, blocked, contacts } = guard.settle({ a: 0, b: 50 }, { a: 10, b: 80 }, { pinDrift });
    expect(pinDrift).toHaveBeenCalledTimes(1);
    expect(params.a).toBeLessThan(4);
    expect(blocked).not.toBeNull();
    expect(contacts.length).toBe(1);
    world.dispose();
  });

  it("a slide that keeps the pins within PIN_SLIDE_MM stands", () => {
    const { world, guard } = two({ a: 0, b: 50 });
    const { params } = guard.settle({ a: 0, b: 50 }, { a: 10, b: 80 }, { pinDrift: () => PIN_SLIDE_MM / 2 });
    expect(params.a).toBeCloseTo(10, 6);
    world.dispose();
  });

  it("an undone slide rolls back its exemptions: the re-walk starts from the ones `from` had", () => {
    // inside clearance at start (exempt "near"); the blend swings out, opening the pair
    // past clearance (which drops the exemption), then back in, where it stops at contact
    const clearance = 0.5;
    const world = createCollisionWorld({ meshes: barMeshes(collideBarTwo) });
    const start = { a: 0, b: 59.9 };
    const guard = createDragGuard({ world, matsAt: matsAtFor(collideBarTwo), start, moving: ["bar"], clearance });
    const blend = (t) => ({ a: 10 * t, b: 59.9 - 30 * Math.sin(Math.PI * t) });
    const { params, blocked } = guard.settle(start, blend(1), { blend, pinDrift: stopDead });
    expect(blocked).not.toBeNull();
    // with the slide's dropped exemption kept, the re-walk would stop at once, at a = 0
    expect(params.a).toBeGreaterThan(5);
    world.dispose();
  });

  it("a piece resting on a surface is lifted a skin off it, never more", () => {
    const { world, guard, matsAt } = two({ a: 0, b: 50 });
    const { params } = guard.settle({ a: 0, b: 50 }, { a: 10, b: 80 });
    const [r] = world.distances(matsAt(params), { within: 1 });
    expect(r.distance).toBeGreaterThan(CONTACT_EPS);
    expect(r.distance).toBeLessThan(CONTACT_EPS + SLIDE_SKIN_MM + 0.01);
    world.dispose();
  });

  it("open air never slides", () => {
    const { world, guard } = two({ a: 0, b: 0 });
    expect(guard.settle({ a: 0, b: 0 }, { a: 10, b: 30 })).toEqual({ params: { a: 10, b: 30 }, blocked: null });
    world.dispose();
  });
});

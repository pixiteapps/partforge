// test/manifold-cache-double-delete.test.js
// A build that throws on a path with no finally-cleanup leaves that round's new
// cached solids on the backend's tracked list. When a later round evicts them the
// cache disposes them, and the next cleanup() used to delete them a second time —
// "Manifold instance already deleted" — after which every build on the kernel
// failed. The worker's jobs always clean up in a finally, but the oracle's
// measure() and any host driving the kernel directly do not, and the eval harness
// lost a whole arm of an experiment to it (2026-09-18).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const plate = () => k.box([0, 0, 0], [60, 40, 6]);
const boss = (r) => k.cylinder(r, r, 6).translate([54, 34, 6]);

test("a build that throws without cleaning up cannot poison the kernel", () => {
  // Round 1: a clean build with a cleanup, as every worker job does.
  k.beginSubPart("p"); plate().union(boss(3)).toMesh(); k.endSubPart(); k.cleanup();

  // Round 2: creates NEW cached solids (a different boss, a new union), then the
  // part's build throws. The bracket closes (buildView's finally) but nobody
  // calls cleanup() — the oracle path.
  k.beginSubPart("p");
  expect(() => { plate().union(boss(5)); throw new Error("boom: the part's build failed"); }).toThrow(/boom/);
  k.endSubPart();

  // Round 3: a build that reaches none of round 2's solids evicts them — the cache
  // disposes them — and then the round's cleanup runs over a tracked list that
  // still names them.
  k.beginSubPart("p"); plate().toMesh(); k.endSubPart();
  expect(() => k.cleanup()).not.toThrow();

  // And the kernel is still usable, cached solids included.
  k.beginSubPart("p");
  const m = plate().union(boss(3)).toMesh();
  k.endSubPart(); k.cleanup();
  expect(m.positions.length).toBeGreaterThan(0);
  k.beginSubPart("p"); plate().union(boss(5)).toMesh(); k.endSubPart(); k.cleanup();
});

test("disposing a cached solid the cleanup already deleted is a no-op", () => {
  // The other order: a round's transient is deleted by cleanup() before the cache
  // evicts the entry that pins it. Same two owners, same single delete.
  k.beginSubPart("q"); const s = plate().union(boss(2)); s.toMesh(); k.endSubPart(); k.cleanup();
  k.beginSubPart("q"); plate().toMesh(); k.endSubPart(); // evicts the union: the cache deletes it
  expect(() => k.cleanup()).not.toThrow();
  expect(() => k.cleanup()).not.toThrow();
});

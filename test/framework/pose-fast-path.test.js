// The pose fast path's decision layer: stamps at delivery, repairs on edit.
// Probe and delta math run for real; viewer and mesh-cache are minimal stubs.
import { expect, test } from "vitest";
import { createPoseFastPath } from "../../src/framework/pose-fast-path.js";
import { composePose } from "../../src/framework/geometry/pose.js";

const posedPart = {
  defaults: { w: 10, angle: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: {
      views: ["v"],
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.w, 10, 5] })
          .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
    },
  },
};

function harness(part) {
  const params = { ...part.defaults };
  let version = 0;
  const poses = {};   // name -> last mat16 or null
  const current = new Set();
  const reads = {};   // name -> Set of recorded keys (absent = unknown)
  const viewer = {
    hasSubMesh: (n) => n in poses,
    setSubPose: (n, m) => { poses[n] = m; },
  };
  const cache = {
    isCurrent: (n) => current.has(n),
    record: (n, r) => { current.add(n); if (r) reads[n] = new Set(r); else delete reads[n]; },
    readsOf: (n) => reads[n] ?? null,
  };
  const fp = createPoseFastPath(part, viewer, cache, {
    params, getView: () => "v", getParamsVersion: () => version,
  });
  return {
    params, poses, current, fp,
    edit(partial) { Object.assign(params, partial); version++; current.clear(); },
    deliver(name) { poses[name] = null; current.add(name); fp.recordDelivered(name); },
  };
}

test("a pose-only edit repairs the subpart: pose set, re-stamped current, name returned", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual(["a"]);
  expect(hx.current.has("a")).toBe(true);
  expect(Array.isArray(hx.poses.a)).toBe(true);
  expect(hx.poses.a).toHaveLength(16);
  // The delta is new-relative-to-delivered, and the delivered pose (angle 0) is
  // identity — so the repaired matrix must be the ABSOLUTE 45° pose, not its
  // inverse. Pins the argument order of poseDelta(now, was) at the call site.
  expect(hx.poses.a).toEqual(composePose([{ t: "rotate", deg: 45, center: [0, 0, 5], axis: [1, 0, 0] }]));
});

test("a geometry edit does not repair (base hash changed)", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ w: 12 });
  expect(hx.fp.repair()).toEqual([]);
  expect(hx.current.has("a")).toBe(false);
});

test("an already-current subpart is left alone", () => {
  const hx = harness(posedPart);
  hx.deliver("a"); // current, delivered
  expect(hx.fp.repair()).toEqual([]);
  expect(hx.poses.a).toBe(null); // untouched since delivery reset
});

test("no repair before any delivery (nothing stamped, no mesh)", () => {
  const hx = harness(posedPart);
  hx.edit({ angle: 30 });
  expect(hx.fp.repair()).toEqual([]);
});

test("an untrusted subpart (geometry query in build) never repairs", () => {
  const queryPart = {
    defaults: { angle: 0 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => {
      const s = k.box({ min: [0, 0, 0], max: [4, 4, 4] });
      return s.rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, s.volume()] });
    } } },
  };
  const hx = harness(queryPart);
  hx.deliver("a");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual([]);
});

// Trust flips with `q`: q=1 takes a geometry query (untrusted), q=0 is a plain
// rigid rotate (trusted). Lets each side of the trust guard be tested alone.
const trustFlipPart = (defaults) => ({
  defaults,
  views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (k, p) => {
    const s = k.box({ min: [0, 0, 0], max: [4, 4, 4] });
    return p.q
      ? s.translate([0, 0, s.volume()])
      : s.rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 0] });
  } } },
});

test("delivered trusted, now untrusted: no repair, no throw", () => {
  const hx = harness(trustFlipPart({ q: 0, angle: 0 }));
  hx.deliver("a");           // stamped trusted
  hx.edit({ q: 1 });         // current probe is untrusted (has no pose at all)
  expect(() => hx.fp.repair()).not.toThrow();
  expect(hx.fp.repair()).toEqual([]);
  expect(hx.poses.a).toBe(null);
});

test("delivered untrusted, now trusted: no repair, no throw", () => {
  const hx = harness(trustFlipPart({ q: 1, angle: 0 }));
  hx.deliver("a");                    // stamped untrusted (no pose recorded)
  hx.edit({ q: 0, angle: 45 });       // current probe is trusted
  expect(() => hx.fp.repair()).not.toThrow();
  expect(hx.fp.repair()).toEqual([]);
  expect(hx.poses.a).toBe(null);
});

// repair() reports what it did, not what's new: every edit of a drag re-poses the
// same subpart and names it again. Callers counting "sub-parts posed" must union
// the names (mount keeps a Set) rather than sum the lengths.
test("consecutive pose edits each report the same subpart again", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ angle: 15 });
  expect(hx.fp.repair()).toEqual(["a"]);
  hx.edit({ angle: 30 });
  expect(hx.fp.repair()).toEqual(["a"]);
});

// forget() is what keeps a SHOWN-but-unrecorded delivery (mount displays a build
// that only went stale because animation frames kept bumping the version) from
// being re-posed later off the previous delivery's stamp.
test("forget(name) drops the stamp: a later repair leaves that subpart alone", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.fp.forget("a");
  hx.edit({ angle: 45 }); // would repair cleanly if the stamp were still there
  expect(hx.fp.repair()).toEqual([]);
  expect(hx.current.has("a")).toBe(false); // not re-stamped current — the regen loop still owes a build
  expect(hx.poses.a).toBe(null);           // never re-posed
});

test("forget(name) only forgets that name", () => {
  const twoPart = {
    ...posedPart,
    parts: { a: posedPart.parts.a, b: { ...posedPart.parts.a } },
  };
  const hx = harness(twoPart);
  hx.deliver("a");
  hx.deliver("b");
  hx.fp.forget("a");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual(["b"]);
});

test("forget on an unknown name is a no-op", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  expect(() => hx.fp.forget("nope")).not.toThrow();
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual(["a"]);
});

test("repair applies the delta against the DELIVERED pose, not the previous frame", () => {
  const hx = harness(posedPart);
  hx.deliver("a");           // delivered at angle 0
  hx.edit({ angle: 30 });
  hx.fp.repair();
  const at30 = hx.poses.a;
  hx.edit({ angle: 60 });
  hx.fp.repair();
  const at60 = hx.poses.a;
  // both deltas are absolute w.r.t. delivery: 60° is NOT 30° applied twice —
  // recompute 30° and check it matches the first repair exactly
  hx.edit({ angle: 30 });
  hx.fp.repair();
  expect(hx.poses.a).toEqual(at30);
  expect(at60).not.toEqual(at30);
});

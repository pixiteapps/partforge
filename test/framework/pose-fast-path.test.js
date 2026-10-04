// The pose fast path's decision layer: stamps at delivery, repairs on edit.
// Probe and delta math run for real; viewer and mesh-cache are minimal stubs.
import { expect, test } from "vitest";
import { createPoseFastPath } from "../../src/framework/pose-fast-path.js";
import { composePose, poseDelta, mulMat4 as mul } from "../../src/framework/geometry/pose.js";
import { createMeshCache } from "../../src/framework/mesh-cache.js";
import lattice from "../fixtures/lattice-lid-part.js";

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

function harness(part, viewName = "v") {
  const params = { ...part.defaults };
  let version = 0;
  const poses = {};   // name -> last mat16 or null
  const calls = [];   // every setSubPose name, in order
  const current = new Set();
  const reads = {};   // name -> Set of recorded keys (absent = unknown)
  const frames = {};  // name -> delivery frame of the cache stamp (absent = no stamp)
  const viewer = {
    hasSubMesh: (n) => n in poses,
    setSubPose: (n, m) => { poses[n] = m; calls.push(n); },
  };
  const cache = {
    isCurrent: (n) => current.has(n),
    record: (n, r, _view, frame = "posed") => {
      current.add(n); frames[n] = frame;
      if (r) reads[n] = new Set(r); else delete reads[n];
    },
    readsOf: (n) => reads[n] ?? null,
    frameOf: (n) => frames[n] ?? null,
    forget: (n) => { current.delete(n); delete frames[n]; },
  };
  const fp = createPoseFastPath(part, viewer, cache, {
    params, getView: () => viewName, getParamsVersion: () => version,
  });
  return {
    params, poses, calls, current, frames, cache, fp,
    get version() { return version; },
    set version(v) { version = v; },
    readsFor(n, r) { reads[n] = new Set(r); },
    readsOf: (n) => reads[n] ?? null,
    edit(partial) { Object.assign(params, partial); version++; current.clear(); },
    // A change to params the stamps don't read: the cache stays current.
    tweak(partial) { Object.assign(params, partial); version++; },
    // What mount does with a fresh reply: show the mesh (matrix reset), stamp the
    // cache with its frame, then stamp the fast path's baseline.
    deliver(name, frame = "posed") {
      poses[name] = null; current.add(name); frames[name] = frame; fp.recordDelivered(name);
    },
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

// The repaired stamp is the delivered build's reads UNIONED with what place()
// read at the new pose, so a key only place() reads still invalidates later.
test("repair re-stamps with the delivered reads unioned with the pose probe's", () => {
  const part = {
    defaults: { w: 10, angle: 0, tilt: 0 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"],
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, 10, 5] }),
      place: (s, { p }) => s.rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }) } },
  };
  const hx = harness(part);
  hx.deliver("a");
  hx.readsFor("a", ["w"]); // what the real build recorded
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual(["a"]);
  expect([...hx.readsOf("a")].sort()).toEqual(["angle", "w"]);
});

test("repair leaves an unknown stamp unknown", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ angle: 45 });
  hx.fp.repair();
  expect(hx.readsOf("a")).toBe(null);
});

// ---- The pose ladder: canonical deliveries (place-only rasterization) ----

const latticePose = (deg) => composePose([
  { t: "rotate", deg, center: [0, 0, 20], axis: [1, 0, 0] },
  { t: "translate", v: [0, 0, 0] },
]);

test("rung 1: a current canonical sub-part is posed by the live place probe, no stamp consulted", () => {
  const hx = harness(lattice, "assembly");
  hx.deliver("insert", "canonical");
  hx.fp.apply(["insert"]);
  expect(hx.poses.insert).toEqual(latticePose(0));
  hx.params.openAngle = 45; hx.version++;          // the cache stays current: openAngle is not a build read
  expect(hx.fp.repair()).toEqual(["insert"]);      // posed with no job: counted
  expect(hx.poses.insert).toEqual(latticePose(45));
  expect(hx.current.has("insert")).toBe(true);
});

test("rung 1 never consults the stamp: a forgotten fast-path stamp still poses", () => {
  const hx = harness(lattice, "assembly");
  hx.deliver("insert", "canonical");
  hx.fp.forget("insert");
  hx.params.openAngle = 30; hx.version++;
  hx.fp.repair();
  expect(hx.poses.insert).toEqual(latticePose(30));
});

test("rung 1: the applied matrix is absolute, never accumulated across frames", () => {
  const hx = harness(lattice, "assembly");
  hx.deliver("insert", "canonical");
  hx.params.openAngle = 30; hx.version++; hx.fp.repair();
  hx.params.openAngle = 60; hx.version++; hx.fp.repair();
  expect(hx.poses.insert).toEqual(latticePose(60));
});

test("rung 1 counts a name only when its matrix moved (honest during playback)", () => {
  const part = { defaults: { x: 0, y: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k) => k.box({ size: [1, 1, 1] }),
    place: (s, { p }) => s.translate([p.x, 0, 0]) } } };
  const hx = harness(part);
  hx.deliver("a", "canonical");
  hx.fp.apply(["a"]);
  hx.params.y = 3; hx.version++;                   // place() doesn't read y: same matrix
  expect(hx.fp.repair()).toEqual([]);
  hx.params.x = 2; hx.version++;
  expect(hx.fp.repair()).toEqual(["a"]);
  expect(hx.poses.a).toEqual(composePose([{ t: "translate", v: [2, 0, 0] }]));
});

// setSubPose is not free: it bumps the viewer's match generation and restarts
// the realistic-mode contact-shadow cycle. repair() runs rung 1 over every
// current canonical sub-part on every param change, so an unchanged matrix must
// not reach the viewer at all.
test("a param change that moves nothing calls setSubPose zero times", () => {
  const part = { defaults: { x: 0, y: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k) => k.box({ size: [1, 1, 1] }),
    place: (s, { p }) => s.translate([p.x, 0, 0]) } } };
  const hx = harness(part);
  hx.deliver("a", "canonical");
  hx.fp.apply(["a"]);
  hx.calls.length = 0;
  hx.params.y = 3; hx.version++;                   // place() doesn't read y
  hx.fp.repair();
  hx.fp.apply(["a"]);                              // a re-apply at the same pose too
  expect(hx.calls).toEqual([]);
  hx.params.x = 2; hx.version++;
  hx.fp.repair();
  expect(hx.calls).toEqual(["a"]);
});

test("a posed delivery's apply does not touch the matrix setSubGeometry already reset", () => {
  const hx = harness(posedPart);
  hx.deliver("a", "posed");
  hx.fp.apply(["a"]);
  expect(hx.calls).toEqual([]);
  expect(hx.poses.a).toBe(null);
});

// A fresh delivery is built at the live params, so host and worker place probes
// agree by construction. Should they ever disagree, forgetting the stamp there
// would rebuild at identical params and disagree again — a forget→rebuild loop.
// The fresh call clears the pose (canonical frame shown) and keeps the stamp.
test("apply(..., { fresh: true }) with an untrusted live place() clears the pose but keeps the stamp", () => {
  const part = { defaults: { x: 9 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k) => k.box({ size: [1, 1, 1] }),
    place: (s, { p }) => (p.x > 5 ? s.translate(s.boundingBox().center) : s.translate([p.x, 0, 0])) } } };
  const hx = harness(part);
  hx.deliver("a", "canonical");
  hx.fp.apply(["a"], undefined, { fresh: true });
  expect(hx.poses.a).toBe(null);
  expect(hx.current.has("a")).toBe(true);           // not forgotten: no rebuild at the same params
  expect(hx.cache.frameOf("a")).toBe("canonical");
  hx.fp.apply(["a"]);                               // every other call site still forgets
  expect(hx.current.has("a")).toBe(false);
});

test("rung 1: a canonical mesh whose live place() is untrusted is forgotten and cleared", () => {
  const part = { defaults: { x: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k) => k.box({ size: [1, 1, 1] }),
    place: (s, { p }) => (p.x > 5 ? s.translate(s.boundingBox().center) : s.translate([p.x, 0, 0])) } } };
  const hx = harness(part);
  hx.deliver("a", "canonical");
  hx.params.x = 9; hx.version++;
  hx.fp.repair();
  expect(hx.current.has("a")).toBe(false);          // regen rebuilds it posed
  expect(hx.poses.a).toBe(null);
});

const rung2Part = { defaults: { w: 10, angle: 0, lift: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
  build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, 10, 5] }).rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
  place: (s, { p }) => s.translate([0, 0, p.lift]) } } };

test("rung 2: a trailing transform inside build still re-poses by delta, composed with the place pose", () => {
  const hx = harness(rung2Part);
  hx.deliver("a", "canonical"); hx.readsFor("a", ["angle", "w"]);
  hx.edit({ angle: 45, lift: 3 });                  // angle is a build read → stale
  expect(hx.fp.repair()).toEqual(["a"]);
  const delta = poseDelta([{ t: "rotate", deg: 45, center: [0, 0, 5], axis: [1, 0, 0] }], [{ t: "rotate", deg: 0, center: [0, 0, 5], axis: [1, 0, 0] }]);
  expect(hx.poses.a).toEqual(mul(composePose([{ t: "translate", v: [0, 0, 3] }]), delta));   // place over build delta
  expect(hx.current.has("a")).toBe(true);
  expect(hx.frames.a).toBe("canonical");            // re-recorded keeping the delivery frame
  // The build's reads only: lift is place()'s, and rung 1 owns place reads
  // (spec §3 — recorded keys are the build's), so a later lift change keeps the
  // stamp current and rung 1 re-poses it.
  expect([...hx.readsOf("a")].sort()).toEqual(["angle", "w"]);
});

test("rung 2: the delta is measured against the delivered build pose, not the previous frame", () => {
  const hx = harness({ ...rung2Part, defaults: { w: 10, angle: 30, lift: 0 } });
  hx.deliver("a", "canonical");
  hx.edit({ angle: 45 }); hx.fp.repair();
  hx.edit({ angle: 60 }); hx.fp.repair();
  const rot = (deg) => [{ t: "rotate", deg, center: [0, 0, 5], axis: [1, 0, 0] }];
  expect(hx.poses.a).toEqual(mul(composePose([{ t: "translate", v: [0, 0, 0] }]), poseDelta(rot(60), rot(30))));
});

test("rung 2 refuses when the build hash moved (a geometry param changed)", () => {
  const hx = harness(rung2Part);
  hx.deliver("a", "canonical");
  hx.edit({ w: 12 });
  expect(hx.fp.repair()).toEqual([]);
  expect(hx.current.has("a")).toBe(false);
  expect(hx.poses.a).toBe(null);
});

test("rung 2 refuses when the live place() is untrusted (Ruling F)", () => {
  const part = { ...rung2Part, parts: { a: { ...rung2Part.parts.a,
    place: (s, { p }) => (p.lift > 5 ? s.translate([0, 0, s.volume()]) : s.translate([0, 0, p.lift])) } } };
  const hx = harness(part);
  hx.deliver("a", "canonical");
  hx.edit({ angle: 45, lift: 9 });
  expect(hx.fp.repair()).toEqual([]);              // Ruling F: refused, not forgotten-and-cleared
  expect(hx.current.has("a")).toBe(false);
  expect(hx.poses.a).toBe(null);                   // left as delivered; the regen loop rebuilds
});

// A posed delivery (the worker baked place() in) keeps today's full-scope delta:
// the matrix is delta(full now, full delivered), with nothing composed over it.
// The pre-existing tests above all deliver "posed" (the harness default); this one
// pins the distinction from rung 2 — a canonical reading would give rot(45), not rot(15).
test("a posed delivery keeps today's full-scope delta path", () => {
  const part = { defaults: { w: 10, angle: 30 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, 10, 5] }),
    place: (s, { p }) => s.rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }) } } };
  const hx = harness(part);
  hx.deliver("a", "posed");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual(["a"]);
  const rot = (deg) => [{ t: "rotate", deg, center: [0, 0, 5], axis: [1, 0, 0] }];
  expect(hx.poses.a).toEqual(poseDelta(rot(45), rot(30)));
  expect(hx.frames.a).toBe("posed");
});

test("apply on a posed sub-part clears a matrix this module applied", () => {
  const hx = harness(lattice, "assembly");
  hx.deliver("insert", "canonical");
  hx.params.openAngle = 30; hx.version++;
  hx.fp.apply(["insert"]);                          // canonical: posed by place()
  expect(hx.poses.insert).toEqual(latticePose(30));
  hx.fp.apply(["insert"], { insert: "posed" });     // posed frame, no stored delta: cleared
  expect(hx.poses.insert).toBe(null);
});

test("apply skips names out of view, names without a mesh, and names with no frame", () => {
  const hx = harness(lattice, "assembly");
  hx.fp.apply(["insert", "nope"]);                  // no mesh delivered
  expect("insert" in hx.poses).toBe(false);
  hx.deliver("insert", "canonical");
  hx.cache.forget("insert");                        // no stamp, no override: frame unknown
  hx.poses.insert = "untouched";
  hx.fp.apply(["insert"]);
  expect(hx.poses.insert).toBe("untouched");
});

// Ruling B: mount's stale-shown branch forgets the stamps, then calls apply with
// each delivered mesh's frame — frameOf is null by then, so the override decides.
test("apply(names, frames) poses a stamp-less canonical delivery from the override", () => {
  const hx = harness(lattice, "assembly");
  hx.params.openAngle = 70;
  hx.poses.insert = null;                           // shown, not recorded
  hx.fp.apply(["insert"], { insert: "canonical" });
  expect(hx.poses.insert).toEqual(latticePose(70));
  expect(hx.current.has("insert")).toBe(false);     // still not current: the regen loop owes a build
});

test("the frames override wins over the cache stamp's frame", () => {
  const hx = harness(lattice, "assembly");
  hx.deliver("insert", "posed");
  hx.params.openAngle = 20;
  hx.fp.apply(["insert"], { insert: "canonical" });
  expect(hx.poses.insert).toEqual(latticePose(20));
});

test("apply(names, frames) with an untrusted live place() clears the matrix and leaves the stamp forgotten", () => {
  const part = { defaults: { x: 9 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k) => k.box({ size: [1, 1, 1] }),
    place: (s, { p }) => (p.x > 5 ? s.translate(s.boundingBox().center) : s.translate([p.x, 0, 0])) } } };
  const hx = harness(part);
  hx.poses.a = composePose([{ t: "translate", v: [1, 0, 0] }]);
  hx.fp.apply(["a"], { a: "canonical" });
  expect(hx.poses.a).toBe(null);
  expect(hx.cache.frameOf("a")).toBe(null);
});

// The probe maps are lazy: a part with only posed deliveries never runs the place
// or build probe, and rung 1 never runs a build probe at all.
test("probes run lazily, only the scopes a frame needs", () => {
  let builds = 0, places = 0;
  const part = { defaults: { angle: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k) => { builds++; return k.box({ size: [1, 1, 1] }); },
    place: (s, { p }) => { places++; return s.translate([p.angle, 0, 0]); } } } };
  const posed = harness(part);
  posed.deliver("a", "posed");                      // full probe: one build + one place
  builds = places = 0;
  posed.edit({ angle: 5 }); posed.fp.repair();
  expect([builds, places]).toEqual([1, 1]);         // full scope only
  const canon = harness(part);
  canon.deliver("a", "canonical");
  builds = places = 0;
  canon.params.angle = 5; canon.version++; canon.fp.repair();
  expect([builds, places]).toEqual([0, 1]);         // place scope only
  canon.fp.repair();                                // same (version, view): memoized
  expect([builds, places]).toEqual([0, 1]);
});

// ---- A repaired delta survives later rung-1 poses and apply() ----
// After a rung-2 or posed repair the cache says current, so the regen loop will
// never rebuild the mesh: every later pose must still carry the repair's delta.

const rot5 = (deg) => [{ t: "rotate", deg, center: [0, 0, 5], axis: [1, 0, 0] }];
const lifted = (z) => composePose([{ t: "translate", v: [0, 0, z] }]);

test("rung 2's delta survives a later unread-param change (repair) and apply() while current", () => {
  const hx = harness({ ...rung2Part, defaults: { ...rung2Part.defaults, other: 0 } });
  hx.deliver("a", "canonical");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual(["a"]);
  const want = mul(lifted(0), poseDelta(rot5(45), rot5(0)));
  expect(hx.poses.a).toEqual(want);
  hx.tweak({ other: 1 });                          // cache stays current → rung 1
  expect(hx.fp.repair()).toEqual([]);              // matrix unchanged: not counted
  expect(hx.poses.a).toEqual(want);
  hx.fp.apply(["a"]);                              // a view switch / post-delivery apply
  expect(hx.poses.a).toEqual(want);
  hx.tweak({ lift: 4 });                           // rung 1 moves the place pose, keeps the delta
  expect(hx.fp.repair()).toEqual(["a"]);
  expect(hx.poses.a).toEqual(mul(lifted(4), poseDelta(rot5(45), rot5(0))));
});

test("a new delivery resets the stored delta to identity", () => {
  const hx = harness(rung2Part);
  hx.deliver("a", "canonical");
  hx.edit({ angle: 45 }); hx.fp.repair();
  hx.deliver("a", "canonical");                    // rebuilt at angle 45
  hx.fp.apply(["a"]);
  expect(hx.poses.a).toEqual(lifted(0));
});

test("a posed repair's delta survives apply() and a still-current repair", () => {
  const part = { defaults: { w: 10, angle: 30, other: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, 10, 5] }),
    place: (s, { p }) => s.rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }) } } };
  const hx = harness(part);
  hx.deliver("a", "posed");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toEqual(["a"]);
  const want = poseDelta(rot5(45), rot5(30));
  hx.tweak({ other: 1 });
  expect(hx.fp.repair()).toEqual([]);
  expect(hx.poses.a).toEqual(want);
  hx.fp.apply(["a"]);                              // view switch must not snap back to the delivered pose
  expect(hx.poses.a).toEqual(want);
});

// The reviewer's reproduction, on the REAL mesh cache: currency comes from the
// recorded reads, not from a test-controlled set.
test("real mesh cache: rung 2 then an unread param keeps place · delta", () => {
  const part = { ...rung2Part, defaults: { ...rung2Part.defaults, other: 0 } };
  const params = { ...part.defaults };
  let version = 0;
  const poses = {};
  const viewer = { hasSubMesh: (n) => n in poses, setSubPose: (n, m) => { poses[n] = m; } };
  const cache = createMeshCache(viewer, { params, getView: () => "v", getParamsVersion: () => version, isCaching: () => true });
  const fp = createPoseFastPath(part, viewer, cache, { params, getView: () => "v", getParamsVersion: () => version });
  poses.a = null;
  cache.record("a", ["angle", "w"], "v", "canonical");
  fp.recordDelivered("a");
  params.angle = 45; version++;
  expect(fp.repair()).toEqual(["a"]);
  const want = mul(lifted(0), poseDelta(rot5(45), rot5(0)));
  expect(poses.a).toEqual(want);
  params.other = 1; version++;
  expect(cache.isCurrent("a")).toBe(true);
  fp.repair();
  expect(poses.a).toEqual(want);
  fp.apply(["a"]);
  expect(poses.a).toEqual(want);
});

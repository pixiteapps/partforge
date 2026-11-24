// @vitest-environment happy-dom
// A cage body dragged on a cached preview (docs/superpowers/specs/2026-11-22-cage-pose-drag-
// design.md, "Part 4"; src/framework/preview-cage.js): the file's ties (encoder version 7)
// and the part's cage code rebuilt through the build probe at the file's params re-pose the
// decoded mesh with no kernel. The files here come from the real worker job path and the
// real encoder and decoder; the exact builds compared against are the worker's.
import { beforeAll, describe, expect, test, vi } from "vitest";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { encodePreviewGlb } from "../src/framework/gltf/encode-preview.js";
import { decodePreviewGlb } from "../src/framework/gltf/decode-preview.js";
import { createPreviewCages, previewTieTolerance } from "../src/framework/preview-cage.js";
import { previewHandles } from "../src/framework/preview-pose.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { viewSubParts } from "../src/framework/part-model.js";
import { topologyKey } from "../src/framework/geometry/subdiv/surface.js";
import { composePose } from "../src/framework/geometry/pose.js";
import { measure } from "../src/framework/oracle/measure.js";
import hand from "../src/parts/cage-hand.js";
import rigidHand from "../src/parts/hand.js";
import robotArm from "../src/parts/robot-arm.js";
import organicHand from "../src/parts/organic-hand.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel({ quality: "preview" }); }, 120_000);

const gen = async (part, view, params, subparts = Object.keys(part.parts)) => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view, params }, post);
  const msgs = post.mock.calls.map(([m]) => m);
  const err = msgs.find((m) => m.type === "error");
  if (err) throw new Error(err.message ?? JSON.stringify(err));
  return msgs.find((m) => m.type === "meshes").meshes;
};
// The GLB's JSON chunk, parsed.
const jsonOf = (glb) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));

// A stand-in for the preview's viewer: the arrays it was handed, and every write.
function fakeViewer(meshes) {
  const arrays = new Map(meshes.map((m) => [m.name, { positions: m.positions, normals: m.normals }]));
  const writes = [];
  return {
    writes,
    hasSubMesh: (name) => arrays.has(name),
    setSubVertices(name, { positions, normals }, { deformed = false } = {}) {
      const a = arrays.get(name);
      if (!a) return false;
      if (positions.length !== a.positions.length) throw new RangeError("length mismatch");
      a.positions.set(positions);
      a.normals.set(normals);
      writes.push({ name, deformed });
      return true;
    },
  };
}

// Nearest vertex distance from a point to a point set, on a hash grid.
function nearest(P, cell = 0.25) {
  const grid = new Map(), key = (i, j, l) => `${i},${j},${l}`;
  for (let v = 0; v < P.length / 3; v++) {
    const kk = key(Math.floor(P[3 * v] / cell), Math.floor(P[3 * v + 1] / cell), Math.floor(P[3 * v + 2] / cell));
    let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(v);
  }
  return (x, y, z) => {
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell), cl = Math.floor(z / cell);
    let best = Infinity;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (let l = cl - 1; l <= cl + 1; l++) {
      for (const v of grid.get(key(i, j, l)) ?? []) best = Math.min(best, Math.hypot(P[3 * v] - x, P[3 * v + 1] - y, P[3 * v + 2] - z));
    }
    return best;
  };
}
// The worst distance from each vertex of `positions` to the nearest vertex of `exact`.
function worstGap(positions, exact) {
  const near = nearest(exact);
  let worst = 0;
  for (let v = 0; v < positions.length / 3; v++) worst = Math.max(worst, near(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]));
  return worst;
}

const A = { ...hand.defaults };
const THUMB = { ...hand.defaults, thumbCurl: 55 };
const INDEX = { ...hand.defaults, indexKnuckle: 60, indexCurl: 70 };
const FINGERS = Object.keys(hand.defaults).filter((key) => !key.startsWith("thumb"));
const ALL_CURLED = { ...hand.defaults, ...Object.fromEntries(FINGERS.map((key) => [key, 90])), thumbCurl: 50 };

// test/mount-cage-drag.test.js's swing arm: clear at 60°, back through itself at 140°.
const armCage = (make, deg, x = 0) => {
  const c = make({ box: { size: [20, 20, 20], center: [x, 0, 0] } });
  let a = c.extrude("+x:0,0", { by: 8 });
  a = c.extrude(a, { by: 8 });
  const hinge = c.centroid(a);
  a = c.extrude(a, { by: 25 });
  c.rotate(a, { axis: "z", deg, about: hinge });
  return c;
};
const swingPart = (extra = {}) => ({
  meta: { title: "Swing", backend: "manifold" },
  defaults: { swing: 0 },
  handles: { arm: { point: () => [0, 0, 0], drag: "point", params: ["swing"] } },
  views: { v: { label: "V" } },
  parts: { body: { label: "Body", views: ["v"], build: (kk, p) => kk.subdiv(armCage(kk.cage, p.swing)) } },
  parameters: [{ id: "pose", title: "Pose", controls: [{ key: "swing", label: "Swing", min: 0, max: 170, step: 1 }] }],
  ...extra,
});
const swing = swingPart();
const decodedFile = async (part, view, params, subparts) => decodePreviewGlb(await encodePreviewGlb({ meshes: await gen(part, view, params, subparts), part, view, params }));

// A fresh decode of the hand's file at `at` (the viewer writes into the payload's arrays).
const fileAt = async (glb) => decodePreviewGlb(glb);

describe("the cage hand's preview file", () => {
  let mesh, glb, decoded;
  beforeAll(async () => {
    [mesh] = await gen(hand, "assembly", A);
    glb = await encodePreviewGlb({ meshes: [mesh], part: hand, view: "assembly", params: A });
    decoded = await fileAt(glb);
  }, 120_000);

  test("names exactly the two extensions every preview file names, used and required", () => {
    const json = jsonOf(glb);
    expect([...json.extensionsUsed].sort()).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
    expect([...json.extensionsRequired].sort()).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
  });

  test("the decoder reports the file's position step, read off its own dequantization", () => {
    const { ties, positions } = decoded.meshes[0];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], positions[i]); hi[i % 3] = Math.max(hi[i % 3], positions[i]); }
    const extentStep = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / (2 ** 14 - 1);
    const what = `step ${ties.step} mm, extent / 16383 ${extentStep} mm, tie tolerance ${previewTieTolerance(ties.step)} mm`;
    expect(ties.step, what).toBeGreaterThan(0);
    expect(Math.abs(ties.step - extentStep) / extentStep, what).toBeLessThan(0.01);
  });

  test("the hand is re-posable, and its ties agree with the plan rebuilt from the file's params", () => {
    const viewer = fakeViewer(decoded.meshes);
    const cages = createPreviewCages(hand, "assembly", A, decoded.meshes);
    expect(cages.names()).toEqual(["hand"]);
    expect(cages.keys().get("hand")).toBe(topologyKey(probePoses(hand, "assembly", A, { scope: "build" }).get("hand").cages[0]));
    expect(cages.verifyNext()).toBe(true);   // proved hand
    expect(cages.names()).toEqual(["hand"]);
    expect(cages.verifyNext()).toBe(false);  // nothing left to prove
    expect(cages.holdsDragState()).toBe(false); // the plan the proof built is dropped
    expect(viewer.writes).toEqual([]);
  });

  test("the editor's tolerance would refuse the quantized file (why the preview derives its own)", async () => {
    const { tiesAgree, makeCageBase } = await import("../src/framework/skin/cage-deform.js");
    const p = decoded.meshes[0];
    const snap = probePoses(hand, "assembly", A, { scope: "build" }).get("hand").cages[0];
    const base = makeCageBase(snap, p.ties);
    expect(tiesAgree(base, p.positions)).toBe(false);
    expect(tiesAgree(base, p.positions, { tolerance: previewTieTolerance(p.ties.step), quantized: true })).toBe(true);
  });

  // The deformed file mesh against the worker's exact build at the reached pose, as point
  // sets (every decoded vertex is one of the welded delivered vertices). A deform does not
  // carry the file's position error: every vertex is placed afresh from its tie on the live
  // limit mesh, so only the weights' rounding to 1/65535 reaches it (Task 17: at most
  // 3.8e-5 mm). The file's own rest positions sit up to about one 0.0127 mm step off; that is
  // the most the first move can jump. MEASURED (2026-11-22, M1 Max): 3.82e-5 mm at the thumb
  // pose and for the index finger, 3.51e-5 mm with every digit at its max. Asserted: under
  // 1e-4 mm, the measured worst times 2.6 for margin (the brief's 1e-2 mm is far looser).
  test.each([
    ["the thumb curled (the cage lists its faces in another order there)", THUMB],
    ["the index finger bent", INDEX],
    ["every finger and the thumb curled to the max", ALL_CURLED],
  ])("dragged to %s: within one quantization step of the exact build there", async (label, B) => {
    const file = await fileAt(glb);
    const viewer = fakeViewer(file.meshes);
    const cages = createPreviewCages(hand, "assembly", A, file.meshes);
    expect(cages.isClear(viewer, B)).toBe(true);
    const t0 = performance.now();
    expect(cages.show(viewer, B)).toBe(false);
    const first = performance.now() - t0;
    expect(viewer.writes).toEqual([{ name: "hand", deformed: true }]);
    expect(cages.isDeformed("hand")).toBe(true);
    const [exact] = await gen(hand, "assembly", B);
    const gap = worstGap(file.meshes[0].positions, exact.positions);
    const step = file.meshes[0].ties.step;
    expect(gap, `${label}: worst gap ${gap} mm (step ${step} mm), first show ${first} ms`).toBeLessThan(1e-4);
  }, 120_000);

  test("per move: one deform of the preview mesh, timed", async () => {
    const file = await fileAt(glb);
    const viewer = fakeViewer(file.meshes);
    const cages = createPreviewCages(hand, "assembly", A, file.meshes);
    const times = [];
    for (let i = 1; i <= 30; i++) {
      const p = { ...A, indexCurl: 20 + i * 2 };
      const t0 = performance.now();
      expect(cages.isClear(viewer, p)).toBe(true); // the guard's check, then the frame's write
      cages.show(viewer, p);
      times.push(performance.now() - t0);
    }
    const later = times.slice(1).sort((a, b) => a - b);
    expect(viewer.writes.length, `${file.meshes[0].positions.length / 3} vertices: first move ${times[0]} ms, later median ${later[later.length >> 1]} ms, p90 ${later[Math.floor(later.length * 0.9)]} ms`).toBe(30);
  }, 120_000);

  test("a pose through itself is not drawn, and the guard stops the handle at the last valid pose", async () => {
    const [body] = await gen(swing, "v", { swing: 0 });
    const file = await decodePreviewGlb(await encodePreviewGlb({ meshes: [body], part: swing, view: "v", params: { swing: 0 } }));
    const viewer = fakeViewer(file.meshes);
    const cages = createPreviewCages(swing, "v", { swing: 0 }, file.meshes);
    expect(cages.names()).toEqual(["body"]);
    const guard = cages.guard(viewer, { swing: 0 }, null);
    expect(guard).not.toBeNull();
    expect(guard.isClear({ swing: 60 })).toBe(true);
    expect(guard.isClear({ swing: 140 })).toBe(false);
    expect(guard.settle({ swing: 60 }, { swing: 140 }).params).toEqual({ swing: 60 });
    expect(cages.show(viewer, { swing: 60 })).toBe(false);
    const shown = Float32Array.from(file.meshes[0].positions);
    const writes = viewer.writes.length;
    expect(cages.show(viewer, { swing: 140 })).toBe(true); // held
    expect(viewer.writes.length).toBe(writes);              // nothing drawn
    expect(file.meshes[0].positions).toEqual(shown);
    // The rigid-only guard: a part with no re-posable cage body in view keeps its own guard.
    const inner = { settle: () => ({ params: {}, blocked: null }), isClear: () => true };
    expect(createPreviewCages(swing, "v", { swing: 0 }, []).guard(viewer, { swing: 0 }, inner)).toBe(inner);
  }, 120_000);

  test("back at the file's params the file's own mesh comes back; the drag state goes when the drag ends", async () => {
    const file = await fileAt(glb);
    const before = Float32Array.from(file.meshes[0].positions);
    const viewer = fakeViewer(file.meshes);
    const cages = createPreviewCages(hand, "assembly", A, file.meshes);
    cages.show(viewer, INDEX);
    expect(cages.holdsDragState()).toBe(true);
    cages.endDrag();
    expect(cages.holdsDragState()).toBe(false); // the deformed pose stays drawn, the plan goes
    expect(cages.isDeformed("hand")).toBe(true);
    cages.show(viewer, A);
    expect(viewer.writes.at(-1)).toEqual({ name: "hand", deformed: false });
    expect(file.meshes[0].positions).toEqual(before);
    // A second drag from the restored file rebuilds its state and deforms again.
    cages.show(viewer, THUMB);
    expect(cages.isDeformed("hand")).toBe(true);
  }, 120_000);

  test("a corrupted triangle index or a non-finite weight is refused, with nothing drawn", async () => {
    for (const corrupt of [
      (t) => { t.tri[7] = 0xfffffff; },           // past the plan's triangles
      (t) => { t.w[10] = Number.NaN; },
      (t) => { t.w[11] = Number.POSITIVE_INFINITY; },
    ]) {
      const file = await fileAt(glb);
      corrupt(file.meshes[0].ties);
      const viewer = fakeViewer(file.meshes);
      const cages = createPreviewCages(hand, "assembly", A, file.meshes);
      while (cages.verifyNext());
      expect(cages.names()).toEqual([]);
      expect(cages.keys().size).toBe(0);
      expect(cages.isClear(viewer, INDEX)).toBe(true); // no cage body to stop it: nothing re-posable
      expect(cages.show(viewer, INDEX)).toBe(false);
      expect(viewer.writes).toEqual([]);
      // ...so the handles stay hidden, as for a file without ties.
      expect(previewHandles(hand, "assembly", A, ["hand"], { cageKeys: cages.keys() }).shown).toEqual([]);
    }
  }, 120_000);

  test("a file key that is not the cage's topology, or an animated or non-rigid sub-part, is refused", async () => {
    const file = await fileAt(glb);
    const p = file.meshes[0];
    expect(createPreviewCages(hand, "assembly", A, [{ ...p, ties: { ...p.ties, key: "not-it" } }]).names()).toEqual([]);
    expect(createPreviewCages(hand, "assembly", A, file.meshes, { animated: ["hand"] }).names()).toEqual([]);
    const scaled = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    expect(createPreviewCages(hand, "assembly", A, [{ ...p, ties: { ...p.ties, pose: scaled } }]).names()).toEqual([]);
  });

  test("a file stored posed: the deform runs in the decoded frame (the tie's pose moves the rebuilt cage)", async () => {
    const pose = composePose([{ t: "rotate", deg: 30, center: [0, 0, 0], axis: [0, 0, 1] }, { t: "translate", v: [20, -5, 7] }]);
    const move = (arr, normal) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 3) {
        const [x, y, z] = [arr[i], arr[i + 1], arr[i + 2]];
        for (let a = 0; a < 3; a++) out[i + a] = pose[a] * x + pose[4 + a] * y + pose[8 + a] * z + (normal ? 0 : pose[12 + a]);
      }
      return out;
    };
    const posed = { ...mesh, positions: move(mesh.positions), normals: move(mesh.normals, true), edges: move(mesh.edges), ties: { ...mesh.ties, pose } };
    const file = await decodePreviewGlb(await encodePreviewGlb({ meshes: [posed], part: hand, view: "assembly", params: A }));
    const viewer = fakeViewer(file.meshes);
    const cages = createPreviewCages(hand, "assembly", A, file.meshes);
    expect(cages.verifyNext()).toBe(true);
    expect(cages.names()).toEqual(["hand"]);
    cages.show(viewer, INDEX);
    const [exact] = await gen(hand, "assembly", INDEX);
    const gap = worstGap(file.meshes[0].positions, move(exact.positions));
    expect(gap, `posed file: worst gap ${gap} mm`).toBeLessThan(1e-4);
  }, 120_000);
});

describe("which handles a preview shows", () => {
  test("a version 7 file of the cage hand: all five, through previewHandles with its file keys", async () => {
    const [mesh] = await gen(hand, "assembly", A);
    const file = await decodePreviewGlb(await encodePreviewGlb({ meshes: [mesh], part: hand, view: "assembly", params: A }));
    const cages = createPreviewCages(hand, "assembly", A, file.meshes);
    while (cages.verifyNext());
    expect(previewHandles(hand, "assembly", A, ["hand"], { cageKeys: cages.keys() })).toEqual({
      shown: ["index", "middle", "ring", "pinky", "thumb"], hidden: {},
    });
  }, 120_000);

  test("a version 6 file (no ties): the handles stay hidden with today's reason", async () => {
    const [mesh] = await gen(hand, "assembly", A);
    const { ties, ...plain } = mesh;
    const file = await decodePreviewGlb(await encodePreviewGlb({ meshes: [plain], part: hand, view: "assembly", params: A }));
    expect(file.meshes[0]).not.toHaveProperty("ties");
    const cages = createPreviewCages(hand, "assembly", A, file.meshes);
    expect(cages.verifyNext()).toBe(false);
    expect(previewHandles(hand, "assembly", A, ["hand"], { cageKeys: cages.keys() })).toEqual({
      shown: [],
      hidden: {
        index: "indexKnuckle rebuilds hand", middle: "middleKnuckle rebuilds hand", ring: "ringKnuckle rebuilds hand",
        pinky: "pinkyKnuckle rebuilds hand", thumb: "thumbCurl rebuilds hand",
      },
    });
  }, 120_000);

  test("partforge measure lists the five under preview handles (a file this version writes)", () => {
    const report = measure(k, hand, "assembly", {}, { previewHandles: true });
    expect(report.previewHandles).toEqual({ shown: ["index", "middle", "ring", "pinky", "thumb"], hidden: {} });
  }, 120_000);

  // Snapshotted with the 0.201.0 stepper (before cage keys existed): with no cage keys, and
  // with an empty map, every part answers exactly as it did.
  test.each([
    ["robot-arm", robotArm, "assembly", { shown: ["tool"], hidden: {} }],
    ["hand (rigid)", rigidHand, "assembly", { shown: ["thumb", "index", "middle", "ring", "pinky"], hidden: {} }],
    ["organic-hand (implicit)", organicHand, "assembly", {
      shown: [],
      hidden: {
        index: "indexKnuckle rebuilds hand", middle: "middleKnuckle rebuilds hand", ring: "ringKnuckle rebuilds hand",
        pinky: "pinkyKnuckle rebuilds hand", thumb: "thumbKnuckle rebuilds hand",
      },
    }],
  ])("%s: unchanged", (label, part, view, want) => {
    const fp = { ...part.defaults };
    const names = viewSubParts(part, view, fp);
    expect(previewHandles(part, view, fp, names)).toEqual(want);
    expect(previewHandles(part, view, fp, names, { cageKeys: new Map() })).toEqual(want);
  });

  test("an implicit body and a rigid part have no re-posable cage body", async () => {
    const [arm] = await gen(robotArm, "assembly", robotArm.defaults, [Object.keys(robotArm.parts)[0]]);
    expect(createPreviewCages(robotArm, "assembly", robotArm.defaults, [arm]).names()).toEqual([]);
  }, 120_000);
});

describe("what keeps a cage body's handles hidden in a preview", () => {
  test("a part whose collisions cover the cage body: hidden, with that reason, in the preview and in measure", async () => {
    const colliding = swingPart({ collisions: {} });
    const file = await decodedFile(colliding, "v", { swing: 0 });
    const viewer = fakeViewer(file.meshes);
    const cages = createPreviewCages(colliding, "v", { swing: 0 }, file.meshes);
    expect(cages.names()).toEqual([]);                    // nothing re-posable
    expect(cages.isClear(viewer, { swing: 60 })).toBe(true);
    expect(cages.show(viewer, { swing: 60 })).toBe(false);
    expect(viewer.writes).toEqual([]);
    const want = { shown: [], hidden: { arm: "swing reshapes body, and the part's collisions cover it (a preview checks them against the file's mesh only)" } };
    expect(previewHandles(colliding, "v", { swing: 0 }, ["body"], { cageKeys: cages.keys() })).toEqual(want);
    expect(measure(k, colliding, "v", {}, { previewHandles: true }).previewHandles).toEqual(want);
    // The same part without the collisions entry shows the handle, in both.
    const free = await decodedFile(swing, "v", { swing: 0 });
    const freeCages = createPreviewCages(swing, "v", { swing: 0 }, free.meshes);
    while (freeCages.verifyNext());
    expect(previewHandles(swing, "v", { swing: 0 }, ["body"], { cageKeys: freeCages.keys() })).toEqual({ shown: ["arm"], hidden: {} });
    expect(measure(k, swing, "v", {}, { previewHandles: true }).previewHandles).toEqual({ shown: ["arm"], hidden: {} });
  }, 120_000);

  test("a throw while proving one body's ties refuses that body alone: the other body and the rigid handle still show", async () => {
    // Two swing arms and a slide that moves a box by placement alone.
    const two = {
      meta: { title: "Two arms", backend: "manifold" },
      defaults: { swingA: 0, swingB: 0, slide: 0 },
      handles: {
        a: { point: () => [0, 0, 0], drag: "point", params: ["swingA"] },
        b: { point: () => [0, 80, 0], drag: "point", params: ["swingB"] },
        slide: { point: (p) => [p.slide, -60, 0], drag: "axis", direction: [1, 0, 0], params: ["slide"] },
      },
      views: { v: { label: "V" } },
      parts: {
        armA: { label: "A", views: ["v"], build: (kk, p) => kk.subdiv(armCage(kk.cage, p.swingA)) },
        armB: { label: "B", views: { v: (s) => s.translate([0, 80, 0]) }, build: (kk, p) => kk.subdiv(armCage(kk.cage, p.swingB)) },
        block: { label: "Block", views: { v: (s, p) => s.translate([p.slide, 0, 0]) }, build: (kk) => kk.box({ min: [-5, -65, -5], max: [5, -55, 5] }) },
      },
      parameters: [{ id: "pose", title: "Pose", controls: [
        { key: "swingA", label: "A", min: 0, max: 90, step: 1 },
        { key: "swingB", label: "B", min: 0, max: 90, step: 1 },
        { key: "slide", label: "Slide", min: 0, max: 40, step: 1 },
      ] }],
    };
    const p0 = { swingA: 0, swingB: 0, slide: 0 };
    const file = await decodedFile(two, "v", p0, ["armA", "armB", "block"]);
    // armA's positions throw when a drag copies them (after its ties have been read).
    class Unsliceable extends Float32Array { slice() { throw new Error("boom"); } }
    const a = file.meshes.find((m) => m.name === "armA");
    a.positions = Unsliceable.from(a.positions);
    const cages = createPreviewCages(two, "v", p0, file.meshes);
    expect(cages.names().sort()).toEqual(["armA", "armB"]);
    let steps = 0;
    while (cages.verifyNext()) steps++;
    expect(steps).toBe(2);
    expect(cages.names()).toEqual(["armB"]);
    expect(previewHandles(two, "v", p0, ["armA", "armB", "block"], { cageKeys: cages.keys() })).toEqual({
      shown: ["b", "slide"], hidden: { a: "swingA rebuilds armA" },
    });
  }, 120_000);
});

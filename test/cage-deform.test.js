// A cage base (src/framework/skin/cage-deform.js) and the skin controller's second kind of
// base (skin-drag.js): during a slider or handle drag on a k.subdiv(cage) body the viewer
// re-poses the last exact mesh from the live cage's points, with no worker build.
// The meshes here come from the real worker job path (`handle(..., { type: "generate" })`).
import { beforeAll, describe, expect, test, vi } from "vitest";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { resolveParams } from "../src/framework/part-model.js";
import { createCage } from "../src/framework/geometry/subdiv/cage.js";
import { createSkinDrag } from "../src/framework/skin/skin-drag.js";
import { makeCageBase, deformCage, tiesAgree } from "../src/framework/skin/cage-deform.js";
import { topologyKey } from "../src/framework/geometry/subdiv/surface.js";
import hand, { cageHand } from "../src/parts/cage-hand.js";
import { TWO_BONE } from "./fixtures/skin-fixtures.js";

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
const entryAt = (params, part = hand, name = "hand") => probePoses(part, "assembly", params, { scope: "build" }).get(name);

const A = { ...hand.defaults };
const THUMB = { ...hand.defaults, thumbCurl: 55 };
const FINGERS = Object.keys(hand.defaults).filter((key) => key !== "thumbCurl");
const ALL_CURLED = { ...hand.defaults, ...Object.fromEntries(FINGERS.map((key) => [key, 90])), thumbCurl: 50 };

// Nearest delivered vertices on a hash grid: the indices within `r` mm of a point.
function vertexGrid(P, cell = 0.25) {
  const grid = new Map(), key = (i, j, l) => `${i},${j},${l}`;
  for (let v = 0; v < P.length / 3; v++) {
    const kk = key(Math.floor(P[3 * v] / cell), Math.floor(P[3 * v + 1] / cell), Math.floor(P[3 * v + 2] / cell));
    let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(v);
  }
  // { d, near }: the nearest distance (Infinity past one cell) and every vertex within 1e-4 of it.
  return (x, y, z) => {
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell), cl = Math.floor(z / cell);
    let best = Infinity; const near = [];
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (let l = cl - 1; l <= cl + 1; l++) {
      for (const v of grid.get(key(i, j, l)) ?? []) {
        const d = Math.hypot(P[3 * v] - x, P[3 * v + 1] - y, P[3 * v + 2] - z);
        if (d < best - 1e-4) { best = d; near.length = 0; near.push(v); } else if (d < best + 1e-4) { near.push(v); best = Math.min(best, d); }
      }
    }
    return { d: best, near };
  };
}

const angleDeg = (N, v, M, u) => {
  const dot = N[3 * v] * M[3 * u] + N[3 * v + 1] * M[3 * u + 1] + N[3 * v + 2] * M[3 * u + 2];
  const len = Math.hypot(N[3 * v], N[3 * v + 1], N[3 * v + 2]) * Math.hypot(M[3 * u], M[3 * u + 1], M[3 * u + 2]);
  return (Math.acos(Math.min(1, Math.max(-1, dot / len))) * 180) / Math.PI;
};

describe("deformCage on the cage hand", () => {
  let base, mesh;
  beforeAll(async () => {
    [mesh] = await gen(hand, "assembly", A);
    base = makeCageBase(entryAt(A).cages[0], mesh.ties);
  }, 120_000);

  test("makeCageBase refuses ties made against another topology", () => {
    expect(base).toBeTruthy();
    expect(makeCageBase(entryAt(A).cages[0], { ...mesh.ties, key: "other" })).toBeNull();
    expect(makeCageBase(null, mesh.ties)).toBeNull();
  });

  // The exact build at B against the deformed base, as point sets; the cut face (the flat
  // under the wrist, the lowest delivered z) is reported apart from the skin.
  // The exact build at B against the deformed base, matched as point sets. Bands: the
  // cut face (the flat under the wrist, the lowest delivered z), the skin within 2 mm
  // above it (its exact triangles were clipped by the cut, so their normals see fewer
  // neighbours), and the rest of the skin.
  //
  // Normal bound per pose: at the base's own pose the deformed normals are the delivered
  // ones. Away from it the plan keeps the base's quad diagonals for the whole drag while
  // the exact build re-picks them at B's points, and an unweighted vertex normal follows
  // its triangle fan: 1.2° at the thumb pose, 3.6° with every digit at its max, at the
  // knuckles of a finger turned 90°. That is the only difference (the positions agree
  // to 2e-5 mm), and the swap to the exact mesh on release shows nothing at that size.
  test.each([
    ["the defaults (the base's own pose)", A, 0.1],
    ["the thumb curled", THUMB, 2],
    ["every finger and the thumb curled to the max", ALL_CURLED, 4],
  ])("from the defaults to %s: skin positions within 1e-3 mm of the exact build, normals within the bound", async (label, B, bound) => {
    const live = entryAt(B).cages[0];
    const n = mesh.positions.length;
    const P = new Float32Array(n), N = new Float32Array(n);
    expect(deformCage(base, live, P, N)).toBe(true);
    const [exact] = await gen(hand, "assembly", B);
    const near = vertexGrid(exact.positions);
    let zMin = Infinity;
    for (let i = 2; i < n; i += 3) zMin = Math.min(zMin, mesh.positions[i]);
    const bands = ["skin", "nearCut", "cap"];
    const worst = Object.fromEntries(bands.map((b) => [b, { d: 0, angle: 0, count: 0 }]));
    for (let v = 0; v < n / 3; v++) {
      const dz = mesh.positions[3 * v + 2] - zMin;
      const w = worst[dz < 1e-4 ? "cap" : dz < 2 ? "nearCut" : "skin"];
      const { d, near: us } = near(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
      w.count++;
      w.d = Math.max(w.d, d);
      // A position the exact mesh lists more than once (a seam) has several normals: the closest.
      if (us.length) w.angle = Math.max(w.angle, Math.min(...us.map((u) => angleDeg(N, v, exact.normals, u))));
    }
    console.log(`${label}: ` + bands.map((b) => `${b} ${worst[b].count} vertices, max ${worst[b].d.toExponential(2)} mm, normals max ${worst[b].angle.toFixed(3)}°`).join("; "));
    expect(worst.skin.count).toBeGreaterThan(0);
    for (const b of bands) expect(worst[b].d).toBeLessThan(1e-3);
    expect(worst.skin.angle).toBeLessThan(bound);
    expect(worst.nearCut.angle).toBeLessThan(2);
  }, 120_000);

  // A base at 90°, whose fingertip slivers have corners float32 rounding puts just outside
  // their triangles (subdiv/ties.js's TIE_ROUNDING_ULPS): re-posed back to the defaults, it
  // lands on the exact build there.
  test("a base at indexCurl 90 re-posed to the defaults: within 1e-3 mm of the exact build", async () => {
    const C = { ...A, indexCurl: 90 };
    const [m90] = await gen(hand, "assembly", C);
    expect(m90.ties).toBeTruthy();
    const b90 = makeCageBase(entryAt(C).cages[0], m90.ties);
    expect(tiesAgree(b90, m90.positions)).toBe(true);
    const n = m90.positions.length;
    const P = new Float32Array(n), N = new Float32Array(n);
    expect(deformCage(b90, entryAt(A).cages[0], P, N)).toBe(true);
    const near = vertexGrid(mesh.positions);
    let worst = 0;
    for (let v = 0; v < n / 3; v++) worst = Math.max(worst, near(P[3 * v], P[3 * v + 1], P[3 * v + 2]).d);
    expect(worst).toBeLessThan(1e-3);
  }, 120_000);

  test("the thumb pose lists the cage's faces in another order: the same topology, the base's plan", () => {
    const a = entryAt(A).cages[0], b = entryAt(THUMB).cages[0];
    const sameOrder = JSON.stringify(a.faces) === JSON.stringify(b.faces);
    console.log(`thumb pose: faces in the same order as the base: ${sameOrder}`);
    const n = mesh.positions.length;
    expect(deformCage(base, b, new Float32Array(n), new Float32Array(n))).toBe(true);
    // A face order the base does not share is still the base's topology.
    const shuffled = { ...b, faces: [...b.faces].reverse(), ids: [...b.ids].reverse() };
    expect(deformCage(base, shuffled, new Float32Array(n), new Float32Array(n))).toBe(true);
  });

  test("Review Focus 2: a cage with an extra extrude is refused and nothing is written", () => {
    const { p, d } = resolveParams(hand, A);
    const c = cageHand(createCage, p, Object.fromEntries(Object.keys(d).map((nm) => [nm, d[nm].values])));
    const s0 = c.snapshot();
    c.extrude(s0.ids[s0.ids.length - 1], { by: 3 });
    const grown = c.snapshot();
    const n = mesh.positions.length;
    const P = new Float32Array(n).fill(7), N = new Float32Array(n).fill(7);
    expect(deformCage(base, grown, P, N)).toBe(false);
    expect(P.every((x) => x === 7) && N.every((x) => x === 7)).toBe(true);
  });

  test("one deform allocates no per-vertex array of the delivered mesh", () => {
    const live = entryAt(THUMB).cages[0];
    const n = mesh.positions.length;
    const P = new Float32Array(n), N = new Float32Array(n);
    deformCage(base, live, P, N);   // warm
    const sizes = [];
    const Real = { F32: Float32Array, F64: Float64Array, U32: Uint32Array };
    const spy = (C) => new Proxy(C, { construct(T, args) { sizes.push(typeof args[0] === "number" ? args[0] : args[0]?.length); return Reflect.construct(T, args); } });
    globalThis.Float32Array = spy(Real.F32); globalThis.Float64Array = spy(Real.F64); globalThis.Uint32Array = spy(Real.U32);
    try { expect(deformCage(base, live, P, N)).toBe(true); } finally { Object.assign(globalThis, { Float32Array: Real.F32, Float64Array: Real.F64, Uint32Array: Real.U32 }); }
    // The plan's own level arrays (cage points, then each level's limit points) are the
    // only typed arrays: none is as long as the delivered mesh.
    console.log(`typed arrays allocated by one deform: ${sizes.length}, largest ${Math.max(0, ...sizes)} (delivered ${n})`);
    expect(sizes.every((s) => s < n)).toBe(true);
  });
});

// Byte-equal typed arrays (toEqual walks a million-element array slowly).
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const same = (a, b) => a.length === b.length && bytes(a).equals(bytes(b));

// A fake viewer: records every setSubVertices call with copies of what it was handed.
const fakeViewer = () => {
  const calls = [];
  return {
    calls,
    hasSubMesh: () => true,
    setSubVertices: vi.fn((name, { positions, normals }, opts) => {
      calls.push({ name, positions, normals, copy: Float32Array.from(positions), opts });
      return true;
    }),
  };
};

function controller(part = hand) {
  const params = { ...part.defaults };
  let version = 0;
  const viewer = fakeViewer();
  const probe = vi.fn(probePoses);
  const skin = createSkinDrag(part, viewer, { params, getView: () => "assembly", getParamsVersion: () => version, probe });
  const edit = (patch) => { Object.assign(params, patch); version++; };
  return { params, viewer, skin, edit, probe };
}

describe("the skin controller with a cage base", () => {
  let meshA, meshB;
  beforeAll(async () => {
    [meshA] = await gen(hand, "assembly", A);
    [meshB] = await gen(hand, "assembly", { ...A, indexCurl: 50 });
  }, 120_000);

  test("a slider sequence: deliver, change a curl, deform once; restoreAll puts the exact arrays back", () => {
    const { skin, viewer, edit } = controller();
    const exact = Float32Array.from(meshA.positions);
    skin.recordDelivered("hand", meshA, { view: "assembly", params: { ...A } });
    expect(skin.hasBase("hand")).toBe(true);
    edit({ indexCurl: 40 });
    expect(skin.canSkin("hand")).toBe(true);
    expect(skin.deform()).toEqual(["hand"]);
    expect(viewer.setSubVertices).toHaveBeenCalledTimes(1);
    expect(viewer.calls[0].opts).toEqual({ deformed: true });
    expect(same(viewer.calls[0].copy, exact)).toBe(false);
    expect(skin.isDeformed("hand")).toBe(true);
    expect(skin.isDragging()).toBe(true);
    expect(skin.restoreAll()).toEqual(["hand"]);
    const last = viewer.calls.at(-1);
    expect(last.opts).toEqual({ deformed: false });
    expect(same(last.copy, exact)).toBe(true);
    expect(skin.anyDeformed()).toBe(false);
  });

  test("back at the base's own params the exact base is shown, not a deform", () => {
    const { skin, viewer, edit } = controller();
    skin.recordDelivered("hand", meshA, { view: "assembly", params: { ...A } });
    edit({ indexCurl: 40 });
    skin.deform();
    edit({ indexCurl: A.indexCurl });
    expect(skin.deform()).toEqual([]);
    expect(viewer.calls.at(-1).opts).toEqual({ deformed: false });
    expect(skin.isDragging()).toBe(false);
  });

  test("Review Focus 1: after a new delivery, or forget, a deform never writes into the old base's arrays", () => {
    const { skin, viewer, edit } = controller();
    skin.recordDelivered("hand", meshA, { view: "assembly", params: { ...A } });
    edit({ indexCurl: 40 });
    skin.deform();
    const first = viewer.calls.at(-1);
    const firstContents = { p: Float32Array.from(first.positions), n: Float32Array.from(first.normals) };
    // A new delivery (indexCurl 50) replaces the base: its own copies, its own scratch.
    skin.recordDelivered("hand", meshB, { view: "assembly", params: { ...A, indexCurl: 50 } });
    edit({ indexCurl: 60 });
    expect(skin.deform()).toEqual(["hand"]);
    const second = viewer.calls.at(-1);
    expect(second.positions).not.toBe(first.positions);
    expect(second.normals).not.toBe(first.normals);
    expect(same(first.positions, firstContents.p)).toBe(true);
    expect(same(first.normals, firstContents.n)).toBe(true);
    const secondContents = Float32Array.from(second.positions);
    // forget: nothing deforms, nothing is written anywhere.
    skin.forget("hand");
    const calls = viewer.calls.length;
    edit({ indexCurl: 70 });
    expect(skin.deform()).toEqual([]);
    expect(viewer.calls.length).toBe(calls);
    expect(same(first.positions, firstContents.p)).toBe(true);
    expect(same(second.positions, secondContents)).toBe(true);
  });

  test("Review Focus 2: a live cage the base's plan does not fit restores the base and deforms nothing", () => {
    const viewer = fakeViewer();
    const params = { ...A };
    let version = 0;
    // The real probe, except that from version 2 its cage has one more extrude (and the
    // shapeHash is left equal, so only deformCage can refuse it).
    const probe = (part, view, p, opts) => {
      const map = probePoses(part, view, p, opts);
      if (p === params && version >= 2) {
        const e = map.get("hand");
        const { p: rp, d } = resolveParams(hand, p);
        const c = cageHand(createCage, rp, Object.fromEntries(Object.keys(d).map((nm) => [nm, d[nm].values])));
        const s = c.snapshot();
        c.extrude(s.ids[s.ids.length - 1], { by: 3 });
        map.set("hand", { ...e, cages: [c.snapshot()] });
      }
      return map;
    };
    const skin = createSkinDrag(hand, viewer, { params, getView: () => "assembly", getParamsVersion: () => version, probe });
    skin.recordDelivered("hand", meshA, { view: "assembly", params: { ...A } });
    Object.assign(params, { indexCurl: 40 }); version = 1;
    expect(skin.deform()).toEqual(["hand"]);
    Object.assign(params, { indexCurl: 45 }); version = 2;
    expect(skin.canSkin("hand")).toBe(true);   // the probe alone says yes
    expect(skin.deform()).toEqual([]);
    expect(viewer.calls.at(-1).opts).toEqual({ deformed: false });
    expect(same(viewer.calls.at(-1).copy, Float32Array.from(meshA.positions))).toBe(true);
    expect(skin.isDeformed("hand")).toBe(false);
    expect(skin.isDragging()).toBe(false);
  });

  test("a delivery with ties whose probe entry is not cage-posable is no base", () => {
    const { skin } = controller();
    skin.recordDelivered("hand", { ...meshA, frame: "posed" }, { view: "assembly", params: { ...A } });
    expect(skin.hasBase("hand")).toBe(false);
    skin.recordDelivered("hand", { ...meshA, ties: { ...meshA.ties, key: "other" } }, { view: "assembly", params: { ...A } });
    expect(skin.hasBase("hand")).toBe(false);
    skin.recordDelivered("hand", meshA, null);
    expect(skin.hasBase("hand")).toBe(false);
  });

  // The same cage with its first two faces listed the other way round: the same topology
  // (topologyKey ignores face order), but the plan's triangles come in another order.
  const swapped = (c) => {
    const faces = [...c.faces], ids = [...c.ids];
    [faces[0], faces[1]] = [faces[1], faces[0]];
    [ids[0], ids[1]] = [ids[1], ids[0]];
    return { ...c, faces, ids };
  };

  test("I2: tiesAgree places every vertex on the plan's rest surface; a face order the ties were not made against fails", () => {
    const snap = entryAt(A).cages[0];
    expect(tiesAgree(makeCageBase(snap, meshA.ties), meshA.positions)).toBe(true);
    const other = swapped(snap);
    expect(topologyKey(other)).toBe(meshA.ties.key);
    const base = makeCageBase(other, meshA.ties);
    expect(base).toBeTruthy();
    expect(tiesAgree(base, meshA.positions)).toBe(false);
  });

  test("I2: a base whose snapshot lists its faces in another order than the ties is refused at the first deform, and nothing is drawn", () => {
    const viewer = fakeViewer();
    const params = { ...A };
    let version = 0;
    // The record's probe (at the dispatch record's params) swaps two faces; the live one does not.
    const probe = (part, view, p, opts) => {
      const map = probePoses(part, view, p, opts);
      if (p !== params) { const e = map.get("hand"); map.set("hand", { ...e, cages: [swapped(e.cages[0])] }); }
      return map;
    };
    const skin = createSkinDrag(hand, viewer, { params, getView: () => "assembly", getParamsVersion: () => version, probe });
    skin.recordDelivered("hand", meshA, { view: "assembly", params: { ...A } });
    expect(skin.hasBase("hand")).toBe(true);   // the key matches: only the check can tell
    Object.assign(params, { indexCurl: 40 }); version = 1;
    expect(skin.deform()).toEqual([]);
    expect(viewer.setSubVertices).not.toHaveBeenCalled();
    expect(skin.hasBase("hand")).toBe(false);
    expect(skin.isDragging() || skin.cageDragActive()).toBe(false);
  });

  test("M1: a recorded base holds no copy of the mesh; the first deform makes them, later moves reuse them, a drag's end drops them", () => {
    // A viewer that keeps no copy of what it is handed, so every array counted is the skin's.
    const params = { ...A };
    let version = 0;
    const viewer = { hasSubMesh: () => true, setSubVertices: vi.fn(() => true) };
    const skin = createSkinDrag(hand, viewer, { params, getView: () => "assembly", getParamsVersion: () => version });
    const edit = (patch) => { Object.assign(params, patch); version++; };
    const n = meshA.positions.length;
    const sizes = [];
    const Real = { F32: Float32Array, F64: Float64Array };
    const spy = (C) => new Proxy(C, { construct(T, args) { sizes.push(typeof args[0] === "number" ? args[0] : args[0]?.length); return Reflect.construct(T, args); } });
    const big = (f) => {
      sizes.length = 0;
      globalThis.Float32Array = spy(Real.F32); globalThis.Float64Array = spy(Real.F64);
      try { f(); } finally { Object.assign(globalThis, { Float32Array: Real.F32, Float64Array: Real.F64 }); }
      return sizes.filter((x) => x >= n).length;
    };
    expect(big(() => skin.recordDelivered("hand", meshA, { view: "assembly", params: { ...A } }))).toBe(0);
    // The scratch pair (the copies are slices of the delivered arrays, made by their own constructor).
    expect(big(() => { edit({ indexCurl: 40 }); expect(skin.deform()).toEqual(["hand"]); })).toBe(2);
    expect(big(() => { edit({ indexCurl: 45 }); expect(skin.deform()).toEqual(["hand"]); })).toBe(0);
    skin.restoreAll();
    skin.endDrag();
    expect(big(() => { edit({ indexCurl: 50 }); expect(skin.deform()).toEqual(["hand"]); })).toBe(2);
  });

  test("while held, a cage base is restored and not deformed", () => {
    const { skin, viewer, edit } = controller();
    skin.recordDelivered("hand", meshA, { view: "assembly", params: { ...A } });
    edit({ indexCurl: 40 });
    skin.deform();
    const release = skin.hold();
    edit({ indexCurl: 45 });
    expect(skin.deform()).toEqual([]);
    expect(viewer.calls.at(-1).opts).toEqual({ deformed: false });
    release();
    expect(skin.deform()).toEqual(["hand"]);
  });
});

test("an implicit body and a cage body in one view both deform in one deform() call", async () => {
  const part = {
    ...hand,
    defaults: { ...hand.defaults, bend: 0 },
    parts: {
      hand: hand.parts.hand,
      tail: { build: (kk, p) => kk.implicit(TWO_BONE(p.bend)), views: { assembly: true } },
    },
  };
  const at = { view: "assembly", params: { ...part.defaults } };
  const meshes = await gen(part, "assembly", at.params);
  const byName = Object.fromEntries(meshes.map((m) => [m.name, m]));
  expect(byName.tail.bindings).toBeTruthy();
  expect(byName.hand.ties).toBeTruthy();
  const { skin, viewer, edit } = controller(part);
  for (const m of meshes) skin.recordDelivered(m.name, m, at);
  expect(skin.hasBase("hand") && skin.hasBase("tail")).toBe(true);
  edit({ bend: 30, indexCurl: 45 });
  expect(skin.deform().sort()).toEqual(["hand", "tail"]);
  expect(viewer.calls.map((c) => c.name).sort()).toEqual(["hand", "tail"]);
  expect(viewer.calls.every((c) => c.opts.deformed)).toBe(true);
}, 120_000);

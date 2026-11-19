// Pose bindings through the Manifold preview kernel (docs/superpowers/plans/2026-10-31-implicit-pose-drag.md
// Task 4): a preview k.implicit carries its per-vertex frame bindings as vertex properties
// (numProp 7) through every boolean, and toMesh decodes them per corner, keyed "<call id>:<frame>".
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import { h } from "../src/framework/geometry/solid-hash.js";
import { compileImplicit, implicitHashable } from "../src/framework/geometry/implicit/index.js";
import { implicitCallId, stripFrames } from "../src/framework/geometry/implicit/call-id.js";
import { decodeBindings, encodeBindingProps, mergeBindings, bindingCheck, BIND_CALL_STRIDE } from "../src/framework/geometry/mesh-bindings.js";
import { TWO_BONE, BALL } from "./fixtures/skin-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// Build inside a sub-part bracket, as the generate job does.
const inBracket = (fn, kernel = k) => {
  kernel.beginSubPart("t");
  try { return fn(); } finally { kernel.endSubPart(); }
};
// The corner positions of a non-indexed toMesh payload.
const corner = (m, c) => [m.positions[c * 3], m.positions[c * 3 + 1], m.positions[c * 3 + 2]];
const nameAt = (m, c) => m.bindings.frames[m.bindings.frameA[c]];

describe("call ids", () => {
  test("stripFrames drops only the frames table", () => {
    const s = stripFrames(TWO_BONE(30));
    expect(s.frames).toBeUndefined();
    expect(s.root).toEqual(TWO_BONE(30).root);
  });
  test("an ordinal counts earlier calls of the same shape", () => {
    expect(implicitCallId(BALL("child"), [])).toBe(`${h("implicit-shape", stripFrames(BALL("child")))}#0`);
    const bent = { ...BALL("child"), frames: TWO_BONE(30).frames };
    expect(implicitCallId(bent, [BALL("child")])).toBe(`${h("implicit-shape", stripFrames(bent))}#1`);
    expect(implicitCallId(bent, [TWO_BONE(0)])).toMatch(/#0$/);
  });
});

describe("bindings on the Manifold preview kernel", () => {
  test("an implicit solid's mesh carries bindings keyed by call id and frame name", () => {
    const spec = TWO_BONE(0);
    const m = inBracket(() => k.implicit(spec).toMesh());
    const id = implicitCallId(spec, []);
    expect(m.bindings.frames[0]).toBeNull();
    expect(m.bindings.frames).toEqual(expect.arrayContaining([`${id}:root`, `${id}:child`]));
    expect(m.bindings.frameA.length).toBe(m.triangles * 3);
    expect(m.bindings.frameB.length).toBe(m.triangles * 3);
    expect(m.bindings.weight.length).toBe(m.triangles * 3);
    // every corner of a lone implicit is bound
    expect(m.bindings.frameA.every((f) => f !== 0)).toBe(true);
  });

  test("bindings survive a union with another k.implicit and with a plain box", () => {
    const id0 = implicitCallId(TWO_BONE(0), []);
    const id1 = implicitCallId(BALL("child"), [TWO_BONE(0)]);
    const m = inBracket(() => k.union([
      k.implicit(TWO_BONE(0)), k.implicit(BALL("child")), k.box([27, -3, -3], [33, 3, 3]),
    ]).toMesh());
    expect(m.bindings.frameA.length).toBe(m.triangles * 3);
    let box = 0, low = 0, ball = 0;
    for (let c = 0; c < m.triangles * 3; c++) {
      const [x, y] = corner(m, c);
      if (x > 25) { expect(m.bindings.frameA[c]).toBe(0); box++; continue; }
      if (y < 10) { expect(nameAt(m, c)).toBe(`${id0}:root`); low++; }
      if (nameAt(m, c)?.startsWith(id1)) ball++;
    }
    expect(box).toBeGreaterThan(0);
    expect(low).toBeGreaterThan(0);
    expect(ball).toBeGreaterThan(0);
  });

  test("a boolean seam's cut vertices decode unbound or to their own frame, never another", () => {
    const id0 = implicitCallId(TWO_BONE(0), []);
    const m = inBracket(() => k.union([k.implicit(TWO_BONE(0)), k.box([0, 2, -2], [10, 8, 2])]).toMesh());
    let seam = 0;
    for (let c = 0; c < m.triangles * 3; c++) {
      const [x, y] = corner(m, c);
      if (y >= 12) continue;
      const f = m.bindings.frameA[c];
      if (f !== 0) expect(m.bindings.frames[f]).toBe(`${id0}:root`);
      if (x > 4.5) expect(f).toBe(0);
      if (y > 2 && y < 8 && x > 0 && x < 4.5 && f === 0) seam++;
    }
    expect(seam).toBeGreaterThan(0);   // unbound corners where the box meets the capsule (cut vertices, box faces)
  });

  test("seams between overlapping implicits leave no implicit corner unbound; a box's stay unbound", () => {
    // A framed ball straddling the joint (its seam with the bones crosses both frames), and a
    // box cut into the root bone. Every corner off the box is an implicit's and must be bound.
    const id0 = implicitCallId(TWO_BONE(0), []);
    const ballSpec = BALL("child", [0, 0, 4]);
    const m = inBracket(() => k.union([k.implicit(TWO_BONE(0)), k.implicit(ballSpec), k.box([3, 2, -2], [10, 8, 2])]).toMesh());
    const inBox = ([x, y, z]) => x >= 3 - 1e-4 && x <= 10 + 1e-4 && y >= 2 - 1e-4 && y <= 8 + 1e-4 && z >= -2 - 1e-4 && z <= 2 + 1e-4;
    let offBoxUnbound = 0, boxOnly = 0;
    for (let c = 0; c < m.triangles * 3; c++) {
      const p = corner(m, c), f = m.bindings.frameA[c];
      if (!inBox(p) && f === 0) offBoxUnbound++;
      if (p[0] > 4.5) { expect(f).toBe(0); boxOnly++; }
      if (f !== 0 && p[1] < 10) expect(m.bindings.frames[f]).toBe(`${id0}:root`);
    }
    expect(offBoxUnbound).toBe(0);
    expect(boxOnly).toBeGreaterThan(0);
  });

  test("two calls sharing a frame name decode to their own call ids", () => {
    const a = TWO_BONE(0), b = { ...BALL("child"), frames: TWO_BONE(0).frames };
    const id0 = implicitCallId(a, []), id1 = implicitCallId(b, [a]);
    expect(id0).not.toBe(id1);
    const m = inBracket(() => k.union([k.implicit(a), k.implicit(b)]).toMesh());
    expect(m.bindings.frames).toEqual(expect.arrayContaining([`${id0}:child`, `${id1}:child`]));
  });

  test("two calls of one shape at different frames get ordinals #0 and #1", () => {
    const a = BALL("child"), b = { ...BALL("child"), frames: TWO_BONE(30).frames };
    const id0 = implicitCallId(a, []), id1 = implicitCallId(b, [a]);
    expect(id0.endsWith("#0")).toBe(true);
    expect(id1.endsWith("#1")).toBe(true);
    expect(id0.slice(0, -2)).toBe(id1.slice(0, -2));
    const m = inBracket(() => k.union([k.implicit(a), k.implicit(b)]).toMesh());
    expect(m.bindings.frames).toEqual(expect.arrayContaining([`${id0}:child`, `${id1}:child`]));
  });

  test("the print tier carries no bindings and its solid hash is unchanged", async () => {
    const kp = await bootManifoldKernel({ quality: "print" });
    const spec = TWO_BONE(0);
    const s = inBracket(() => kp.implicit(spec), kp);
    const m = inBracket(() => kp.implicit(spec).toMesh(), kp);
    expect(m.bindings).toBeUndefined();
    const { preview, resolution, ...rest } = spec;
    const compiled = compileImplicit(spec);
    expect(s._hash).toBe(h("implicit", implicitHashable({ ...rest, resolution: 1 }, compiled), "print"));
  });

  test("a toMesh outside a sub-part bracket carries no bindings", () => {
    const s = inBracket(() => k.implicit(TWO_BONE(0)));   // endSubPart ran first
    expect(s.toMesh().bindings).toBeUndefined();
    expect(k.implicit(TWO_BONE(0)).toMesh().bindings).toBeUndefined();   // never bracketed
  });

  test("a frameless implicit keeps its old key and no props", () => {
    const ball = { root: { kind: "sphere", r: 5 }, preview: 1 };
    const s = inBracket(() => { k.implicit(TWO_BONE(0)); return k.implicit(ball); });
    expect(s._hash).toBe(h("implicit", implicitHashable(ball, compileImplicit(ball)), "preview"));
    expect(inBracket(() => k.implicit(ball).toMesh()).bindings).toBeUndefined();
  });
});

describe("decodeBindings", () => {
  const calls = [{ id: "A#0", frames: ["root", "child"] }, { id: "B#0", frames: ["x"] }];
  const check = bindingCheck;
  const mesh = (rows) => ({
    numProp: 7,
    vertProperties: Float32Array.from(rows.flatMap((r, i) => [i, 0, 0, ...r])),
    triVerts: Uint32Array.from(rows.map((_, i) => i)),
  });

  test("an interpolated or check-failing code is unbound", () => {
    const g = mesh([
      [1025.5, 0, 1, 0],                        // interpolated code
      [1025, 1, 0.5, (check(1025, 1) + 1) % 65521], // check fails
      [1, 2, 0.75, check(1, 2)],                // valid: A#0 root blended toward A#0 child
      [1025, 0, 1, check(1025, 0)],             // valid: B#0 x alone
      [3, 0, 1, check(3, 0)],                   // slot 0 has only 2 frames
      [1, 2, 1.5, check(1, 2)],                 // weight out of range
    ]);
    const b = decodeBindings(g, calls);
    expect(Array.from(b.frameA)).toEqual([0, 0, 1, 3, 0, 0]);
    expect(Array.from(b.frameB)).toEqual([0, 0, 2, 0, 0, 0]);
    expect(Array.from(b.weight)).toEqual([1, 1, 0.75, 1, 1, 1]);
    expect(b.frames).toEqual([null, "A#0:root", "A#0:child", "B#0:x"]);
  });

  test("the midpoint of two valid triples is not a valid third (the check is not affine)", () => {
    // codes 1 and 3 of slot 0, interpolated at t = ½: integer codes (2, 0), averaged check.
    // An affine check ((a·31 + b) mod 97) would accept it as frame 2.
    const mid = [2, 0, 1, (check(1, 0) + check(3, 0)) / 2];
    const b = decodeBindings(mesh([mid, [1, 0, 1, check(1, 0)], [3, 0, 1, check(3, 0)]]), [{ id: "A#0", frames: ["p", "q", "r"] }]);
    expect(Array.from(b.frameA)).toEqual([0, 1, 2]);
  });

  test("repair binds an unbound corner of a call's run through rebind, and leaves other runs unbound", () => {
    // two triangles, run 0 (a call's) and run 1 (a plain solid's), every vertex interpolated
    const rows = [[1.5, 0, 1, 0], [1.5, 0, 1, 0], [1.5, 0, 1, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const g = { ...mesh(rows), runIndex: Uint32Array.of(0, 3, 6), runOriginalID: Uint32Array.of(7, 8) };
    const seen = [];
    const rebind = (slot, run, xyz) => {
      seen.push([slot, run, Array.from(xyz)]);
      return { frameA: Uint16Array.of(2, 1, 0), frameB: Uint16Array.of(1, 0, 0), weight: Float32Array.of(0.8, 1, 1) };
    };
    const b = decodeBindings(g, calls, { runSlot: (r) => (r === 0 ? 0 : -1), rebind });
    expect(seen).toEqual([[0, 0, [0, 0, 0, 1, 0, 0, 2, 0, 0]]]);
    expect(Array.from(b.frameA)).toEqual([1, 2, 0, 0, 0, 0]);
    expect(Array.from(b.frameB)).toEqual([2, 0, 0, 0, 0, 0]);
    expect(Array.from(b.weight)).toEqual([Math.fround(0.8), 1, 1, 1, 1, 1]);
    expect(b.frames).toEqual([null, "A#0:child", "A#0:root"]);
  });

  test("a bad second code keeps the first frame at full weight", () => {
    const g = mesh([[1, 7, 0.6, check(1, 7)]]);
    const b = decodeBindings(g, calls);
    expect([b.frameA[0], b.frameB[0], b.weight[0]]).toEqual([1, 0, 1]);
  });

  test("null without props or without calls", () => {
    expect(decodeBindings({ numProp: 3, vertProperties: new Float32Array(9), triVerts: Uint32Array.of(0, 1, 2) }, calls)).toBeNull();
    expect(decodeBindings(mesh([[1, 0, 1, check(1, 0)]]), [])).toBeNull();
  });

  test("encodeBindingProps round-trips through decode", () => {
    const bind = { frameA: Uint16Array.of(1, 2, 0), frameB: Uint16Array.of(2, 0, 0), weight: Float32Array.of(0.625, 1, 1) };
    const props = encodeBindingProps(bind, 1);
    expect(Array.from(props.subarray(0, 4))).toEqual([BIND_CALL_STRIDE + 1, BIND_CALL_STRIDE + 2, 0.625, check(1025, 1026)]);
    expect(Array.from(props.subarray(8, 12))).toEqual([0, 0, 1, check(0, 0)]);
    const vp = new Float32Array(3 * 7);
    for (let v = 0; v < 3; v++) vp.set(props.subarray(v * 4, v * 4 + 4), v * 7 + 3);
    const b = decodeBindings({ numProp: 7, vertProperties: vp, triVerts: Uint32Array.of(0, 1, 2) },
      [{ id: "A#0", frames: ["p"] }, { id: "C#0", frames: ["u", "v"] }]);
    expect(Array.from(b.frameA)).toEqual([1, 2, 0]);
    expect(Array.from(b.frameB)).toEqual([2, 0, 0]);
    expect(b.frames).toEqual([null, "C#0:u", "C#0:v"]);
  });
});

describe("mergeBindings", () => {
  test("concatenates corners under one frame table, an unbound entry contributing zeros", () => {
    const a = { frameA: Uint16Array.of(1, 2), frameB: Uint16Array.of(0, 1), weight: Float32Array.of(1, 0.5), frames: [null, "X#0:a", "X#0:b"] };
    const b = { frameA: Uint16Array.of(1), frameB: Uint16Array.of(2), weight: Float32Array.of(0.75), frames: [null, "X#0:b", "Y#0:c"] };
    const m = mergeBindings([a, undefined, b], [2, 3, 1]);
    expect(m.frames).toEqual([null, "X#0:a", "X#0:b", "Y#0:c"]);
    expect(Array.from(m.frameA)).toEqual([1, 2, 0, 0, 0, 2]);
    expect(Array.from(m.frameB)).toEqual([0, 1, 0, 0, 0, 3]);
    expect(Array.from(m.weight)).toEqual([1, 0.5, 1, 1, 1, 0.75]);
  });
  test("null when no entry has bindings", () => {
    expect(mergeBindings([undefined, null], [3, 3])).toBeNull();
  });
});

describe("the generate job", () => {
  test("the generate job posts bindings and transfers their buffers", async () => {
    const part = {
      meta: { title: "Skin", units: "mm" },
      parameters: [],
      defaults: {},
      parts: { body: { label: "Body", views: ["assembly"], build: (kk) => kk.implicit(TWO_BONE(0)) } },
      views: { assembly: { label: "Assembly" } },
    };
    const posted = [];
    await handle(k, part, { type: "generate", subparts: ["body"], view: "assembly", params: {} }, (m, transfer = []) => posted.push([m, transfer]));
    const [msg, transfer] = posted.find(([m]) => m.type === "meshes");
    const b = msg.meshes[0].bindings;
    expect(b).toBeDefined();
    expect(b.frameA.length).toBe(msg.meshes[0].triangles * 3);
    expect(transfer).toContain(b.frameA.buffer);
    expect(transfer).toContain(b.frameB.buffer);
    expect(transfer).toContain(b.weight.buffer);
  });
});

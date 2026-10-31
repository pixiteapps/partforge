// Two-stage delivery for unions of implicit bodies (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md
// §5): an armed preview kernel defers a union of k.implicit results' boolean-gate judgment
// and hands out its operands once, so the generate job can post them concatenated
// (`meshes-provisional`) before the real union. Nothing exact ever reads the provisional stage.
import { describe, test, expect, beforeAll } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { handle } from "../src/framework/jobs.js";
import { buildView } from "../src/framework/oracle/build.js";
import { implicitCallId } from "../src/framework/geometry/implicit/call-id.js";
import { concatMeshPayloads } from "../src/framework/geometry/mesh-concat.js";
import { TWO_BONE, BALL } from "./fixtures/skin-fixtures.js";

let wasm;
const kernel = (quality = "preview") => createManifoldKernel(wasm, { quality });
beforeAll(async () => { wasm = await Module(); wasm.setup(); });

// Build inside a sub-part bracket, as the generate job does.
const inBracket = (k, fn) => {
  k.beginSubPart("t");
  try { return fn(); } finally { k.endSubPart(); }
};
const pair = (k) => k.union([k.implicit(TWO_BONE(0)), k.implicit(BALL("child"))]);
const bytes = (m) => ({ positions: Array.from(m.positions), normals: Array.from(m.normals), edges: Array.from(m.edges) });
const boundsOf = (positions) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[i + a]); max[a] = Math.max(max[a], positions[i + a]); }
  }
  return { min, max };
};

describe("the deferred union on the Manifold preview kernel", () => {
  test("an armed preview union of implicit results hands out its pieces once, then the real union", () => {
    const k = kernel();
    k.setProvisionalUnions(true);
    let pieces, again, m;
    inBracket(k, () => {
      const s = pair(k);
      pieces = k.takeProvisionalPieces(s);
      again = k.takeProvisionalPieces(s);
      m = s.toMesh();
    });
    expect(pieces).toHaveLength(2);
    expect(again).toBeNull();
    const ref = kernel();
    const want = inBracket(ref, () => pair(ref).toMesh());
    expect(bytes(m)).toEqual(bytes(want));
    expect(m.triangles).toBe(want.triangles);
  });

  test("the pieces' meshes carry their bindings when read inside the bracket", () => {
    const k = kernel();
    k.setProvisionalUnions(true);
    const ms = inBracket(k, () => {
      const s = pair(k);
      const out = k.takeProvisionalPieces(s).map((p) => p.toMesh({ quality: "preview" }));
      s.toMesh();
      return out;
    });
    const id0 = implicitCallId(TWO_BONE(0), []), id1 = implicitCallId(BALL("child"), [TWO_BONE(0)]);
    expect(ms[0].bindings.frames).toEqual(expect.arrayContaining([`${id0}:root`, `${id0}:child`]));
    expect(ms[1].bindings.frames).toEqual(expect.arrayContaining([`${id1}:child`]));
  });

  test("a trailing rigid step is replayed onto the pieces", () => {
    const k = kernel();
    k.setProvisionalUnions(true);
    const ref = kernel();
    const plain = inBracket(ref, () => [ref.implicit(TWO_BONE(0)), ref.implicit(BALL("child"))].map((s) => boundsOf(s.toMesh().positions)));
    const moved = inBracket(k, () => {
      const s = pair(k).translate([5, 0, 0]);
      const pieces = k.takeProvisionalPieces(s);
      const out = pieces.map((p) => boundsOf(p.toMesh().positions));
      s.toMesh();
      return out;
    });
    expect(moved).toHaveLength(2);
    moved.forEach((b, i) => {
      expect(b.min[0]).toBeCloseTo(plain[i].min[0] + 5, 4);
      expect(b.max[0]).toBeCloseTo(plain[i].max[0] + 5, 4);
      expect(b.min[1]).toBeCloseTo(plain[i].min[1], 4);
    });
  });

  test.each([
    ["a cut after the union", (k) => pair(k).cut(k.box([0, 0, 0], [2, 2, 2]))],
    ["a mirror after the union", (k) => pair(k).mirror("YZ")],
    ["a union of two plain boxes", (k) => k.union([k.box([0, 0, 0], [1, 1, 1]), k.box([2, 0, 0], [3, 1, 1])])],
  ])("no pieces: %s", (_, build) => {
    const k = kernel();
    k.setProvisionalUnions(true);
    inBracket(k, () => {
      const s = build(k);
      expect(k.takeProvisionalPieces(s)).toBeNull();
      expect(s.toMesh().triangles).toBeGreaterThan(0);
    });
  });

  test("no pieces: unarmed", () => {
    const k = kernel();
    inBracket(k, () => {
      const s = pair(k);
      expect(k.takeProvisionalPieces(s)).toBeNull();
    });
  });

  test("no pieces: print quality", () => {
    const k = kernel("print");
    k.setProvisionalUnions(true);
    inBracket(k, () => {
      const s = k.union([k.implicit({ ...TWO_BONE(0), resolution: 2 }), k.implicit({ ...BALL("child"), resolution: 2 })]);
      expect(k.takeProvisionalPieces(s)).toBeNull();
    });
  });

  test("the memory is cleared when the bracket closes", () => {
    const k = kernel();
    k.setProvisionalUnions(true);
    let s;
    inBracket(k, () => { s = pair(k); });
    expect(k.takeProvisionalPieces(s)).toBeNull();
    inBracket(k, () => { s.toMesh(); });
  });

  test("the deferred judgment still refuses an impossible union, at first read and every later read", () => {
    const k = kernel();
    k.setProvisionalUnions(true);
    const bad = wasm.Manifold.cylinder(0, 1, 1, 8); // InvalidConstruction, as an empty profile's extrude
    expect(bad.status()).not.toBe("NoError");
    const badSolid = { _m: bad, _hash: "bad-operand", _canon: { m: bad, hash: "bad-operand", chain: [] } };
    inBracket(k, () => {
      const s = k.union([k.implicit(TWO_BONE(0)), badSolid]); // deferred: no throw yet
      expect(() => s.toMesh()).toThrow(/union: operand 1 is not a valid solid/);
      expect(() => s.toMesh()).toThrow(/union: operand 1 is not a valid solid/);
      expect(() => s.volume()).toThrow(/union: operand 1 is not a valid solid/);
      expect(() => s.boundingBox()).toThrow(/union: operand 1 is not a valid solid/);
    });
    // Unarmed, the same union refuses at once.
    const u = kernel();
    inBracket(u, () => {
      expect(() => u.union([u.implicit(TWO_BONE(0)), badSolid])).toThrow(/union: operand 1 is not a valid solid/);
    });
  });

  test("a deferred union's failed judgment reaches an op built on it", () => {
    const k = kernel();
    k.setProvisionalUnions(true);
    const bad = wasm.Manifold.cylinder(0, 1, 1, 8);
    const badSolid = { _m: bad, _hash: "bad-operand-2", _canon: { m: bad, hash: "bad-operand-2", chain: [] } };
    inBracket(k, () => {
      const s = k.union([k.implicit(TWO_BONE(0)), badSolid]);
      expect(() => s.mirror("YZ").toMesh()).toThrow(/union: operand 1 is not a valid solid/);
      expect(() => s.translate([1, 0, 0]).toMesh()).toThrow(/union: operand 1 is not a valid solid/);
    });
  });
});

describe("concatMeshPayloads", () => {
  test("concatenates non-indexed payloads, drops feature arrays, merges bindings", () => {
    const a = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), triangles: 1,
      edges: Float32Array.of(0, 0, 0, 1, 0, 0), featureIds: Uint32Array.of(1), features: [{ id: 1 }],
      bindings: { frameA: Uint16Array.of(1, 1, 1), frameB: Uint16Array.of(0, 0, 0), weight: Float32Array.of(1, 1, 1), frames: [null, "a:root"] } };
    const b = { positions: Float32Array.of(5, 5, 5, 6, 5, 5, 5, 6, 5), normals: Float32Array.of(1, 0, 0, 1, 0, 0, 1, 0, 0), triangles: 1,
      edges: new Float32Array(0) };
    const c = concatMeshPayloads([a, b]);
    expect(c.triangles).toBe(2);
    expect(Array.from(c.positions)).toEqual([...a.positions, ...b.positions]);
    expect(Array.from(c.normals)).toEqual([...a.normals, ...b.normals]);
    expect(Array.from(c.edges)).toEqual([...a.edges]);
    expect(c.featureIds).toBeUndefined();
    expect(c.features).toBeUndefined();
    expect(c.bindings.frames).toEqual([null, "a:root"]);
    expect(Array.from(c.bindings.frameA)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(concatMeshPayloads([b, b]).bindings).toBeUndefined();
  });
  test("refuses an indexed payload", () => {
    expect(() => concatMeshPayloads([{ positions: new Float32Array(9), indices: Uint32Array.of(0, 1, 2), triangles: 1 }])).toThrow(/indexed/);
  });
});

describe("the generate job", () => {
  const part = {
    meta: { title: "Two stage", backend: "manifold" },
    defaults: {},
    views: { v: { label: "V" } },
    parts: { body: { label: "Body", views: ["v"], build: (k) => pair(k) } },
    parameters: [],
  };

  test("the generate job posts the provisional stage, then the union; inspect's buildView never sees it", async () => {
    const k = kernel();
    const posted = [];
    await handle(k, part, { type: "generate", subparts: ["body"], view: "v", params: {} }, (m) => posted.push(m));
    const types = posted.map((m) => m.type).filter((t) => t !== "progress");
    expect(types).toEqual(["meshes-provisional", "meshes"]);
    const prov = posted.find((m) => m.type === "meshes-provisional").meshes[0];
    const fin = posted.find((m) => m.type === "meshes").meshes[0];
    expect(prov.name).toBe("body");
    expect(prov.provisional).toBe(true);
    expect(prov.frame).toBe("canonical");
    const k2 = kernel();
    const pieceTris = inBracket(k2, () =>
      [k2.implicit(TWO_BONE(0)), k2.implicit(BALL("child"))].reduce((s, p) => s + p.toMesh().triangles, 0));
    expect(prov.triangles).toBe(pieceTris);
    const id0 = implicitCallId(TWO_BONE(0), []), id1 = implicitCallId(BALL("child"), [TWO_BONE(0)]);
    expect(prov.bindings.frames).toEqual(expect.arrayContaining([`${id0}:root`, `${id0}:child`, `${id1}:child`]));
    expect(fin.provisional).toBeUndefined();
    const k3 = kernel();
    const union = inBracket(k3, () => pair(k3).toMesh());
    expect(Array.from(fin.positions)).toEqual(Array.from(union.positions));
    expect(Array.from(prov.positions)).not.toEqual(Array.from(fin.positions));
    // The kernel is disarmed after the job: inspect's build gets the union alone.
    const view = buildView(k, part, "v");
    expect(view[0].mesh.triangles).toBe(fin.triangles);
    expect(k.takeProvisionalPieces(view[0].solid)).toBeNull();
  });

  test("the provisional stage of a stale build is not posted", async () => {
    const k = kernel();
    let started = false;
    const stalePart = { ...part, parts: { body: { ...part.parts.body, build: (k2) => { started = true; return pair(k2); } } } };
    const posted = [];
    await handle(k, stalePart, { type: "generate", subparts: ["body"], view: "v", params: {} }, (m) => posted.push(m), { isStale: () => started });
    expect(posted.map((m) => m.type)).not.toContain("meshes-provisional");
    expect(posted.map((m) => m.type)).toContain("meshes");
  });

  test("capture-generate never arms the deferral", async () => {
    const k = kernel();
    const posted = [];
    await handle(k, part, { type: "capture-generate", jobId: 1, subparts: ["body"], view: "v", params: {} }, (m) => posted.push(m));
    expect(posted.map((m) => m.type)).not.toContain("meshes-provisional");
  });
});

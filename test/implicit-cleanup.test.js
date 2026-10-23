// test/implicit-cleanup.test.js
import { createHash } from "node:crypto";
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { meshStoreOwners } from "../src/framework/geometry/implicit/mesher-owners.js";
import { cleanupMesh, CLEANUP, DECIMATE, PREVIEW_CLEANUP, relax } from "../src/framework/geometry/implicit/cleanup.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { cutCreases, untangle } from "../src/framework/geometry/implicit/crease.js";
import { applySurfaceDetail } from "../src/framework/geometry/implicit/detail.js";
import { core, coreStatus, setCoreEnabled } from "../src/framework/core/core.js";
import { handSpec, vaseSpec } from "./fixtures/implicit-trees.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { edgeCheck, eulerChar } from "./helpers/mesh-topology.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const minAngles = (P, T) => {
  const out = [];
  for (let t = 0; t < T.length; t += 3) {
    const v = [0, 1, 2].map((c) => [P[3 * T[t + c]], P[3 * T[t + c] + 1], P[3 * T[t + c] + 2]]);
    let m = Math.PI;
    for (let c = 0; c < 3; c++) {
      const a = v[c], b = v[(c + 1) % 3], d = v[(c + 2) % 3];
      const u = b.map((x, i) => x - a[i]), w = d.map((x, i) => x - a[i]);
      const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
      m = Math.min(m, Math.acos(Math.max(-1, Math.min(1, cos))));
    }
    out.push(m);
  }
  return out.sort((a, b) => a - b);
};

describe("cleanup", () => {
  for (const [name, spec] of Object.entries(TREES)) for (const [tier, opts] of [["CLEANUP", CLEANUP], ["PREVIEW_CLEANUP", PREVIEW_CLEANUP]]) {
    test(`${name}, ${tier}: topology kept, slivers gone, vertices on the surface, triangles better`, () => {
      // The plain (non-owner) pipeline, which a nested contact still takes: the approximate field.
      const c = lowerSpec(spec, { images: new Map(), exactContact: false });
      const edge = 0.8, store = sampleField(c, edge), raw = meshStore(store);
      const out = cleanupMesh(store, raw, opts);
      expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      expect(eulerChar(out.positions, out.indices)).toBe(eulerChar(raw.positions, raw.indices));
      // A bend's branch cut makes the field discontinuous; "distance to the surface" means nothing
      // within a cell of the jump (the bendCut tree puts it inside the rounded surface on purpose).
      const nearJump = (x, y, z, d) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .some(([a, b, e]) => Math.abs(evalReference(c, x + a * edge, y + b * edge, z + e * edge, edge) - d) > 4 * edge);
      let worst = 0, skipped = 0;
      for (let v = 0; v < out.positions.length / 3; v++) {
        const x = out.positions[3 * v], y = out.positions[3 * v + 1], z = out.positions[3 * v + 2], d = evalReference(c, x, y, z, edge);   // the field at the grid edge it was meshed at (a contact's clearance)
        if (nearJump(x, y, z, d)) { skipped++; continue; }
        worst = Math.max(worst, Math.abs(d));
      }
      // The skipped share moves with the grid's phase against the cut, not with cleanup: bendCut
      // measured 0.075–0.109 over edges 0.6–1.0 (0.103 at 0.8 once round pads by r / G). Bound 0.12.
      // Decimated, the smooth skin thins while the band beside the cut keeps its triangles (the
      // spread guard), so the share is larger: 0.137–0.174 over edges 0.6–1.0 (0.174 at 0.8). Bound 0.2.
      expect(skipped).toBeLessThan((opts === CLEANUP ? 0.12 : 0.2) * (out.positions.length / 3));
      expect(worst).toBeLessThan(0.05 * edge);
      const before = minAngles(raw.positions, raw.indices), after = minAngles(out.positions, out.indices);
      expect(after[Math.floor(after.length * 0.05)]).toBeGreaterThan(before[Math.floor(before.length * 0.05)]);
      expect(out.normals.length).toBe(out.positions.length);
    });
  }
  // The exact (default) path for the contact* trees: the owner mesher's raw mesh, cleaned up by the
  // owner-aware cleanup. Same invariants as above, in their exact-path form: pinned vertices (exactly
  // on a gap face) are not on the contact field's zero set, so they are exempt from the surface
  // test; every other vertex must sit on a piece's surface. Compared on the JS stages (the native
  // port is held bit-identical by test/core-parity.test.js).
  for (const [name, spec] of Object.entries(TREES).filter(([n]) => n.startsWith("contact"))) for (const [tier, opts] of [["CLEANUP", CLEANUP], ["PREVIEW_CLEANUP", PREVIEW_CLEANUP]]) {
    test(`${name}, exact owner path, ${tier}: topology kept, slivers gone, vertices on the surface, triangles better`, () => {
      const c = compileImplicit(spec), edge = 0.8;
      expect(c.ownerRoot, "a root contact takes the owner path").toBeGreaterThanOrEqual(0);
      const store = evaluateLeaves(planLeaves(c, edge)), raw = meshStoreOwners(store, { gap: c.ir.nodes[c.ownerRoot].gap });
      const out = cleanupMesh(store, raw, opts);
      expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      expect(eulerChar(out.positions, out.indices)).toBe(eulerChar(raw.positions, raw.indices));
      expect(out.vertOwner.length).toBe(out.positions.length / 3);
      let worst = 0, checked = 0;
      for (let v = 0; v < out.vertOwner.length; v++) {
        if (out.pinned[v]) continue;
        const d = evalReference(c, out.positions[3 * v], out.positions[3 * v + 1], out.positions[3 * v + 2], edge);
        checked++;
        worst = Math.max(worst, Math.abs(d));
      }
      expect(checked).toBeGreaterThan(0);
      expect(worst).toBeLessThan(0.05 * edge);
      const before = minAngles(raw.positions, raw.indices), after = minAngles(out.positions, out.indices);
      expect(after[Math.floor(after.length * 0.05)]).toBeGreaterThan(before[Math.floor(before.length * 0.05)]);
      expect(out.normals.length).toBe(out.positions.length);
      if (opts === PREVIEW_CLEANUP) expect(out.indices.length).toBeLessThanOrEqual(cleanupMesh(store, raw, CLEANUP).indices.length);
    });
  }
  // contactThree, its first capsule's tip swept through 12 press depths, at bulge 0 and the
  // default bulge: the Task 3 failure (0.056·edge at the default bulge, the bulge's swell
  // putting the clearance cut's crease on the second capsule's far side) is gone.
  test("contactThree over a sweep of press depths, bulge 0 and default, CLEANUP: vertices on the surface", () => {
    const edge = 0.8;
    for (const bulge of [0, undefined]) for (let s = 0; s < 12; s++) {
      const spec = structuredClone(TREES.contactThree);
      if (bulge === undefined) delete spec.root.bulge; else spec.root.bulge = bulge;
      spec.root.children[0].b = [-1 + (s - 6) * 0.07, 0, 0];
      const c = lowerSpec(spec, { images: new Map() });
      const store = sampleField(c, edge), out = cleanupMesh(store, meshStore(store), CLEANUP);
      let worst = 0;
      for (let v = 0; v < out.positions.length / 3; v++) worst = Math.max(worst, Math.abs(evalReference(c, out.positions[3 * v], out.positions[3 * v + 1], out.positions[3 * v + 2], edge)));
      expect(worst, `bulge ${bulge ?? "default"}, tip at x = ${spec.root.children[0].b[0].toFixed(2)}`).toBeLessThan(0.05 * edge);
    }
  });
  test("deterministic: two runs are byte-identical", () => {
    const c = lowerSpec(TREES.blobs, { images: new Map() });
    const run = () => { const s = sampleField(c, 0.8); return cleanupMesh(s, meshStore(s)); };
    const a = run(), b = run();
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
  test("defaults are the documented ones", () => {
    expect(CLEANUP).toEqual({ collapseFrac: 0.2, relaxPasses: 2, relaxWeight: 0.5, maxMoveCells: 0.5 });
    expect(DECIMATE).toEqual({ decimateFrac: 0.7, decimatePasses: 4, decimateMinAngle: 15, decimateMaxTurn: 20, decimateMaxSpread: 12, decimateMinAccept: 0.4, decimateMinGain: 0.2 });
    expect(PREVIEW_CLEANUP).toEqual({ ...CLEANUP, ...DECIMATE });
  });
  for (const [name, spec] of Object.entries(TREES)) {
    // The probe skips decimation where its guards would refuse most collapses (carved,
    // shells, warps, repeats and formula allow 1–33%); bendCut allows 48%.
    test(`${name}: decimation never adds triangles${name === "bendCut" ? ", and removes some" : ""}`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      const store = sampleField(c, 0.8), raw = meshStore(store);
      const dec = cleanupMesh(store, raw, PREVIEW_CLEANUP).indices.length, plain = cleanupMesh(store, raw).indices.length;
      if (name === "bendCut") expect(dec).toBeLessThan(plain);
      else expect(dec).toBeLessThanOrEqual(plain);
    });
  }
});

// The preview tier decimates; every other tier must clean up exactly as before
// decimation existed. Each digest is the first 16 hex digits of a sha256 over the
// meshImplicit result's positions (Float64Array), indices (Uint32Array) and normals
// (Float64Array) bytes, in that order, for the case's spec and grid; they were
// recorded from commit 1882699c, the last before decimation, JS and core alike. The hand is pinned compiled with
// `exactContact: false`: a default (exact) hand meshes through the owner path, whose own tier
// behaviour test/core-parity.test.js and test/implicit-seam-quality.test.js hold; this pin is the
// plain pipeline a nested contact takes. A deliberate change to print-tier meshing changes the digests: re-record by printing
// digest(meshImplicit(compiled, edge, { tier: "print" })) for each case.
describe("tiers", () => {
  const withCoreOff = (fn) => { setCoreEnabled(false); try { return fn(); } finally { setCoreEnabled(true); } };
  const digest = (o) => {
    const h = createHash("sha256");
    for (const k of ["positions", "indices", "normals"]) h.update(Buffer.from(o[k].buffer, o[k].byteOffset, o[k].byteLength));
    return h.digest("hex").slice(0, 16);
  };
  const vase = vaseSpec();
  // [name, compile, grid, pinned digest, preview triangles at most this share of print's;
  // null: the probe skips decimation, so preview IS the print-tier mesh]
  const CASES = [["hand (approximate contact)", () => compileImplicit(handSpec(), { exactContact: false }), 1.5, "3fb192ea59869410", 0.5], ["vase", () => compileImplicit(vase.spec, { images: vase.images }), 1.2, "bd023b59990de4ed", null]];
  for (const [name, compile, edge, pinned, maxPreview] of CASES) {
    test(`${name}: print tier is the JS stages run with decimateFrac 0, byte for byte`, () => {
      const compiled = compile(), plan = planLeaves(compiled, edge), store = evaluateLeaves(plan);
      let mesh = cleanupMesh(store, meshStore(store), { ...PREVIEW_CLEANUP, decimateFrac: 0 });
      if (compiled.detail.length) mesh = applySurfaceDetail(store, mesh, compiled);
      expect(digest(mesh)).toBe(pinned);
      expect(digest(withCoreOff(() => meshImplicit(compiled, edge, { tier: "print" })))).toBe(pinned);
    }, 120_000);
    test(`${name}: print tier (and no tier) is byte-for-byte the pre-decimation mesh, core on and off; preview is smaller`, () => {
      const compiled = compile();
      try {
        for (const on of [true, false]) {
          setCoreEnabled(on);
          const refused = coreStatus().refusedMeshes;
          if (on) expect(core(), "the core is on").not.toBeNull();
          const print = meshImplicit(compiled, edge, { tier: "print" });
          expect(digest(print), `core ${on ? "on" : "off"}`).toBe(pinned);
          expect(digest(meshImplicit(compiled, edge))).toBe(pinned);
          const preview = meshImplicit(compiled, edge, { tier: "preview" });
          if (on) expect(coreStatus(), "the core answered every mesh").toMatchObject({ state: "on", reason: null, refusedMeshes: refused });
          if (maxPreview === null) expect(digest(preview), "the probe skipped decimation").toBe(pinned);
          else expect(preview.indices.length).toBeLessThan(maxPreview * print.indices.length);
          expect(edgeCheck(preview.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
          expect(eulerChar(preview.positions, preview.indices)).toBe(eulerChar(print.positions, print.indices));
        }
      } finally { setCoreEnabled(true); }
    }, 120_000);
  }
  // The exact (default) hand takes the owner path. Its tier guarantees, held without a golden digest:
  // print is the JS owner stages run with decimateFrac 0 (core on and off alike), and preview is
  // closed, Euler-equal and at most half print's triangles.
  test("exact hand: print tier is the JS owner stages with decimateFrac 0, core on and off; preview is smaller", () => {
    const compiled = compileImplicit(handSpec()), edge = 1.5, node = compiled.ir.nodes[compiled.ownerRoot];
    expect(compiled.ownerRoot).toBeGreaterThanOrEqual(0);
    const store = evaluateLeaves(planLeaves(compiled, edge));
    let ref = cleanupMesh(store, meshStoreOwners(store, { gap: node.gap }), { ...PREVIEW_CLEANUP, decimateFrac: 0 });
    ref = untangle(store, cutCreases(store, ref, node.attWorld));
    if (compiled.detail.length) ref = applySurfaceDetail(store, ref, compiled);
    const want = digest(ref);
    try {
      for (const on of [true, false]) {
        setCoreEnabled(on);
        const print = meshImplicit(compiled, edge, { tier: "print" });
        expect(digest(print), `core ${on ? "on" : "off"}`).toBe(want);
        expect(digest(meshImplicit(compiled, edge)), `no tier, core ${on ? "on" : "off"}`).toBe(want);
        const preview = meshImplicit(compiled, edge, { tier: "preview" });
        expect(preview.indices.length).toBeLessThanOrEqual(0.5 * print.indices.length);
        expect(edgeCheck(preview.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
        expect(eulerChar(preview.positions, preview.indices)).toBe(eulerChar(print.positions, print.indices));
      }
    } finally { setCoreEnabled(true); }
  }, 120_000);
  test("relax leaves a vertex with a zero normal where it is", () => {
    // A tetrahedron; vertex 0's projection found no gradient, so it has no normal.
    const P = Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1);
    const T = Uint32Array.of(0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3);
    const N = Float64Array.of(0, 0, 0, 0, -1, 0, -1, 0, 0, 0.5773502691896258, 0.5773502691896258, 0.5773502691896258);
    relax(P, T, N, 0.5, 10);
    expect(Array.from(P.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(P.subarray(3, 6))).not.toEqual([1, 0, 0]);   // vertices with normals still relax
  });
});

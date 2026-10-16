// test/implicit-topology.test.js
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { handSpec, nailSpecs, vaseSpec, ADVERSARIAL, SUB_CELL_PLATE, randomSpec, HAND_POSES } from "./fixtures/implicit-trees.js";
import { evalNodeAt, evalReference } from "../src/framework/geometry/implicit/reference.js";
import { resolveFrames, xformPoint } from "../src/framework/geometry/implicit/frames.js";
import { clearance, attachWeight, gateWeight, ATTACH_STRIDE, FILL_STRIDE, FILL_BAND, BULGE_DEFAULT } from "../src/framework/geometry/implicit/contact.js";
import { edgeCheck, componentCount, volume } from "./helpers/mesh-topology.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField, planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };
// meshImplicit's tiers: "preview" decimates in cleanup, "print" does not (k above is a
// preview kernel, so every k.implicit here is decimated).
const TIERS = ["preview", "print"];

// Two triangles over the same three vertices (a "pillow": a closed piece folded flat).
const duplicateTriangles = (T) => {
  const seen = new Set();
  let dup = 0;
  for (let t = 0; t < T.length; t += 3) {
    const key = [T[t], T[t + 1], T[t + 2]].sort((a, b) => a - b).join();
    if (seen.has(key)) dup++;
    seen.add(key);
  }
  return dup;
};

describe("preview decimation", () => {
  // Tiny spheres mesh as a handful of triangles; the preview tier's decimation used to
  // collapse a tetrahedral piece into two triangles over the same vertices (zero volume,
  // closed and Euler-correct, so edgeCheck alone missed it). The step-3.3 rows at 1.5 mm
  // each made pillows before the tetrahedron guard.
  const rows = [];
  for (const [r, edge] of [[0.75, 1.5], [0.9, 1.5], [1.1, 1.5], [0.45, 1.0], [0.6, 1.0]]) for (const step of [2.5, 3.3, 6]) rows.push([r, edge, step]);
  test("tiny spheres in a repeat, decimated with the probe and normal guards off: no duplicate triangles, closed", () => {
    // The preview tier's probe skips decimation on most of these, and its normal guards
    // refuse the folds anyway; with both off only the tetrahedron guard stands between
    // these and the pillows (removing it fails this test).
    const opts = { ...PREVIEW_CLEANUP, decimateMinAccept: 0, decimateMaxTurn: 0, decimateMaxSpread: 0 };
    let decimated = 0;
    for (const [r, edge, step] of rows) {
      const store = evaluateLeaves(planLeaves(lowerSpec({ root: { kind: "repeat", linear: { count: 6, step: [step, 0, 0] }, child: { kind: "sphere", r } } }, { images: new Map() }), edge));
      const raw = meshStore(store), out = cleanupMesh(store, raw, opts);
      if (out.indices.length < cleanupMesh(store, raw).indices.length) decimated++;
      expect(duplicateTriangles(out.indices), `r ${r} at ${edge} mm, step ${step}`).toBe(0);
      expect(edgeCheck(out.indices), `r ${r} at ${edge} mm, step ${step}`).toEqual(CLOSED);
    }
    expect(decimated).toBeGreaterThanOrEqual(2);
  });
  for (const tier of TIERS) {
    test(`tiny spheres in a repeat, ${tier} tier: no duplicate triangles, closed`, () => {
      let meshed = 0;
      for (const [r, edge, step] of rows) {
        const spec = { root: { kind: "repeat", linear: { count: 6, step: [step, 0, 0] }, child: { kind: "sphere", r } } };
        const out = meshImplicit(compileImplicit(spec), edge, { tier });
        if (out.indices.length) meshed++;
        expect(duplicateTriangles(out.indices), `r ${r} at ${edge} mm, step ${step}`).toBe(0);
        expect(edgeCheck(out.indices), `r ${r} at ${edge} mm, step ${step}`).toEqual(CLOSED);
      }
      expect(meshed).toBeGreaterThanOrEqual(6);
    });
  }
  test("spheres keep their volume: decimation adds < 2% loss, and r >= 2 cells stays within 5% of print", () => {
    // Measured: the 1.5 mm grid itself loses 26/11/9/3.6/2.0/0.9% at r = 1.5/1.8/2.2/3/4.5/6
    // against the print tier's 0.6 mm; decimation adds 0/0.5/0/0.1/0.3/1.3%.
    for (const r of [1.5, 1.8, 2.2, 3, 4.5, 6]) {
      const c = compileImplicit({ root: { kind: "sphere", r } });
      const vol = (edge, tier) => { const o = meshImplicit(c, edge, { tier }); return volume(o.positions, o.indices); };
      const preview = vol(1.5, "preview"), plain = vol(1.5, "print"), print = vol(0.6, "print");
      expect(preview / plain, `r ${r}: decimated vs not`).toBeGreaterThan(0.98);
      if (r >= 3) expect(preview / print, `r ${r}: preview vs print`).toBeGreaterThan(0.95);
    }
  });
});

describe("topology", () => {
  // Curl 0–100 at the default flex: no fingertip reaches the palm (genus 0). The fist: all
  // four fingertips fuse to the palm, each closing one loop (genus 4).
  for (const [name, pose, genus] of [["curl 0", { curl: 0 }, 0], ["curl 50", { curl: 50 }, 0], ["curl 100", { curl: 100 }, 0], ["a fist", HAND_POSES.fist, 4]]) {
    test(`hand at ${name}: watertight, genus ${genus}, nails attach`, () => {
      let hand = k.implicit(handSpec(pose));
      expect(hand.genus()).toBe(genus);
      hand = k.union([hand, ...nailSpecs(pose).map((s) => k.implicit(s))]);
      expect(hand.genus()).toBe(genus);
      expect(hand.volume()).toBeGreaterThan(0);
    }, 60_000);
  }
  test("vase: all grammar features in one part", async () => {
    const { spec, images } = vaseSpec();
    for (const [name, im] of images) await k._registerImage({ name, ...im });
    const v = k.implicit(spec);
    expect(v.volume()).toBeGreaterThan(0);
  }, 60_000);
  for (const [name, spec] of Object.entries(ADVERSARIAL)) {
    test(`adversarial ${name}: closed at both tiers and accepted by Manifold (Review Focus 3)`, () => {
      for (const tier of TIERS) expect(edgeCheck(meshImplicit(compileImplicit(spec), spec.preview, { tier }).indices), tier).toEqual(CLOSED);
      expect(k.implicit(spec).volume()).toBeGreaterThan(0);
    });
  }
  test("subCellPlate: warned; a solid or the empty-shape error, never an open mesh", () => {
    const spec = SUB_CELL_PLATE;
    const out = meshImplicit(compileImplicit(spec), spec.preview);
    expect(out.warnings.some((w) => /thinnest feature/.test(w))).toBe(true);
    for (const tier of TIERS) {
      const t = meshImplicit(compileImplicit(spec), spec.preview, { tier });
      if (t.indices.length) expect(edgeCheck(t.indices), tier).toEqual(CLOSED);
    }
    let solid = null;
    try { solid = k.implicit(spec); } catch (e) { expect(e.message).toMatch(/implicit: the shape is empty/); }
    if (solid) expect(solid.volume()).toBeGreaterThan(0);
  });
  test("volume is stable across grid sizes (within 3%)", () => {
    const spec = handSpec({ curl: 30 });
    const a = k.implicit({ ...spec, preview: 1.5 }).volume(), b = k.implicit({ ...spec, preview: 1.0 }).volume();
    expect(Math.abs(a - b) / b).toBeLessThan(0.03);
  }, 60_000);
  for (const tier of TIERS) {
    test(`seeded fuzz, ${tier} tier: 40 random trees mesh closed`, () => {
      let meshed = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const spec = randomSpec(seed);
        let out;
        try { out = meshImplicit(compileImplicit(spec), spec.preview, { tier }); } catch (e) { if (e.code === "IMPLICIT_SPEC") continue; throw e; }
        if (out.indices.length === 0) continue;
        expect(edgeCheck(out.indices), `seed ${seed}`).toEqual(CLOSED);
        meshed++;
      }
      expect(meshed).toBeGreaterThanOrEqual(30);   // 40 of 40 mesh today; a skip-everything fuzz must fail
    }, 120_000);
  }
});

// Exactly-touching faces: a hard union, mirror or repeat whose pieces share a face
// has d = 0 exactly on that face. When the face lies on a grid plane those samples
// must not read as outside (a sheet splitting the solid in two).
const TOUCHING = {
  mirrorHalfBox: { root: { kind: "mirror", plane: "yz", child: { kind: "box", size: [10, 10, 10], at: [5, 0, 0] } } },
  coincidentFaces: ADVERSARIAL.coincidentFaces,
  repeatTouching: { root: { kind: "repeat", linear: { count: 3, step: [4, 0, 0] }, child: { kind: "box", size: [4, 4, 4] } } },
};
// Flush subtracts must stay clean: a tool sharing a face plane with the base adds no sheet.
const FLUSH = {
  flushTouchingTool: { root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [20, 20, 10], at: [0, 0, 10] }] } },
  flushPocket: { root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [4, 4, 10], at: [0, 0, 5] }] } },
};

describe("exactly-touching faces", () => {
  for (const [name, spec] of Object.entries({ ...TOUCHING, ...FLUSH })) {
    for (const edge of [0.5, 0.6, 1.0, 1.5]) {
      test(`${name} at ${edge} mm: one closed shell at both tiers`, () => {
        for (const tier of TIERS) {
          const out = meshImplicit(compileImplicit(spec), edge, { tier });
          expect(edgeCheck(out.indices), tier).toEqual(CLOSED);
          expect(componentCount(out.indices), tier).toBe(1);
        }
      });
    }
  }
  for (const [name, spec] of Object.entries(TOUCHING)) {
    test(`${name}: sparse samples equal the dense run's bit for bit`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      for (const edge of [0.5, 1.0]) {
        const sparse = sampleField(c, edge), dense = sampleField(c, edge, { cull: false });
        const byKey = new Map(dense.leaves.map((l) => [`${l.i0},${l.j0},${l.l0}`, l]));
        for (const l of sparse.leaves) expect(Array.from(l.vals)).toEqual(Array.from(byKey.get(`${l.i0},${l.j0},${l.l0}`).vals));
      }
    });
  }
  test("the zero re-evaluation is deterministic", () => {
    const c = lowerSpec(TOUCHING.mirrorHalfBox, { images: new Map() });
    const a = sampleField(c, 0.5), b = sampleField(c, 0.5);
    expect(a.leaves.map((l) => Array.from(l.vals))).toEqual(b.leaves.map((l) => Array.from(l.vals)));
    expect(a.leaves.some((l) => l.vals.some((v) => v < 0 && v > -1e-5))).toBe(true);   // the face samples read inside
  });
});

// The hand's palm, thumb and fingers are one `contact` node (handSpec): pieces press instead
// of bridging. Child order: palm, thumb, index, middle, ring, pinky.
describe("hand contact", () => {
  const meshAt = (c, edge) => meshImplicit(c, edge, { tier: edge > 1 ? "preview" : "print" });
  const slotOf = (spec, label) => spec.root.children.findIndex((ch) => ch.label === label);
  const origin = (spec, frame) => { const p = [0, 0, 0]; xformPoint(p, resolveFrames(spec.frames).get(frame).world, 0, 0, 0); return p; };
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  // A local minimum of f by axis pattern search (step halving to 1e-4) from the best of `starts`.
  const minimize = (f, starts) => {
    let p = starts[0], v = f(...p);
    for (const q of starts) { const w = f(...q); if (w < v) { v = w; p = q; } }
    for (let step = 1; step > 1e-4;) {
      let moved = false;
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = p.map((x, i) => x + d[i] * step), w = f(...q);
        if (w < v) { v = w; p = q; moved = true; }
      }
      if (!moved) step /= 2;
    }
    return { p, v };
  };
  const fillPairs = (node) => {
    const out = [];
    for (let o = 0; o < node.fillRegions.length; o += FILL_STRIDE) out.push({ o, a: node.fillRegions[o], b: node.fillRegions[o + 1], c: Array.from(node.fillRegions.subarray(o + 2, o + 5)), rho: node.fillRegions[o + 5] });
    return out;
  };

  test("near-miss fingers stay apart: index and middle 0.75 mm apart at their closest, a clean gap at preview and print", () => {
    // The brief's fingertips: a spread sweep brings these fingers closest at their PIP
    // knuckles (the fattest part), so the near miss is there.
    const spec = handSpec(HAND_POSES.nearMiss), c = compileImplicit(spec), node = c.ir.nodes[c.ir.root];
    const ia = node.children[slotOf(spec, "index")], im = node.children[slotOf(spec, "middle")];
    const da = (x, y, z) => evalNodeAt(c, ia, x, y, z), dm = (x, y, z) => evalNodeAt(c, im, x, y, z);
    // The gap's midpoint: the minimum of max(d_index, d_middle) (half the gap), searched from
    // midpoints of their middle and distal phalanges.
    const [ip, id, it, mp, md, mt] = ["index.pip", "index.dip", "index.tip", "middle.pip", "middle.dip", "middle.tip"].map((f) => origin(spec, f));
    const along = (a, b, cc, s) => (s <= 1 ? a.map((x, i) => x + s * (b[i] - x)) : b.map((x, i) => x + (s - 1) * (cc[i] - x)));
    const starts = [];
    for (let s = 0; s <= 2.0001; s += 0.1) for (let t = 0; t <= 2.0001; t += 0.1) {
      const a = along(ip, id, it, s), b = along(mp, md, mt, t);
      starts.push(a.map((x, i) => (x + b[i]) / 2));
    }
    const { p, v } = minimize((x, y, z) => Math.max(da(x, y, z), dm(x, y, z)), starts);
    expect(Math.abs(2 * v - 0.75)).toBeLessThan(1e-3);
    expect(dist(p, ip)).toBeLessThan(12);   // beside the index PIP knuckle
    expect(node.fillRegions.length).toBe(0);   // nothing touches: no pad anywhere
    for (const edge of [1.5, 0.6]) {
      const out = meshAt(c, edge), P = out.positions, T = out.indices, cl = clearance(0, edge);
      expect(edgeCheck(T), `${edge} mm`).toEqual(CLOSED);
      // Within 6 mm of the gap, no triangle has corners on both sides of the bisector
      // d_index = d_middle (the brief's cut plane, taken as the exact bisector surface — the
      // two knuckles are round), and every vertex keeps half the clearance from it.
      const side = new Map();
      const sideOf = (v) => {
        if (!side.has(v)) {
          const q = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
          side.set(v, dist(q, p) > 6 ? null : da(...q) - dm(...q));
        }
        return side.get(v);
      };
      let crossing = 0, inBall = 0, nearest = Infinity;
      for (let t = 0; t < T.length; t += 3) {
        const s3 = [sideOf(T[t]), sideOf(T[t + 1]), sideOf(T[t + 2])];
        if (s3.includes(null)) continue;
        if (Math.min(...s3) < 0 && Math.max(...s3) > 0) crossing++;
      }
      for (const d of side.values()) if (d !== null) { inBall++; nearest = Math.min(nearest, Math.abs(d)); }
      expect(inBall, `${edge} mm`).toBeGreaterThan(20);
      expect(crossing, `${edge} mm`).toBe(0);
      expect(nearest, `${edge} mm`).toBeGreaterThanOrEqual(cl / 2);
    }
  }, 60_000);

  test("fist: each fingertip has a contact region with the palm and pads against it with no fillet beyond the bulge", () => {
    const spec = handSpec(HAND_POSES.fist), c = compileImplicit(spec), node = c.ir.nodes[c.ir.root];
    const regions = [];
    for (const finger of ["index", "middle", "ring", "pinky"]) {
      const f = slotOf(spec, finger), tip = origin(spec, `${finger}.tip`);
      const r = fillPairs(node).find((q) => q.a === 0 && q.b === f);
      expect(r, finger).toBeDefined();
      expect(dist(r.c, tip), finger).toBeLessThan(10);   // the pad is at the fingertip
      regions.push(r);
    }
    // The surface may stand off the plain union of the raw pieces by the bulge, the pad's
    // crease blend (PAD_BLEND/4 = 0.375 mm) and the grid; the old finger-to-palm blend
    // (k = 8) stood 2 mm off it in the crease around each fingertip.
    const raw = (x, y, z) => Math.min(...node.children.map((id) => evalNodeAt(c, id, x, y, z)));
    for (const edge of [1.5, 0.6]) {
      const out = meshAt(c, edge), P = out.positions;
      expect(edgeCheck(out.indices), `${edge} mm`).toEqual(CLOSED);
      for (const r of regions) {
        let worst = -Infinity, n = 0;
        for (let v = 0; v < P.length / 3; v++) {
          const q = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
          if (dist(q, r.c) > r.rho + 2 * FILL_BAND) continue;
          worst = Math.max(worst, raw(...q)); n++;
        }
        expect(n).toBeGreaterThan(20);
        expect(worst, `${edge} mm, region of slot ${r.b}`).toBeLessThanOrEqual(BULGE_DEFAULT + edge);
      }
    }
  }, 60_000);

  test("open hand unchanged at the base: within the attachment radius, the field is the finger-to-palm blend", () => {
    // Where no third piece is near (each beyond the clearance, and beyond the blend width of
    // the palm), the contact hand equals unionN([palm, finger], palmBlend) at the preview edge.
    const pose = { curl: 0, creases: false }, spec = handSpec(pose), c = compileImplicit(spec), node = c.ir.nodes[c.ir.root];
    expect(node.regions.every((R) => R.length === 0)).toBe(true);   // the open hand touches nowhere
    const edge = 1.5, cl = clearance(0, edge), k = 8;   // palmBlend at a 190 mm hand
    const palm = spec.root.children[0];
    const dirs = [];
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) dirs.push([x, y, z].map((u) => u / Math.hypot(x, y, z)));
    let compared = 0;
    for (const finger of ["index", "middle", "ring", "pinky"]) {
      const f = slotOf(spec, finger), anchor = origin(spec, `${finger}.mcp`);
      const blend = lowerSpec({ frames: spec.frames, root: { kind: "union", k, children: [palm, spec.root.children[f]] } }, { images: new Map() });
      // The attachment's radius: everything compared lies well inside it (weight 1).
      const o = node.att.findIndex((_, i) => i % ATTACH_STRIDE === 0 && node.att[i] === f && node.att[i + 1] === 0);
      for (const r of [5, 9]) for (const d of dirs) {
        const q = anchor.map((a, i) => a + r * d[i]);
        expect(attachWeight(node.att, o, ...q)).toBe(1);
        const vf = evalNodeAt(c, node.children[f], ...q), vp = evalNodeAt(c, node.children[0], ...q);
        const thirdsClear = node.children.every((id, j) => {
          if (j === f || j === 0) return true;
          const vj = evalNodeAt(c, id, ...q);
          return vj + vf >= cl && vj + vp >= cl && vj - vp >= k;
        });
        if (!thirdsClear) continue;
        expect(Math.abs(evalReference(c, ...q, edge) - evalReference(blend, ...q)), `${finger} at ${q.map((u) => u.toFixed(1))}`).toBeLessThan(1e-9);
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(60);
  });

  test("pose sweep from near miss into contact: watertight, and no triangle joins two pieces that neither touch nor are joined there", () => {
    // Every fingertip passes from a near miss of the palm (flex 96: 2–7 mm short) through
    // first contact into a firm press. An edge whose ends lie nearest different pieces must
    // lie where those two are in contact (a region's gate is open) or joined (both attached
    // to one piece there: the webbing at the finger bases).
    const poses = [96, 99, 101, 103, 106, 110].map((f) => ({ curl: 100, flex: { index: f, middle: f, ring: f, pinky: f, thumb: 50 } }));
    for (const pose of [...poses, HAND_POSES.nearMiss]) {
      const c = compileImplicit(handSpec(pose)), node = c.ir.nodes[c.ir.root], edge = 1.5, cl = clearance(0, edge);
      const out = meshAt(c, edge), P = out.positions, T = out.indices;
      expect(edgeCheck(T), JSON.stringify(pose)).toEqual(CLOSED);
      const own = new Int8Array(P.length / 3);
      for (let v = 0; v < own.length; v++) {
        let best = Infinity;
        node.children.forEach((id, i) => { const d = evalNodeAt(c, id, P[3 * v], P[3 * v + 1], P[3 * v + 2]); if (d < best) { best = d; own[v] = i; } });
      }
      const joinedTo = (a, q) => {
        const out = [];
        for (let o = 0; o < node.att.length; o += ATTACH_STRIDE) if (attachWeight(node.att, o, ...q) > 0) { if (node.att[o] === a) out.push(node.att[o + 1]); if (node.att[o + 1] === a) out.push(node.att[o]); }
        return out;
      };
      const allowed = (a, b, q) => {
        const ja = joinedTo(a, q), jb = joinedTo(b, q);
        if (ja.includes(b) || ja.some((x) => jb.includes(x))) return true;
        return fillPairs(node).some((r) => ((r.a === a && r.b === b) || (r.a === b && r.b === a)) && gateWeight(node.fillRegions, r.o, cl, ...q) > 0);
      };
      let bridges = 0;
      for (let t = 0; t < T.length; t += 3) for (let e = 0; e < 3; e++) {
        const u = T[t + e], w = T[t + (e + 1) % 3];
        if (own[u] === own[w]) continue;
        const q = [0, 1, 2].map((i) => (P[3 * u + i] + P[3 * w + i]) / 2);
        if (!allowed(own[u], own[w], q)) bridges++;
      }
      expect(bridges, JSON.stringify(pose)).toBe(0);
    }
  }, 120_000);
});

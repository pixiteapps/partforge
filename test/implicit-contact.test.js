// test/implicit-contact.test.js
import { describe, test, expect } from "vitest";
import { validateSpec } from "../src/framework/geometry/implicit/grammar.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference, evalNodeAt } from "../src/framework/geometry/implicit/reference.js";
import { unionN } from "../src/framework/geometry/implicit/primitives.js";
import { clearance, C_MIN_CELLS, ATTACH_STRIDE, bulgeOffset, REGION_CELL, BULGE_STRIDE, FILL_STRIDE, PAD_BLEND, BULGE_FULL_DEPTH, BULGE_DEFAULT, FILL_BAND, contactValue } from "../src/framework/geometry/implicit/contact.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { setCoreEnabled } from "../src/framework/core/core.js";
import { cpuMs } from "./helpers/cpu-pace.js";
import { blockDecision, fullDecision, decisionKey } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch, runProgram, OP } from "../src/framework/geometry/implicit/program.js";
import { planLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const issues = (spec) => { try { validateSpec(spec); return []; } catch (e) { expect(e.code).toBe("IMPLICIT_SPEC"); return e.issues; } };
const lower = (spec) => lowerSpec(spec, { images: new Map() });
const sph = (x, label, r = 5) => ({ kind: "sphere", r, at: [x, 0, 0], ...(label ? { label } : {}) });
const near = (a, b, tol = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe("contact grammar", () => {
  test("validates contact", () => {
    const base = (extra, children = [sph(-4, "a"), sph(4, "b")]) => ({ frames: { j: {} }, root: { kind: "contact", children, ...extra } });
    expect(issues(base({}))).toEqual([]);
    expect(issues(base({ gap: 1, bulge: 0.5, attach: [{ a: "a", b: "b", near: "j", radius: 5, k: 2, band: 1 }] }))).toEqual([]);
    expect(issues(base({}, [sph(0)]))).toContain("root.children: contact needs at least 2 children");
    expect(issues(base({ gap: -1 }))).toContain("root.gap: must be a number ≥ 0");
    const att = (e) => issues(base({ attach: [{ a: "a", b: "b", near: "j", radius: 5, k: 1, ...e }] }));
    expect(att({ a: "x" })).toContain('root.attach[0].a: no child labelled "x"');
    expect(att({ b: "a" })).toContain("root.attach[0]: a and b must name different children");
    expect(att({ near: "nope" })).toContain('root.attach[0].near: unknown frame "nope"');
    expect(att({ radius: 0 })).toContain("root.attach[0].radius: must be a number > 0");
    expect(att({ k: -1 })).toContain("root.attach[0].k: must be a number ≥ 0");
    expect(att({ band: 0 })).toContain("root.attach[0].band: must be a number > 0");
    expect(att({ zzz: 1 })).toContain('root.attach[0]: unknown field "zzz"');
    const dup = issues(base({ attach: [{ a: "a", b: "b", near: "j", radius: 5, k: 1 }, { a: "b", b: "a", near: "j", radius: 5, k: 1 }] }));
    expect(dup.some((s) => s.startsWith("root.attach[1]: duplicate attachment"))).toBe(true);
  });
});

describe("contact reference field", () => {
  test("edge 0 is the bare gap", () => {
    expect(clearance(0.3, 0)).toBe(0.3);
    expect(clearance(0, 1)).toBe(C_MIN_CELLS);
  });

  test("near miss keeps a clearance", () => {
    // gap > 0 so the pair is cut (gap 0 would fuse); the floor lifts it to C_MIN_CELLS cells.
    const c = lower({ root: { kind: "contact", gap: 0.01, children: [sph(-5.25), sph(5.25)] } });
    expect(evalReference(c, 0, 0, 0, 1)).toBeGreaterThanOrEqual(clearance(0.01, 1) / 2 - 1e-12);
    expect(evalReference(c, 0.25, 0, 0, 1)).toBeGreaterThanOrEqual(0);
    expect(evalReference(c, -0.25, 0, 0, 1)).toBeGreaterThanOrEqual(0);
  });

  test("gap-0 near miss keeps a clearance", () => {
    // No overlap region, so the pad fill is gated off (s2 + cl) and the cut holds the gap.
    const c = lower({ root: { kind: "contact", gap: 0, children: [sph(-5.25), sph(5.25)] } });
    expect(c.ir.nodes[c.ir.root].fuse).toBe(1);
    expect(evalReference(c, 0, 0, 0, 1)).toBeGreaterThanOrEqual(clearance(0, 1) / 2 - 1e-12);
    expect(evalReference(c, 0.25, 0, 0, 1)).toBeGreaterThanOrEqual(0);
    expect(evalReference(c, -0.25, 0, 0, 1)).toBeGreaterThanOrEqual(0);
  });

  test("overlap fuses a pad", () => {
    // bulge 0: the pad itself, without the swell (the bulged twin is only deeper).
    const c = lower({ root: { kind: "contact", gap: 0, bulge: 0, children: [sph(-4), sph(4)] } });
    const bulged = lower({ root: { kind: "contact", gap: 0, children: [sph(-4), sph(4)] } });
    expect(bulged.ir.nodes[bulged.ir.root].fillRegions.length).toBe(FILL_STRIDE);
    expect(evalReference(bulged, 0, 0, 0, 1)).toBeLessThan(evalReference(c, 0, 0, 0, 1));
    expect(c.ir.nodes[c.ir.root].fuse).toBe(1);
    expect(evalReference(c, 0, 0, 0, 1)).toBeLessThan(0);
    // On the bisector the pad is the pair's smooth union (PAD_BLEND), not a moat cl/2 deep:
    // both pieces read d there, so the blend sits PAD_BLEND/4 below it.
    for (const y of [0, 0.5, 1, 1.9, -1.9]) {
      const d = Math.hypot(4, y) - 5;
      near(evalReference(c, 0, y, 0, 1), d - PAD_BLEND / 4);
    }
  });

  test("a press shallower than the clearance fuses at its rim: no moat around the pad", () => {
    // Spheres overlapping by 1 mm (δ = 0.5) at edge 1 (cl = 1.5): on a's surface just outside
    // b (d_b = 0.4) the pad fill is the pair's union, so the skin stays where it is. The
    // earlier fill (the pair's overlap alone) left a's cut piece there, (0 − 0.4 + cl)/2 =
    // 0.55 above it: a moat around a floating lens, for any press shallower than cl.
    const c = lower({ root: { kind: "contact", bulge: 0, children: [sph(-4.5), sph(4.5)] } }), node = c.ir.nodes[c.ir.root];
    expect(node.fillRegions.length).toBe(FILL_STRIDE);
    let lo = 0, hi = Math.PI / 2;   // θ on a's equator: d_b falls from 1 to below 0 as θ → 0
    const at = (th) => [-4.5 + 5 * Math.cos(th), 5 * Math.sin(th), 0];
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (Math.hypot(at(m)[0] - 4.5, at(m)[1]) - 5 < 0.4) lo = m; else hi = m; }
    const p = at(lo), edge = 1, cl = clearance(0, edge);
    expect((0 - 0.4 + cl) / 2).toBeGreaterThan(0.5);
    expect(evalReference(c, ...p, edge)).toBeLessThanOrEqual(0);
  });

  test("the pad fill vanishes at its gate's edge without a jump, at every grid edge", () => {
    // Two pieces equally near, at the gate's outer radius (rho + cl + 2·FILL_BAND): just
    // inside, the term eases out; just outside, it is absent. A lift of cl alone left the
    // term winning there once cl/2 < PAD_BLEND/4 (0.10 mm jump at edge 0.3, 0.175 at 0.2).
    const F = Float64Array.of(0, 1, 0, 0, 0, 2);
    for (const edge of [0.2, 0.3, 0.6, 1.5]) for (const v of [0, 0.05, 0.2, 1]) {
      const cl = clearance(0, edge), R = 2 + cl + 2 * FILL_BAND, at = (r) => contactValue(Float64Array.of(v, v), 2, cl, 1, new Float64Array(0), 0, F, 1, r, 0, 0);
      expect(Math.abs(at(R - 1e-7) - at(R + 1e-7)), `edge ${edge}, v ${v}`).toBeLessThan(1e-6);
    }
  });

  test("a flush pad keeps its blend inside the bounds: no clipping", () => {
    // Two 20 mm boxes overlapping 1 mm with flush tops: the pad's blend lifts the seam
    // PAD_BLEND/4 above the tops (y = 10), so the box must reach past them.
    const box = (x) => ({ kind: "box", size: [20, 20, 20], at: [x, 0, 0] });
    const spec = { root: { kind: "contact", bulge: 0, children: [box(-9.5), box(9.5)] } };
    const c = compileImplicit(spec);
    expect(evalReference(c, 0, 10.2, 0, 1)).toBeLessThan(0);
    expect(c.bounds.max[1]).toBeGreaterThanOrEqual(10 + PAD_BLEND / 4);
    const out = meshImplicit(c, 1);
    expect(out.warnings.filter((w) => /clipped/.test(w))).toEqual([]);
    let top = -Infinity;
    for (let i = 1; i < out.positions.length; i += 3) top = Math.max(top, out.positions[i]);
    expect(top).toBeGreaterThan(10.2);
  });

  test("a flat contact's bulge swells at most `bulge`, growing from 0 with the press", () => {
    // Two 20 mm boxes face to face: their contact is as wide as the faces, so the faces
    // beside the seam lie well inside the region's radius. The swell above the top faces
    // with the default bulge, less the bulge-0 shape (the pad's own blend), never passes
    // the bulge, and grows from about nothing at first detection. (Overlaps under about
    // 0.35 mm find no region on the 0.75 mm search lattice.)
    const box = (x) => ({ kind: "box", size: [20, 20, 20], at: [x, 0, 0] });
    const swell = (o, bulge) => {
      const c = lower({ root: { kind: "contact", ...(bulge === undefined ? {} : { bulge }), children: [box(-10 + o / 2), box(10 - o / 2)] } });
      let worst = 0;
      for (let x = -12; x <= 12; x += 0.5) for (const z of [-6, 0, 6]) {
        if (evalReference(c, x, 10, z, 1.5) > 0) continue;
        let lo = 10, hi = 14;
        for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (evalReference(c, x, m, z, 1.5) <= 0) lo = m; else hi = m; }
        worst = Math.max(worst, lo - 10);
      }
      return worst;
    };
    let prev = 0;
    for (const o of [0.4, 0.5, 0.7, 1, 1.5, 2, 3, 5]) {
      const b = swell(o) - swell(o, 0);
      expect(b, `overlap ${o}`).toBeLessThanOrEqual(BULGE_DEFAULT + 0.02);
      expect(b, `overlap ${o}`).toBeGreaterThanOrEqual(prev - 0.02);
      if (o === 0.4) expect(b).toBeLessThan(0.1 * BULGE_DEFAULT);
      prev = b;
    }
  });

  test("gap keeps pads apart", () => {
    const c = lower({ root: { kind: "contact", gap: 0.5, children: [sph(-4), sph(4)] } });
    expect(c.ir.nodes[c.ir.root].fuse).toBe(0);
    expect(evalReference(c, 0, 0, 0, 0.1)).toBeGreaterThanOrEqual(0.25 - 1e-12);
    const x = 0.3, va = Math.abs(x + 4) - 5, vb = Math.abs(x - 4) - 5;
    near(evalReference(c, x, 0, 0, 0.1), (vb - va + 0.5) / 2);
    near(evalReference(c, -x, 0, 0, 0.1), (vb - va + 0.5) / 2);   // mirror image: same cut piece
  });

  const finger = (frame) => ({
    kind: "contact", gap: 0.2, attach: [{ a: "finger", b: "palm", near: "joint", radius: 10, band: 4, k: 3 }],
    children: [
      { kind: "capsule", a: [0, 0, 2], b: [0, 0, 30], r: 3, label: "finger" },
      { kind: "box", size: [20, 20, 4], label: "palm" },
    ],
    ...frame,
  });
  const dA = (p) => {   // capsule (0,0,2)-(0,0,30), r 3
    const h = Math.min(Math.max((p[2] - 2) / 28, 0), 1);
    return Math.hypot(p[0], p[1], p[2] - 2 - 28 * h) - 3;
  };
  const dB = (p) => {
    const q = [Math.abs(p[0]) - 10, Math.abs(p[1]) - 10, Math.abs(p[2]) - 2];
    return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0);
  };

  test("attachment joins near the anchor", () => {
    const att = lower({ frames: { joint: { at: [0, 0, 2] } }, root: finger() });
    const bare = lower({ frames: { joint: { at: [0, 0, 2] } }, root: { ...finger(), attach: undefined } });
    const node = att.ir.nodes[att.ir.root];
    expect(node.att.length).toBe(ATTACH_STRIDE);
    expect(Array.from(node.att.slice(0, 2))).toEqual([0, 1]);
    for (const p of [[0, 0, 2], [3, 0, 3], [0, 4, 1], [5, 5, 0], [0, 0, 8]]) {
      near(evalReference(att, ...p, 0), unionN(Float64Array.of(dA(p), dB(p)), 2, 3), 1e-9);
    }
    // 20 mm up the finger the attachment weight is 0: cut like any pair.
    for (const p of [[0, 0, 22], [4, 0, 24]]) near(evalReference(att, ...p, 0), evalReference(bare, ...p, 0), 0);
  });

  test("framed contact", () => {
    const A = [0, 0, 2];
    const plain = lower({ frames: { joint: { at: A } }, root: finger() });
    const at = [0, 3, 0], t = [10, 0, 0];
    const map = (q) => [-(q[1] + at[1]) + t[0], q[0] + at[0] + t[1], q[2] + at[2] + t[2]];   // rotate 90° about z
    const framed = lower({
      frames: { F: { at: t, rotate: { axis: "z", deg: 90 } }, joint: { at: map(A) } },
      root: finger({ frame: "F", at }),
    });
    for (const q of [[0, 0, 2], [3, 0, 3], [0, 0, 22], [5, 5, 0], [12, 0, 1], [0, 0, 12]]) {
      near(evalReference(framed, ...map(q), 0), evalReference(plain, ...q, 0), 1e-9);
    }
    const f = framed.ir.nodes[framed.ir.root];
    expect(Array.from(f.att.slice(2, 5)).map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 0, 2]);
    expect(evalNodeAt(framed, framed.ir.root, ...map([0, 0, 2]), 0)).toBe(evalReference(framed, ...map([0, 0, 2]), 0));
  });
});

let seed = 23;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const CONTACT_TREES = Object.keys(TREES).filter((k) => k.startsWith("contact"));
const ballPoints = (cx, cy, cz, r, N) => {
  const X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const dx = rnd(), dy = rnd(), dz = rnd(), l = Math.hypot(dx, dy, dz) || 1, t = (Math.abs(rnd()) * r) / l;
    X[i] = cx + dx * t; Y[i] = cy + dy * t; Z[i] = cz + dz * t;
  }
  return [X, Y, Z];
};

describe("contact pruning and bytecode", () => {
  test("program carries the clearance", () => {
    for (const name of CONTACT_TREES) {
      const c = lower(TREES[name]), node = c.ir.nodes[c.ir.root];
      const a = emitProgram(c, fullDecision(c, 0.5), 0.5), b = emitProgram(c, fullDecision(c, 1.5), 1.5);
      expect(a.length).toBe(b.length);
      const diff = [];
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) diff.push(i);
      const cl0 = clearance(node.gap, 0.5), cl1 = clearance(node.gap, 1.5);
      expect(diff.length).toBe(cl0 === cl1 ? 0 : 1);
      if (diff.length) {
        expect(a[diff[0] - 3]).toBe(OP.CONTACT);
        expect([a[diff[0]], b[diff[0]]]).toEqual([cl0, cl1]);
      }
    }
  });

  for (const name of CONTACT_TREES) {
    test(`${name}: programs equal the reference at a nonzero grid edge, full and pruned`, () => {
      const c = lower(TREES[name]);
      for (const edge of [0.5, 1.5]) {
        const N = 400, out = new Float64Array(N);
        const [X, Y, Z] = ballPoints(0, 0, 0, 15, N);
        evalBatch(emitProgram(c, fullDecision(c, edge), edge), c.textures, X, Y, Z, out);
        for (let i = 0; i < N; i++) expect(out[i]).toBe(evalReference(c, X[i], Y[i], Z[i], edge));
        for (let b = 0; b < 40; b++) {
          const cx = rnd() * 12, cy = rnd() * 12, cz = rnd() * 12, r = 0.5 + Math.abs(rnd()) * 3;
          const { lo, hi, dec } = blockDecision(c, cx, cy, cz, r, undefined, edge);
          const M = 48, o = new Float64Array(M), [BX, BY, BZ] = ballPoints(cx, cy, cz, r, M);
          evalBatch(emitProgram(c, dec, edge), c.textures, BX, BY, BZ, o);
          for (let i = 0; i < M; i++) {
            const v = evalReference(c, BX[i], BY[i], BZ[i], edge);
            expect(o[i]).toBe(v);
            expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
            expect(v).toBeLessThanOrEqual(hi + 1e-9);
          }
        }
      }
    });
  }

  test("a far third child is pruned beside a touching pair; two children never are", () => {
    const c = lower(TREES.contactThree);
    const d = blockDecision(c, 0, 0, 0, 1.5, undefined, 0.5).dec;
    expect(d.kids[0]).not.toBeNull();
    expect(d.kids[1]).not.toBeNull();
    expect(d.kids[2]).toBeNull();
    expect(d.firm[2]).toBe(true);
    expect(blockDecision(c, 10, 0, 0, 1, undefined, 0.5).dec.kids.filter(Boolean).length).toBeGreaterThan(1);
    const two = lower({ root: { kind: "contact", gap: 0.2, children: [sph(0), sph(60)] } });
    expect(blockDecision(two, 0, 0, 0, 1, undefined, 0.5).dec.kids.every(Boolean)).toBe(true);
  });

  test("a pruned slot drops its attachments; the rest are re-indexed to the emitted slots", () => {
    const c = lower(TREES.contactAttach);
    const d = blockDecision(c, 0, 0, 2, 1.5, undefined, 0.5).dec;
    expect(d.kids.map(Boolean)).toEqual([false, true, true]);
    const prog = emitProgram(c, d, 0.5);
    const pc = Array.from(prog).indexOf(OP.CONTACT, 2);
    const nK = prog[pc + 5], nA = prog[pc + 6];
    expect([nK, nA]).toEqual([2, 1]);
    expect(Array.from(prog.subarray(pc + 7 + nK, pc + 9 + nK))).toEqual([0, 1]);
    // Near the knob its attachment is live: the knob stays.
    expect(blockDecision(c, 9, 0, 5, 1, undefined, 0.5).dec.kids[0]).not.toBeNull();
  });

  test("an attachment weight above zero in the ball keeps its slot", () => {
    // Far knob, but the knob–palm attachment's band reaches the ball: (c) fails, so no prune.
    const spec = structuredClone(TREES.contactAttach);
    spec.root.attach[1].radius = 9;
    const c = lower(spec);
    expect(blockDecision(c, 0, 0, 2, 1.5, undefined, 0.5).dec.kids[0]).not.toBeNull();
  });

  test("planning threads the edge: every leaf program carries the clearance at that edge", () => {
    const c = lower(TREES.contactNearMiss);
    for (const edge of [0.5, 1]) {
      const plan = planLeaves(c, edge);
      expect(plan.programs.length).toBeGreaterThan(0);
      for (const p of plan.programs) {
        const pc = Array.from(p).indexOf(OP.CONTACT, 2);
        if (pc >= 0) expect(p[pc + 3]).toBe(clearance(0.01, edge));
      }
    }
  });

  test("inherited decisions equal the full walk on contact trees at a nonzero edge", () => {
    const c = lower(TREES.contactThree);
    const parent = blockDecision(c, 0, 0, 0, 3, undefined, 0.5);
    expect(parent.dec.kids[2]).toBeNull();
    for (const [x, y, z] of [[0.5, 0.5, 0.5], [-1, 0, 0], [1, -1, 1]]) {
      const inh = blockDecision(c, x, y, z, 1, parent.dec, 0.5), full = blockDecision(c, x, y, z, 1, undefined, 0.5);
      expect([inh.lo, inh.hi, decisionKey(inh.dec)]).toEqual([full.lo, full.hi, decisionKey(full.dec)]);
    }
  });

  test("BULGE subtracts the summed region offsets (hand-built program)", () => {
    // [nP, nV, PRIM sphere r 3 → v0, BULGE v1 ← v0 at p0 with 2 regions, END v1]
    const c = lower({ root: { kind: "sphere", r: 3 } });
    const base = emitProgram(c, fullDecision(c));
    const primOps = Array.from(base.subarray(2, base.length - 2));   // drop END
    const R = [1, 0, 0, 0.6, 2, -1, 0.5, 0, 0.3, 1.5];
    const prog = Float64Array.from([1, 2, ...primOps, OP.BULGE, 1, 0, 0, 2, ...R, OP.END, 1]);
    const N = 200, out = new Float64Array(N);
    const [X, Y, Z] = ballPoints(0, 0, 0, 5, N);
    runProgram(prog, c.textures, X, Y, Z, N, out);
    const Rf = Float64Array.from(R);
    for (let i = 0; i < N; i++) {
      const src = evalReference(c, X[i], Y[i], Z[i]);
      let off = 0;
      for (let k = 0; k < 2; k++) {
        const o = k * 5, t = Math.hypot(X[i] - R[o], Y[i] - R[o + 1], Z[i] - R[o + 2]) / R[o + 4];
        off += t < 1 ? R[o + 3] * (1 - t * t) * (1 - t * t) : 0;
      }
      near(out[i], src - off, 1e-12);
      expect(out[i]).toBe(src - bulgeOffset(Rf, 0, 2, X[i], Y[i], Z[i]));
    }
    // Outside every region the field is untouched.
    const o1 = new Float64Array(1);
    runProgram(prog, c.textures, Float64Array.of(0, 0), Float64Array.of(4, 0), Float64Array.of(0, 0), 1, o1);
    expect(o1[0]).toBe(evalReference(c, 0, 4, 0));
  });
});

const cap = (a, b, r, label) => ({ kind: "capsule", a, b, r, ...(label ? { label } : {}) });
const regionsOf = (c) => c.ir.nodes[c.ir.root].regions;
const nRegions = (R) => R.length / BULGE_STRIDE;

describe("contact regions and bulge", () => {
  test("two spheres overlapping by 2 mm: one region, depth about 1 mm", () => {
    const c = lower({ root: { kind: "contact", children: [sph(-4), sph(4)] } });
    const [a, b] = regionsOf(c), node = c.ir.nodes[c.ir.root];
    expect([nRegions(a), nRegions(b)]).toEqual([1, 1]);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(node.fillRegions.subarray(0, 2))).toEqual([0, 1]);   // the pair's slots
    expect(node.fillRegions.length).toBe(FILL_STRIDE);
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i])).toBeLessThan(REGION_CELL);
    // A·φ(rho/rb) = bulge·min(1, δ/BULGE_FULL_DEPTH) with the default bulge (the swell at
    // the rim, rho = the fill region's radius): recover δ.
    const t = node.fillRegions[5] / a[4], delta = ((a[3] * (1 - t * t) * (1 - t * t)) / node.bulge) * BULGE_FULL_DEPTH;
    expect(Math.abs(delta - 1)).toBeLessThanOrEqual(REGION_CELL);
  });

  test("near miss: no regions", () => {
    const c = lower({ root: { kind: "contact", children: [sph(-5.25), sph(5.25)] } });
    expect(regionsOf(c).map((R) => R.length)).toEqual([0, 0]);
    expect(c.ir.nodes[c.ir.root].fillRegions.length).toBe(0);
  });

  test("parallel near miss: boxes overlap, no regions", () => {
    const a = 1.98;   // centres 2a√2 = 5.6 apart, r 2: 1.6 mm between the surfaces
    const c = lower({ root: { kind: "contact", children: [cap([a, a, 0], [a, a, 20], 2), cap([-a, -a, 0], [-a, -a, 20], 2)] } });
    const [A, B] = c.ir.nodes[c.ir.root].children.map((i) => c.ir.nodes[i].box);
    expect(A.min[0] < B.max[0] && A.min[1] < B.max[1]).toBe(true);
    expect(regionsOf(c).map((R) => R.length)).toEqual([0, 0]);
  });

  test("two regions: bent capsules touching at both ends", () => {
    const tube = (s) => ({ kind: "tube", points: [[s, 0, 0], [8 * s, 10, 0], [s, 20, 0]], r: 2 });
    const c = lower({ root: { kind: "contact", children: [tube(-1), tube(1)] } });
    const [A] = regionsOf(c);
    expect(nRegions(A)).toBe(2);
    expect(Math.abs(A[1])).toBeLessThan(1);
    expect(Math.abs(A[BULGE_STRIDE + 1] - 20)).toBeLessThan(1);
    expect(c.ir.nodes[c.ir.root].fillRegions.length).toBe(2 * FILL_STRIDE);
  });

  test("regions under a frame are in node-local coordinates", () => {
    const kids = [cap([-6, 0, 0], [0, 1, 0], 2), cap([0, -1, 0], [6, 0, 3], 2)];
    const plain = lower({ root: { kind: "contact", children: kids } });
    const framed = lower({ frames: { F: { at: [3, -2, 7], rotate: [{ axis: "x", deg: 37 }, { axis: "z", deg: -20 }] } }, root: { kind: "contact", frame: "F", children: kids } });
    expect(nRegions(regionsOf(plain)[0])).toBe(1);
    expect(regionsOf(framed).map((R) => Array.from(R))).toEqual(regionsOf(plain).map((R) => Array.from(R)));
    expect(Array.from(framed.ir.nodes[framed.ir.root].fillRegions)).toEqual(Array.from(plain.ir.nodes[plain.ir.root].fillRegions));
  });

  test("bulge is zero without contact: a near miss meshes identically with bulge 0 and 2", () => {
    setCoreEnabled(false);
    try {
      const m = (bulge) => meshImplicit(compileImplicit({ root: { kind: "contact", bulge, children: [sph(-5.25), sph(5.25)] } }), 1);
      const a = m(0), b = m(2);
      expect(a.positions.length).toBeGreaterThan(0);
      expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
      expect(Array.from(b.indices)).toEqual(Array.from(a.indices));
    } finally { setCoreEnabled(true); }
  });

  test("bulge grows with press depth", () => {
    // Max outward displacement of piece a's surface (outside b) for overlaps 0.5, 1, 2 mm.
    const disp = (o) => {
      const h = 5 - o / 2, c = lower({ root: { kind: "contact", children: [sph(-h), sph(h)] } });
      const R = regionsOf(c)[0];
      let best = 0;
      for (let k = 0; k <= 200; k++) {
        const th = (k / 200) * Math.PI, x = -h + 5 * Math.cos(th), y = 5 * Math.sin(th);
        if (Math.hypot(x - h, y) - 5 < 0) continue;   // inside b: the pad
        best = Math.max(best, bulgeOffset(R, 0, nRegions(R), x, y, 0));
      }
      return best;
    };
    const d = [0.5, 1, 2].map(disp);
    expect(d[0]).toBeGreaterThan(0);
    expect(d[1]).toBeGreaterThan(d[0]);
    expect(d[2]).toBeGreaterThan(d[1]);
  });

  test("attached base has no region", () => {
    const spec = (attach) => ({ frames: { joint: { at: [0, 0, 2] } }, root: {
      kind: "contact", ...(attach ? { attach: [{ a: "finger", b: "palm", near: "joint", radius: 10, band: 4, k: 3 }] } : {}),
      children: [cap([0, 0, 2], [0, 0, 30], 3, "finger"), { kind: "box", size: [20, 20, 4], label: "palm" }],
    } });
    expect(regionsOf(lower(spec(true))).map((R) => R.length)).toEqual([0, 0]);
    expect(regionsOf(lower(spec(false))).map(nRegions)).toEqual([1, 1]);
  });

  test("regions change the content digests", () => {
    const d = (o) => compileImplicit({ root: { kind: "contact", children: [sph(-5 + o / 2), sph(5 - o / 2)] } }).digests;
    expect(d(1).length).toBe(1);
    expect(d(1)).not.toEqual(d(2));
    expect(compileImplicit({ root: { kind: "sphere", r: 2 } }).digests).toEqual([]);
  });

  test("the fill gate is in the program: CONTACT carries the fill regions", () => {
    const c = lower({ root: { kind: "contact", children: [sph(-4), sph(4)] } });
    const prog = emitProgram(c, fullDecision(c, 0.5), 0.5), node = c.ir.nodes[c.ir.root];
    const pc = Array.from(prog).indexOf(OP.CONTACT, 2), nK = prog[pc + 5], nA = prog[pc + 6], o = pc + 7 + nK + nA * ATTACH_STRIDE;
    expect(prog[o]).toBe(1);
    expect(Array.from(prog.subarray(o + 1, o + 1 + FILL_STRIDE))).toEqual(Array.from(node.fillRegions));
    expect(prog[o + 1 + FILL_STRIDE]).toBe(OP.END);
    expect(Array.from(prog).filter((v, i) => i > 1 && v === OP.BULGE).length).toBeGreaterThanOrEqual(2);
  });

  test("bulged, gated trees: the inherited plan is the full walk's plan", () => {
    for (const name of ["contactOverlap", "contactIdentical", "contactGap", "contactPassBy"]) {
      const c = lower(TREES[name]), node = c.ir.nodes[c.ir.root];
      expect(node.fillRegions.length > 0).toBe(node.fuse === 1);   // gap > 0 never fuses: no fill regions
      expect(node.regions.some((R) => R.length > 0)).toBe(true);
      for (const edge of [0.5, 1]) {
        const a = planLeaves(c, edge), b = planLeaves(c, edge, { inherit: false });
        expect(a.leaves).toEqual(b.leaves);
        expect(a.programs.map((p) => Array.from(p))).toEqual(b.programs.map((p) => Array.from(p)));
      }
    }
  });

  test("the pad fill is per pair: a third sphere passing near a contact pad keeps a clean gap", () => {
    // contactPassBy: spheres a, b fused (2 mm overlap); c passes 0.5 mm from a and b, beside
    // their pad and within the old shared gate's margin (which fused it to them).
    // bulge 0 so the gap's midpoint is the clearance cut's bisector (a bulge shifts it toward
    // c a little; the fill is what this pins). The old shared gate gave s2 ≈ 0.25 here.
    const c = lower({ root: { ...TREES.contactPassBy.root, bulge: 0 } }), node = c.ir.nodes[c.ir.root], edge = 1, cl = clearance(0, edge);
    expect(node.fillRegions.length).toBe(FILL_STRIDE);
    expect(Array.from(node.fillRegions.subarray(0, 2))).toEqual([0, 1]);
    const C = [0, 0, -Math.sqrt(7.5 * 7.5 - 16)], A = [-4, 0, 0], t = 2.25 / 7.5;   // gap midpoint, c toward a
    const mid = [0, 1, 2].map((i) => C[i] + (A[i] - C[i]) * t);
    expect(Math.hypot(...[0, 1, 2].map((i) => mid[i] - node.fillRegions[2 + i]))).toBeLessThan(node.fillRegions[5] + cl + 2);
    expect(evalReference(c, ...mid, edge)).toBeGreaterThanOrEqual(cl / 2 - 1e-12);
    expect(evalReference(c, 0, 0, 0, edge)).toBeLessThan(0);   // the a-b pad itself still fuses
    // A pruned block keeps the same value; the program drops a region with a pruned side.
    const d = blockDecision(c, 0, 0, -C[2], 1, undefined, edge).dec;   // far above, beside nothing but a, b
    const prog = emitProgram(c, d, edge), o = new Float64Array(1);
    evalBatch(prog, c.textures, Float64Array.of(0), Float64Array.of(0), Float64Array.of(-C[2]), o);
    expect(o[0]).toBe(evalReference(c, 0, 0, -C[2], edge));
  });

  test("a third slot near a pad's blend is kept while its clearance could rise above the blend (rule (b)'s PAD_BLEND/2)", () => {
    // a, b fused (2 mm overlap); P on their bisector just outside the pad, where the pad's
    // smooth union dips PAD_BLEND/4 below both; c sits 1.7 mm from P. lo_a + lo_c clears cl
    // over a 0.1 mm ball, so cl alone would prune c — but the pad's clearance from c,
    // (min(v_a, v_b) − v_c + cl)/2, still lies above the blend there and sets the value.
    const edge = 1, cl = clearance(0, edge), P = [0, 3.3, 0];
    const c = lower({ root: { kind: "contact", bulge: 0, children: [sph(-4), sph(4), { kind: "sphere", r: 2, at: [0, 7, 0] }] } });
    const m = Math.hypot(4, 3.3) - 5, vc = 7 - 3.3 - 2;
    expect(m + vc).toBeGreaterThan(cl + 0.2);   // (b) with cl alone holds over the ball
    expect((m - vc + cl) / 2).toBeGreaterThan(m - PAD_BLEND / 4 + 0.1);   // the clearance is above the blend
    const d = blockDecision(c, ...P, 0.1, undefined, edge).dec;
    expect(d.kids[2]).not.toBeNull();
    const prog = emitProgram(c, d, edge), o = new Float64Array(1);
    evalBatch(prog, c.textures, Float64Array.of(P[0]), Float64Array.of(P[1]), Float64Array.of(P[2]), o);
    expect(o[0]).toBe(evalReference(c, ...P, edge));
    near(o[0], (m - vc + cl) / 2);
  });

  test("a slot in a live pad-fill region is never pruned (rule (d))", () => {
    // Beside a and c, far from b but inside the (a, b) region's gate: (a)(b)(c) would prune b
    // (as they do in the gap > 0 twin, which has no fill), (d) keeps it.
    const gap0 = lower(TREES.contactPassBy), cut = lower({ root: { ...TREES.contactPassBy.root, gap: 0.3 } });
    expect(blockDecision(cut, -3, 0, -6, 0.3, undefined, 1).dec.kids[1]).toBeNull();
    expect(blockDecision(gap0, -3, 0, -6, 0.3, undefined, 1).dec.kids[1]).not.toBeNull();
  });

  test("compile cost: a five-capsule fan compiles in ≤ 20 ms CPU", () => {
    const fan = { root: { kind: "contact", children: [0, 1, 2, 3, 4].map((i) => cap([(i - 2) * 3, 0, 0], [(i - 2) * 9, 0, 30], 2)) } };
    compileImplicit(fan);   // warm-up
    const ms = [];
    for (let i = 0; i < 5; i++) { const t0 = cpuMs(); compileImplicit(fan); ms.push(cpuMs() - t0); }
    const med = ms.sort((a, b) => a - b)[2];
    console.log(`five-capsule fan compile: ${med.toFixed(2)} paced CPU ms`);
    expect(nRegions(regionsOf(lower(fan))[1])).toBe(2);
    expect(med).toBeLessThanOrEqual(20);
  });
});

describe("contact gap warning", () => {
  const spec = (gap) => ({ root: { kind: "contact", gap, children: [sph(-5.25), sph(5.25)] } });
  const gapWarnings = (gap, edge) => meshImplicit(compileImplicit(spec(gap)), edge).warnings.filter((w) => w.includes("contact gap"));
  test("a gap under 2 grid cells warns", () => {
    expect(gapWarnings(0.4, 0.6)).toEqual(["implicit: contact gap (0.40 mm) is under 2 grid cells at 0.6 mm — the grid cannot show it; raise the gap or mesh finer"]);
  });
  test("a fine enough grid, or gap 0, does not", () => {
    expect(gapWarnings(0.4, 0.1)).toEqual([]);
    expect(gapWarnings(0, 0.6)).toEqual([]);
  });
});

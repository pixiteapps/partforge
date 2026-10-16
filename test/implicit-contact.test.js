// test/implicit-contact.test.js
import { describe, test, expect } from "vitest";
import { validateSpec } from "../src/framework/geometry/implicit/grammar.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference, evalNodeAt } from "../src/framework/geometry/implicit/reference.js";
import { unionN } from "../src/framework/geometry/implicit/primitives.js";
import { clearance, C_MIN_CELLS, ATTACH_STRIDE } from "../src/framework/geometry/implicit/contact.js";

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

  test("overlap fuses a pad", () => {
    const c = lower({ root: { kind: "contact", gap: 0, children: [sph(-4), sph(4)] } });
    expect(c.ir.nodes[c.ir.root].fuse).toBe(1);
    expect(evalReference(c, 0, 0, 0, 1)).toBeLessThan(0);
    for (const y of [0, 0.5, 1, 1.9, -1.9]) {
      const d = Math.hypot(4, y) - 5;
      near(evalReference(c, 0, y, 0, 1), d);
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

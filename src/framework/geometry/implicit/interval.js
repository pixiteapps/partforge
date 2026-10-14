// src/framework/geometry/implicit/interval.js
// Per-block interval bounds and pruning decisions over the IR (plan Task 8 rules).
// A pruned slot provably contributes exactly nothing anywhere in the ball, so the
// program emitted from a decision equals the full tree there, bit for bit.
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, warpPoint, mirrorPoint, sanitize } from "./primitives.js";
import { evalExprScalar } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";

export const blockDecision = (c, cx, cy, cz, r) => visit(c, c.ir.root, cx, cy, cz, r);

function full(c, id) {
  const n = c.ir.nodes[id];
  if (n.children.length === 0) return { id };
  if (n.kind === "mirror") return { id, kids: [full(c, n.children[0]), full(c, n.children[0])] };
  return { id, kids: n.children.map((ch) => full(c, ch)) };
}
export const fullDecision = (c) => full(c, c.ir.root);

export function decisionKey(dec) {
  if (!dec.kids) return String(dec.id);
  return `${dec.id}(${dec.kids.map((k) => (k ? decisionKey(k) : "_")).join(",")})`;
}

const UNBOUNDED = (c, id) => ({ lo: -Infinity, hi: Infinity, dec: full(c, id) });

function visit(c, id, x, y, z, r) {
  const n = c.ir.nodes[id];
  if (n.inv) { const q = [0, 0, 0]; xformPoint(q, n.inv, x, y, z); x = q[0]; y = q[1]; z = q[2]; }
  switch (n.kind) {
    case "prim": { const v = evalPrim(n.prim.code, n.prim.P, x, y, z); return { lo: v - n.L * r, hi: v + n.L * r, dec: { id } }; }
    case "expr": { const v = sanitize(evalExprScalar(n.expr, x, y, z, c.textures, sampleTexture)); return { lo: v - n.L * r, hi: v + n.L * r, dec: { id } }; }
    case "union": {
      const rs = n.children.map((ch) => visit(c, ch, x, y, z, r));
      let H = Infinity;
      for (const a of rs) if (a.hi < H) H = a.hi;
      const kids = rs.map((a) => (a.lo > H + n.k ? null : a.dec));
      let lo = Infinity, kept = 0;
      rs.forEach((a, i) => { if (kids[i]) { kept++; if (a.lo < lo) lo = a.lo; } });
      if (n.k > 0) lo -= ((kept - 1) * n.k) / 4;
      return { lo, hi: H, dec: { id, kids } };
    }
    case "intersect": case "subtract": {
      const rs = n.children.map((ch, i) => {
        const a = visit(c, ch, x, y, z, r);
        return n.kind === "subtract" && i > 0 ? { lo: -a.hi, hi: -a.lo, dec: a.dec } : a;
      });
      let Lmax = -Infinity;
      for (const a of rs) if (a.lo > Lmax) Lmax = a.lo;
      const kids = rs.map((a) => (a.hi < Lmax - n.k ? null : a.dec));
      let hi = -Infinity, kept = 0;
      rs.forEach((a, i) => { if (kids[i]) { kept++; if (a.hi > hi) hi = a.hi; } });
      if (n.k > 0) hi += ((kept - 1) * n.k) / 4;
      return { lo: Lmax, hi, dec: { id, kids } };
    }
    case "mirror": {
      const A = visit(c, n.children[0], x, y, z, r), m = [0, 0, 0];
      mirrorPoint(m, n.axis, x, y, z);
      const B = visit(c, n.children[0], m[0], m[1], m[2], r);
      const keepA = !(A.lo > B.hi), keepB = !(B.lo > A.hi);
      const lo = Math.min(keepA ? A.lo : Infinity, keepB ? B.lo : Infinity), hi = Math.min(keepA ? A.hi : Infinity, keepB ? B.hi : Infinity);
      return { lo, hi, dec: { id, kids: [keepA ? A.dec : null, keepB ? B.dec : null] } };
    }
    case "round": { const a = visit(c, n.children[0], x, y, z, r); return { lo: a.lo - n.r, hi: a.hi - n.r, dec: { id, kids: [a.dec] } }; }
    case "onion": {
      const a = visit(c, n.children[0], x, y, z, r);
      const lo = a.lo >= 0 ? a.lo : a.hi <= 0 ? -a.hi : 0, hi = Math.max(Math.abs(a.lo), Math.abs(a.hi));
      return { lo: lo - n.t, hi: hi - n.t, dec: { id, kids: [a.dec] } };
    }
    case "displace": { const a = visit(c, n.children[0], x, y, z, r); return { lo: a.lo - Math.abs(n.amount), hi: a.hi + Math.abs(n.amount), dec: { id, kids: [a.dec] } }; }
    case "warp": {
      const q = [x, y, z], w = [0, 0, 0], { kind, W, B, Bt } = n.warp;
      if (B) xformDir(q, B, x, y, z);
      let S;
      if (kind === 1) S = 1 + Math.abs(W[0]) * (Math.sqrt(q[0] * q[0] + q[1] * q[1]) + r);
      else if (kind === 2) {
        const u = W[0] - q[0], rho = Math.sqrt(u * u + q[2] * q[2]);
        if (rho <= r) return UNBOUNDED(c, id);
        S = Math.max(1, W[0] / (rho - r));
      } else {
        const sAt = (zz) => { let t = (zz - W[0]) / (W[2] - W[0]); t = t < 0 ? 0 : t > 1 ? 1 : t; return W[1] + (W[3] - W[1]) * t; };
        const sMin = Math.min(sAt(q[2] - r), sAt(q[2] + r));   // s is linear (clamped) in z, so its minimum is at an end
        const slope = Math.abs(W[3] - W[1]) / Math.abs(W[2] - W[0]);
        S = Math.max(1, 1 / sMin) + (slope * (Math.sqrt(q[0] * q[0] + q[1] * q[1]) + r)) / (sMin * sMin);
      }
      warpPoint(w, kind, W, q[0], q[1], q[2]);
      if (Bt) xformDir(w, Bt, w[0], w[1], w[2]);
      const a = visit(c, n.children[0], w[0], w[1], w[2], r * S);
      return { lo: a.lo, hi: a.hi, dec: { id, kids: [a.dec] } };
    }
    case "ref": { const a = visit(c, n.children[0], x, y, z, r); return { lo: a.lo, hi: a.hi, dec: { id, kids: [a.dec] } }; }
    default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
  }
}

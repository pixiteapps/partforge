// src/framework/geometry/implicit/interval.js
// Per-block interval bounds and pruning decisions over the IR (plan Task 8 rules).
// A pruned slot provably contributes exactly nothing anywhere in the ball, so the
// program emitted from a decision equals the full tree there, bit for bit.
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, warpPoint, mirrorPoint, sanitize } from "./primitives.js";
import { evalExprScalar } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";
import { clearance, contactInterval, attachWeightRange, bulgeRange, ATTACH_STRIDE, BULGE_STRIDE } from "./contact.js";

// Inheriting a parent's decision (planLeaves' child blocks). `parentDec` is the decision of
// a ball that CONTAINS this one; a slot it pruned FIRMLY (`dec.firm[i]`) is not walked
// again — it stays pruned. This gives exactly the full walk's answer, because the full walk
// over the smaller ball would prune it too:
//  - Every leaf interval nests: v ± L·r' at centre c' lies inside v ± L·r at c whenever
//    |c' − c| + r' ≤ r (|v(c') − v(c)| ≤ L·|c' − c|; the frames, mirrors and warp bases are
//    rigid, so the point keeps its distance). planLeaves' octants are tangent inside their
//    parent: offset B·edge·√3/4, radius smaller by the same.
//  - Every node maps nested children to a nested interval and prunes a superset: union
//    prunes on lo_i − H − k − 1e-12·(|H| + k) > 0 (increasing in lo_i, decreasing in H: the
//    margin's slope is ±1e-12), intersect/subtract on Lmax − k − 1e-12·(|Lmax| + k) − hi_i > 0,
//    mirror on A.lo − B.hi − 1e-12·(|A.lo| + |B.hi|) > 0 — lo only rises and hi only falls
//    in the child, so each condition only gets truer; their outputs (min of kept lo less
//    (kept−1)·k/4, min of all hi; mirrored) move inward as the kept set shrinks. round,
//    onion (distance of the interval from 0, max |·|), displace and ref are monotone maps.
//  - Warps hand their child the ball (w(c), r·S) with S the stretch bound over the ball, so
//    the child ball nests when S' ≤ S: twist 1 + |rate|·(ρ + r) and ρ' + r' ≤ ρ + r; bend
//    R/(ρ − r) and ρ' − r' ≥ ρ − r; taper's sMin over [z − r, z + r] only rises and its
//    ρ + r only falls (scales are > 0). Bend's UNBOUNDED test (ρ ≤ r, or |z| ≤ r and
//    x + r ≥ R) holding for the child implies it for the parent, so a bounded parent never
//    has an unbounded child; an UNBOUNDED parent's decision is full (no pruned slot), so
//    its child starts from a full walk.
//  - A pruned slot never attains the node's H (union: lo_i > H, so hi_i > H) or Lmax
//    (intersect: hi_i < Lmax), nor decides the other mirror side (A pruned ⇒ B kept, and
//    the result is B's interval), so skipping it changes no other number.
// That argument is in real arithmetic, and the nesting is tangent: a floating-point
// rounding of a few ulps can break a tie the parent decided by less. So a prune is FIRM
// only when it holds by more than FIRM_REL·(|lo| + |threshold| + r + |x| + |y| + |z|) — far
// above the rounding of an interval endpoint — and a prune inside that band is walked
// again in the child, which then decides it exactly as the full walk does. It also rests
// on declared Lipschitz bounds being true (an expr's `lipschitz`) — the assumption the
// cull's own exactness already makes.
const FIRM_REL = 1e-9;

export const blockDecision = (c, cx, cy, cz, r, parentDec) => visit(c, c.ir.root, cx, cy, cz, r, parentDec);

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

// `pd`: this node's decision in an enclosing ball (see above), or undefined for a full walk.
const skip = (pd, i) => pd !== undefined && pd.kids[i] === null && pd.firm != null && pd.firm[i];
const sub = (pd, i) => (pd === undefined || pd.kids[i] === null ? undefined : pd.kids[i]);
const firmTol = (r, x, y, z, a, b) => FIRM_REL * (Math.abs(a) + Math.abs(b) + r + Math.abs(x) + Math.abs(y) + Math.abs(z));

function visit(c, id, x, y, z, r, pd) {
  const n = c.ir.nodes[id];
  if (n.inv) { const q = [0, 0, 0]; xformPoint(q, n.inv, x, y, z); x = q[0]; y = q[1]; z = q[2]; }
  switch (n.kind) {
    case "prim": { const v = evalPrim(n.prim.code, n.prim.P, x, y, z); return { lo: v - n.L * r, hi: v + n.L * r, dec: { id } }; }
    case "expr": { const v = sanitize(evalExprScalar(n.expr, x, y, z, c.textures, sampleTexture)); return { lo: v - n.L * r, hi: v + n.L * r, dec: { id } }; }
    case "union": case "intersect": case "subtract": {
      // union keeps slot i unless lo_i > T = H + k + margin (H = min hi); intersect/subtract
      // (operands after the first negated) unless hi_i < T = Lmax − k − margin (Lmax = max lo).
      const isU = n.kind === "union", neg = n.kind === "subtract", N = n.children.length;
      const rs = new Array(N);
      let E = isU ? Infinity : -Infinity;   // H for a union, Lmax otherwise
      for (let i = 0; i < N; i++) {
        if (skip(pd, i)) { rs[i] = null; continue; }
        let a = visit(c, n.children[i], x, y, z, r, sub(pd, i));
        if (neg && i > 0) a = { lo: -a.hi, hi: -a.lo, dec: a.dec };
        rs[i] = a;
        if (isU) { if (a.hi < E) E = a.hi; } else if (a.lo > E) E = a.lo;
      }
      const T = isU ? E + n.k + 1e-12 * (Math.abs(E) + n.k) : E - n.k - 1e-12 * (Math.abs(E) + n.k);
      const kids = new Array(N);
      let firm = null, out = isU ? Infinity : -Infinity, kept = 0;
      for (let i = 0; i < N; i++) {
        const a = rs[i];
        if (a !== null && !(isU ? a.lo > T : a.hi < T)) {
          kids[i] = a.dec; kept++;
          if (isU ? a.lo < out : a.hi > out) out = isU ? a.lo : a.hi;
          continue;
        }
        kids[i] = null;
        if (firm === null) firm = new Array(N).fill(false);
        firm[i] = a === null || (isU ? a.lo - T : T - a.hi) > firmTol(r, x, y, z, isU ? a.lo : a.hi, T);
      }
      if (n.k > 0) { if (isU) out -= ((kept - 1) * n.k) / 4; else out += ((kept - 1) * n.k) / 4; }
      return isU ? { lo: out, hi: E, dec: { id, kids, firm } } : { lo: E, hi: out, dec: { id, kids, firm } };
    }
    case "contact": {
      // Slot j is pruned when (a) lo_j > H2 (second-smallest hi over the other slots: j is
      // never among the two smallest values, so the min of the c_i does not move), (b)
      // lo_i + lo_j > cl for every other slot i (the pair's cut never rises above v_i, so no
      // other c_i moves) and (c) every attachment involving j has weight 0 over the ball (its
      // kk is 0: no blend term), each with the union's 1e-12 margin. Every condition only gets
      // truer as the ball shrinks (lo rises, hi falls, the near distance rises), so a firm
      // prune holds in every child ball.
      // A skipped (firmly pruned in the parent) slot never decides another slot: its lo
      // exceeds two other slots' hi, so its hi is never another slot's H2 when that slot
      // could be pruned, and (b) for the pair already held when it was pruned. The interval
      // is taken over the kept slots alone, which is exact (a pruned slot changes no value).
      // Every rule reads the BULGED children's intervals (bulgeRange: the offset's bounds over
      // the ball, which nest as the ball shrinks), as the field bulges before it cuts.
      const N = n.children.length, cl = clearance(n.gap), att = n.att, nA = att.length / ATTACH_STRIDE;
      const rs = new Array(N), lo = new Float64Array(N), hi = new Float64Array(N), off = [0, 0];
      for (let i = 0; i < N; i++) {
        if (skip(pd, i)) { rs[i] = null; continue; }
        const a = visit(c, n.children[i], x, y, z, r, sub(pd, i)), R = n.regions[i];
        rs[i] = a; lo[i] = a.lo; hi[i] = a.hi;
        if (R.length) { bulgeRange(off, R, 0, R.length / BULGE_STRIDE, x, y, z, r); lo[i] = a.lo - off[1]; hi[i] = a.hi - off[0]; }
      }
      const wr = new Array(nA);
      for (let a = 0; a < nA; a++) wr[a] = attachWeightRange(new Float64Array(3), att, a * ATTACH_STRIDE, x, y, z, r);
      const kids = new Array(N), keep = new Array(N);
      let firm = null;
      for (let j = 0; j < N; j++) {
        if (rs[j] === null) { kids[j] = null; keep[j] = false; if (firm === null) firm = new Array(N).fill(false); firm[j] = true; continue; }
        // (a): H2 over the other walked slots.
        let h1 = Infinity, h2 = Infinity;
        for (let i = 0; i < N; i++) {
          if (i === j || rs[i] === null) continue;
          if (hi[i] < h1) { h2 = h1; h1 = hi[i]; } else if (hi[i] < h2) h2 = hi[i];
        }
        const Ta = h2 + 1e-12 * Math.abs(h2);
        let prune = lo[j] > Ta, isFirm = prune && lo[j] - Ta > firmTol(r, x, y, z, lo[j], Ta);
        // (b): every other walked slot.
        for (let i = 0; prune && i < N; i++) {
          if (i === j || rs[i] === null) continue;
          const Tb = cl + 1e-12 * (Math.abs(lo[i]) + Math.abs(lo[j]) + cl);
          const s = lo[i] + lo[j];
          if (!(s > Tb)) prune = false;
          else if (!(s - Tb > firmTol(r, x, y, z, Math.abs(lo[i]) + Math.abs(lo[j]), Tb))) isFirm = false;
        }
        // (c): every attachment involving j has weight 0 over the ball.
        for (let a = 0; prune && a < nA; a++) {
          const o = a * ATTACH_STRIDE;
          if (att[o] !== j && att[o + 1] !== j) continue;
          if (wr[a][1] > 0) prune = false;
          else {
            const T = att[o + 5] + att[o + 6];
            if (!(wr[a][2] - T > firmTol(r, x, y, z, wr[a][2], T))) isFirm = false;
          }
        }
        if (!prune) { kids[j] = rs[j].dec; keep[j] = true; continue; }
        kids[j] = null; keep[j] = false;
        if (firm === null) firm = new Array(N).fill(false);
        firm[j] = isFirm;
      }
      const iv = contactInterval([0, 0], lo, hi, keep, N, cl, att, nA, wr);
      return { lo: iv[0], hi: iv[1], dec: { id, kids, firm } };
    }
    case "mirror": {
      // A pruned side implies the other is kept (A.lo > B.hi ≥ B.lo and A.hi ≥ A.lo), so at
      // most one side is skipped, and the result is then the other side's interval.
      if (skip(pd, 0) || skip(pd, 1)) {
        const s = skip(pd, 0) ? 1 : 0, m = [x, y, z];
        if (s === 1) mirrorPoint(m, n.axis, x, y, z);
        const K = visit(c, n.children[0], m[0], m[1], m[2], r, sub(pd, s));
        return { lo: K.lo, hi: K.hi, dec: { id, kids: s === 0 ? [K.dec, null] : [null, K.dec], firm: [s === 1, s === 0] } };
      }
      const A = visit(c, n.children[0], x, y, z, r, sub(pd, 0)), m = [0, 0, 0];
      mirrorPoint(m, n.axis, x, y, z);
      const B = visit(c, n.children[0], m[0], m[1], m[2], r, sub(pd, 1));
      const mA = 1e-12 * (Math.abs(A.lo) + Math.abs(B.hi)), mB = 1e-12 * (Math.abs(B.lo) + Math.abs(A.hi));
      const keepA = !(A.lo > B.hi + mA), keepB = !(B.lo > A.hi + mB);
      const lo = Math.min(keepA ? A.lo : Infinity, keepB ? B.lo : Infinity), hi = Math.min(keepA ? A.hi : Infinity, keepB ? B.hi : Infinity);
      const kids = [keepA ? A.dec : null, keepB ? B.dec : null];
      if (keepA && keepB) return { lo, hi, dec: { id, kids, firm: null } };
      const firm = [!keepA && A.lo - (B.hi + mA) > firmTol(r, x, y, z, A.lo, B.hi + mA), !keepB && B.lo - (A.hi + mB) > firmTol(r, x, y, z, B.lo, A.hi + mB)];
      return { lo, hi, dec: { id, kids, firm } };
    }
    case "round": { const a = visit(c, n.children[0], x, y, z, r, sub(pd, 0)); return { lo: a.lo - n.r, hi: a.hi - n.r, dec: { id, kids: [a.dec] } }; }
    case "onion": {
      const a = visit(c, n.children[0], x, y, z, r, sub(pd, 0));
      const lo = a.lo >= 0 ? a.lo : a.hi <= 0 ? -a.hi : 0, hi = Math.max(Math.abs(a.lo), Math.abs(a.hi));
      return { lo: lo - n.t, hi: hi - n.t, dec: { id, kids: [a.dec] } };
    }
    case "displace": { const a = visit(c, n.children[0], x, y, z, r, sub(pd, 0)); return { lo: a.lo - Math.abs(n.amount), hi: a.hi + Math.abs(n.amount), dec: { id, kids: [a.dec] } }; }
    case "warp": {
      const q = [x, y, z], w = [0, 0, 0], { kind, W, B, Bt } = n.warp;
      if (B) xformDir(q, B, x, y, z);
      let S;
      if (kind === 1) S = 1 + Math.abs(W[0]) * (Math.sqrt(q[0] * q[0] + q[1] * q[1]) + r);
      else if (kind === 2) {
        const u = W[0] - q[0], rho = Math.sqrt(u * u + q[2] * q[2]);
        if (rho <= r || (Math.abs(q[2]) <= r && q[0] + r >= W[0])) return UNBOUNDED(c, id);
        S = Math.max(1, W[0] / (rho - r));
      } else {
        const sAt = (zz) => { let t = (zz - W[0]) / (W[2] - W[0]); t = t < 0 ? 0 : t > 1 ? 1 : t; return W[1] + (W[3] - W[1]) * t; };
        const sMin = Math.min(sAt(q[2] - r), sAt(q[2] + r));   // s is linear (clamped) in z, so its minimum is at an end
        const slope = Math.abs(W[3] - W[1]) / Math.abs(W[2] - W[0]);
        S = Math.max(1, 1 / sMin) + (slope * (Math.sqrt(q[0] * q[0] + q[1] * q[1]) + r)) / (sMin * sMin);
      }
      warpPoint(w, kind, W, q[0], q[1], q[2]);
      if (Bt) xformDir(w, Bt, w[0], w[1], w[2]);
      const a = visit(c, n.children[0], w[0], w[1], w[2], r * S, sub(pd, 0));
      return { lo: a.lo, hi: a.hi, dec: { id, kids: [a.dec] } };
    }
    case "ref": { const a = visit(c, n.children[0], x, y, z, r, sub(pd, 0)); return { lo: a.lo, hi: a.hi, dec: { id, kids: [a.dec] } }; }
    default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
  }
}

// src/framework/geometry/implicit/program.js
// Emits a decision tree as a self-contained Float64Array program and runs it over
// batches of points. Every per-lane computation calls the SAME scalar functions as
// reference.js, in the same order, so the two agree exactly. PR 2 ports runProgram
// to C++; the program format is the contract between them.
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, unionN, intersectN, warpPoint, mirrorPoint, sanitize, clampUnit } from "./primitives.js";
import { UN, BIN, TER } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";
import { contactValue, clearance, bulgeOffset, ATTACH_STRIDE, BULGE_STRIDE } from "./contact.js";

export const OP = Object.freeze({ END: 0, XFORM: 1, XDIR: 2, PRIM: 3, UNION: 4, INTER: 5, NEG: 6, MIN2: 7, MIRRORP: 8, ADDC: 9, ONION: 10, WARP: 11, DISP: 12, SANITIZE: 13, CONTACT: 14, BULGE: 15, GET: 20, CONST: 21, UN: 22, BIN: 23, TER: 24, TEX: 25 });
export const UN_NAMES = Object.keys(UN), BIN_NAMES = Object.keys(BIN), TER_NAMES = Object.keys(TER);
// The fn codes UN/BIN/TER ops carry. Pinned by test: the native tables index these
// arrays, so reordering or inserting a function is a program-format change.
export const FN_CODES = Object.freeze({ UN: UN_NAMES, BIN: BIN_NAMES, TER: TER_NAMES });
const UN_FN = UN_NAMES.map((k) => UN[k]), BIN_FN = BIN_NAMES.map((k) => BIN[k]), TER_FN = TER_NAMES.map((k) => TER[k]);
export const BATCH = 256;

function fnCode(names, fn) {
  const c = names.indexOf(fn);
  if (c < 0) throw new Error(`implicit: unknown expr function ${fn}`);
  return c;
}

// Appends a lowered expr's ops: points read from register p, values in registers base + r.
function emitExprOps(code, L, p, base) {
  for (const o of L.ops) {
    const d = base + o.dst;
    if (o.op === "const") code.push(OP.CONST, d, o.val);
    else if (o.op === "get") code.push(OP.GET, d, p, o.comp);
    else if (o.op === "un") code.push(OP.UN, fnCode(UN_NAMES, o.fn), d, base + o.a);
    else if (o.op === "bin") code.push(OP.BIN, fnCode(BIN_NAMES, o.fn), d, base + o.a, base + o.b);
    else if (o.op === "ter") code.push(OP.TER, fnCode(TER_NAMES, o.fn), d, base + o.a, base + o.b, base + o.c);
    else if (o.op === "tex") code.push(OP.TEX, d, o.slot, base + o.u, base + o.v);
  }
}

/** A standalone program for one lowered expr (surface-detail heights). No SANITIZE: the caller maps NaN to 0. */
export function emitExprProgram(L) {
  const code = [];
  emitExprOps(code, L, 0, 0);
  code.push(OP.END, L.result);
  return Float64Array.from([1, L.nregs, ...code]);
}

// Layouts of the two contact ops (the rest are read off runProgram below):
//   [CONTACT, dst, p, cl, nK, nA, kidReg × nK, (ia, ib, ax, ay, az, r0, band, k) × nA,
//    (child, rank) × nK]
//     cl is clearance(gap) baked in; ia/ib index the EMITTED slots; an attachment with a
//     pruned side is dropped (its weight is 0 over the block — interval.js rule (c)). The
//     tail is one original child index per emitted slot, then each slot's tie rank (its
//     child's attachment count in the full table), which evalBatchContact reads to name each
//     slot's owner and piece (as does the core's ip_eval_contact).
//   [BULGE, dst, src, p, nR, (cx, cy, cz, A, rho) × nR]   → src − bulgeOffset(...)
//     emitted on a kept slot's register when that slot has regions, before CONTACT reads it.
export function emitProgram(compiled, dec) {
  const code = [];
  let nP = 1, nV = 0;
  const newP = () => nP++, newV = () => nV++;
  const nodes = compiled.ir.nodes;

  function emitExpr(L, p) {
    const base = nV; nV += L.nregs;
    emitExprOps(code, L, p, base);
    return base + L.result;
  }

  function emit(d, p) {
    const n = nodes[d.id];
    if (n.inv) { const q = newP(); code.push(OP.XFORM, q, p, ...n.inv); p = q; }
    switch (n.kind) {
      case "prim": { const v = newV(); code.push(OP.PRIM, n.prim.code, v, p, n.prim.P.length, ...n.prim.P); return v; }
      case "expr": { const r = emitExpr(n.expr, p), v = newV(); code.push(OP.SANITIZE, v, r); return v; }
      case "union": case "intersect": case "subtract": {
        const vs = [];
        d.kids.forEach((kd, i) => {
          if (!kd) return;
          let v = emit(kd, p);
          if (n.kind === "subtract" && i > 0) { const w = newV(); code.push(OP.NEG, w, v); v = w; }
          vs.push(v);
        });
        if (vs.length === 1) return vs[0];
        const out = newV();
        code.push(n.kind === "union" ? OP.UNION : OP.INTER, out, n.k, vs.length, ...vs);
        return out;
      }
      case "contact": {
        const vs = [], kid = [], slot = new Array(d.kids.length).fill(-1);
        d.kids.forEach((kd, i) => {
          if (!kd) return;
          slot[i] = vs.length;
          kid.push(i);
          let v = emit(kd, p);
          const R = n.regions[i];
          if (R.length) { const b = newV(); code.push(OP.BULGE, b, v, p, R.length / BULGE_STRIDE, ...R); v = b; }
          vs.push(v);
        });
        // A lone kept slot still emits, so its owner is named.
        const atts = [];
        for (let o = 0; o < n.att.length; o += ATTACH_STRIDE) {
          const ia = slot[n.att[o]], ib = slot[n.att[o + 1]];
          if (ia < 0 || ib < 0) continue;
          atts.push(ia, ib, ...n.att.subarray(o + 2, o + ATTACH_STRIDE));
        }
        const out = newV();
        // Each slot's tie rank for `piece`: its child's attachment count in the node's FULL table
        // (not the pruned list above), so every leaf ranks a child alike, whatever the order.
        const rank = new Array(d.kids.length).fill(0);
        for (let o = 0; o < n.att.length; o += ATTACH_STRIDE) { rank[n.att[o]]++; rank[n.att[o + 1]]++; }
        code.push(OP.CONTACT, out, p, clearance(n.gap), vs.length, atts.length / ATTACH_STRIDE, ...vs, ...atts, ...kid, ...kid.map((i) => rank[i]));
        return out;
      }
      case "mirror": {
        const [da, db] = d.kids, vs = [];
        if (da) vs.push(emit(da, p));
        if (db) { const q = newP(); code.push(OP.MIRRORP, q, p, n.axis); vs.push(emit(db, q)); }
        if (vs.length === 1) return vs[0];
        const out = newV(); code.push(OP.MIN2, out, vs[0], vs[1]); return out;
      }
      case "round": { const v = emit(d.kids[0], p), out = newV(); code.push(OP.ADDC, out, v, -n.r); return out; }
      case "onion": { const v = emit(d.kids[0], p), out = newV(); code.push(OP.ONION, out, v, n.t); return out; }
      case "displace": {
        const v = emit(d.kids[0], p), by = emitExpr(n.by, p), out = newV();
        code.push(OP.DISP, out, v, by, n.amount);
        return out;
      }
      case "warp": {
        const { kind, W, B, Bt } = n.warp;
        let q = p;
        if (B) { const t = newP(); code.push(OP.XDIR, t, q, ...B); q = t; }
        const w = newP(); code.push(OP.WARP, kind, w, q, W.length, ...W); q = w;
        if (Bt) { const t = newP(); code.push(OP.XDIR, t, q, ...Bt); q = t; }
        return emit(d.kids[0], q);
      }
      case "ref": return emit(d.kids[0], p);
      default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
    }
  }

  const root = emit(dec, 0);
  code.push(OP.END, root);
  return Float64Array.from([nP, nV, ...code]);
}

// Register files are reused across runs (allocation-free hot loop). Not shared
// state in any observable sense: every run overwrites what it reads.
let PX = [], PY = [], PZ = [], V = [];
const ensure = (arr, count) => { while (arr.length < count) arr.push(new Float64Array(BATCH)); return arr; };
const tmp = [0, 0, 0];
let gather = new Float64Array(64);   // UNION/INTER/CONTACT operand gather, grown on demand
let cScratch = new Float64Array(64), wScratch = new Float64Array(64);   // CONTACT's per-slot and per-attachment scratch
let shScratch = new Float64Array(64);   // the capture's per-slot shares

// `cap` (evalBatchContact's capture; null on the hot path) receives the contact op's
// per-child cut values and owner for these lanes, written at lane offset `off`.
export function runProgram(prog, textures, X, Y, Z, n, out, cap = null, off = 0) {
  if (n > BATCH) throw new Error(`implicit: runProgram takes at most ${BATCH} lanes (got ${n})`);
  const nP = prog[0], nV = prog[1];
  ensure(PX, nP); ensure(PY, nP); ensure(PZ, nP); ensure(V, nV);
  PX[0].set(X.subarray(0, n)); PY[0].set(Y.subarray(0, n)); PZ[0].set(Z.subarray(0, n));
  let pc = 2;
  for (;;) {
    const op = prog[pc];
    switch (op) {
      case OP.END: { const v = V[prog[pc + 1]]; for (let i = 0; i < n; i++) out[i] = v[i]; return; }
      case OP.XFORM: case OP.XDIR: {
        const d = prog[pc + 1], s = prog[pc + 2], M = prog.subarray(pc + 3, pc + 15);
        const sx = PX[s], sy = PY[s], sz = PZ[s], dx = PX[d], dy = PY[d], dz = PZ[d];
        for (let i = 0; i < n; i++) {
          if (op === OP.XFORM) xformPoint(tmp, M, sx[i], sy[i], sz[i]); else xformDir(tmp, M, sx[i], sy[i], sz[i]);
          dx[i] = tmp[0]; dy[i] = tmp[1]; dz[i] = tmp[2];
        }
        pc += 15; break;
      }
      case OP.PRIM: {
        const code = prog[pc + 1], dv = V[prog[pc + 2]], s = prog[pc + 3], np = prog[pc + 4], P = prog.subarray(pc + 5, pc + 5 + np);
        const sx = PX[s], sy = PY[s], sz = PZ[s];
        for (let i = 0; i < n; i++) dv[i] = evalPrim(code, P, sx[i], sy[i], sz[i]);
        pc += 5 + np; break;
      }
      case OP.UNION: case OP.INTER: {
        const dv = V[prog[pc + 1]], k = prog[pc + 2], cnt = prog[pc + 3];
        if (cnt > gather.length) gather = new Float64Array(Math.max(64, cnt));
        const g = gather;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < cnt; j++) g[j] = V[prog[pc + 4 + j]][i];
          dv[i] = op === OP.UNION ? unionN(g, cnt, k) : intersectN(g, cnt, k);
        }
        pc += 4 + cnt; break;
      }
      case OP.CONTACT: {
        const dv = V[prog[pc + 1]], s = prog[pc + 2], cl = prog[pc + 3], cnt = prog[pc + 4], nA = prog[pc + 5];
        const ko = pc + 6 + cnt + nA * ATTACH_STRIDE, att = prog.subarray(pc + 6 + cnt, ko);
        if (cnt > gather.length) gather = new Float64Array(Math.max(64, cnt));
        if (cnt > cScratch.length) cScratch = new Float64Array(cnt);
        if (nA > wScratch.length) wScratch = new Float64Array(nA);
        const g = gather, sx = PX[s], sy = PY[s], sz = PZ[s];
        // The child map and tie ranks (after the attachments), read by the capture.
        const capture = cap !== null;
        const kid = capture ? prog.subarray(ko, ko + cnt) : null, rank = capture ? prog.subarray(ko + cnt, ko + 2 * cnt) : null;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < cnt; j++) g[j] = V[prog[pc + 6 + j]][i];
          dv[i] = contactValue(g, cnt, cl, att, nA, sx[i], sy[i], sz[i], wScratch, cScratch);
          if (capture) captureOwner(cap, off + i, kid, cnt, att, nA, g, rank);
        }
        pc = ko + 2 * cnt; break;
      }
      case OP.BULGE: {
        const dv = V[prog[pc + 1]], src = V[prog[pc + 2]], s = prog[pc + 3], nR = prog[pc + 4];
        const R = prog.subarray(pc + 5, pc + 5 + nR * BULGE_STRIDE), sx = PX[s], sy = PY[s], sz = PZ[s];
        for (let i = 0; i < n; i++) dv[i] = src[i] - bulgeOffset(R, 0, nR, sx[i], sy[i], sz[i]);
        pc += 5 + nR * BULGE_STRIDE; break;
      }
      case OP.NEG: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]]; for (let i = 0; i < n; i++) d[i] = -s[i]; pc += 3; break; }
      case OP.MIN2: { const d = V[prog[pc + 1]], a = V[prog[pc + 2]], b = V[prog[pc + 3]]; for (let i = 0; i < n; i++) d[i] = Math.min(a[i], b[i]); pc += 4; break; }
      case OP.MIRRORP: {
        const d = prog[pc + 1], s = prog[pc + 2], axis = prog[pc + 3];
        for (let i = 0; i < n; i++) { mirrorPoint(tmp, axis, PX[s][i], PY[s][i], PZ[s][i]); PX[d][i] = tmp[0]; PY[d][i] = tmp[1]; PZ[d][i] = tmp[2]; }
        pc += 4; break;
      }
      case OP.ADDC: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]], c = prog[pc + 3]; for (let i = 0; i < n; i++) d[i] = s[i] + c; pc += 4; break; }
      case OP.ONION: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]], t = prog[pc + 3]; for (let i = 0; i < n; i++) d[i] = Math.abs(s[i]) - t; pc += 4; break; }
      case OP.WARP: {
        const kind = prog[pc + 1], d = prog[pc + 2], s = prog[pc + 3], np = prog[pc + 4], W = prog.subarray(pc + 5, pc + 5 + np);
        for (let i = 0; i < n; i++) { warpPoint(tmp, kind, W, PX[s][i], PY[s][i], PZ[s][i]); PX[d][i] = tmp[0]; PY[d][i] = tmp[1]; PZ[d][i] = tmp[2]; }
        pc += 5 + np; break;
      }
      case OP.DISP: {
        const d = V[prog[pc + 1]], s = V[prog[pc + 2]], b = V[prog[pc + 3]], a = prog[pc + 4];
        for (let i = 0; i < n; i++) d[i] = s[i] - a * clampUnit(b[i]);
        pc += 5; break;
      }
      case OP.SANITIZE: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]]; for (let i = 0; i < n; i++) d[i] = sanitize(s[i]); pc += 3; break; }
      case OP.GET: { const d = V[prog[pc + 1]], s = prog[pc + 2], c = prog[pc + 3], src = c === 0 ? PX[s] : c === 1 ? PY[s] : PZ[s]; for (let i = 0; i < n; i++) d[i] = src[i]; pc += 4; break; }
      case OP.CONST: { const d = V[prog[pc + 1]], c = prog[pc + 2]; for (let i = 0; i < n; i++) d[i] = c; pc += 3; break; }
      case OP.UN: { const f = UN_FN[prog[pc + 1]], d = V[prog[pc + 2]], a = V[prog[pc + 3]]; for (let i = 0; i < n; i++) d[i] = f(a[i]); pc += 4; break; }
      case OP.BIN: { const f = BIN_FN[prog[pc + 1]], d = V[prog[pc + 2]], a = V[prog[pc + 3]], b = V[prog[pc + 4]]; for (let i = 0; i < n; i++) d[i] = f(a[i], b[i]); pc += 5; break; }
      case OP.TER: { const f = TER_FN[prog[pc + 1]], d = V[prog[pc + 2]], a = V[prog[pc + 3]], b = V[prog[pc + 4]], c = V[prog[pc + 5]]; for (let i = 0; i < n; i++) d[i] = f(a[i], b[i], c[i]); pc += 6; break; }
      case OP.TEX: {
        const d = V[prog[pc + 1]], t = textures[prog[pc + 2]], u = V[prog[pc + 3]], v = V[prog[pc + 4]];
        for (let i = 0; i < n; i++) d[i] = sampleTexture(t, u[i], v[i]);
        pc += 5; break;
      }
      default: throw new Error(`implicit: bad opcode ${op} at ${pc}`);
    }
  }
}

// One lane of the contact op's capture, from the scratch contactValue just filled:
// cScratch[j] the emitted slot j's cut value, wScratch[a] the attachment weights; `kid[j]`
// is slot j's original child index, `g` scratch for the blend operands.
function captureOwner(cap, lane, kid, cnt, att, nA, g, rank) {
  const K = cap.K, q = lane * K;
  if (cnt > shScratch.length) shScratch = new Float64Array(cnt);
  // Each slot's share: its cut, lowered by every attachment blend it takes part in, in order.
  const sh = shScratch;
  for (let j = 0; j < cnt; j++) sh[j] = cScratch[j];
  for (let a = 0; a < nA; a++) {   // a blend lowers both of its pieces' shares
    const o = a * ATTACH_STRIDE, kk = att[o + 7] * wScratch[a];
    if (!(wScratch[a] > 0) || !(kk > 0)) continue;
    g[0] = cScratch[att[o]]; g[1] = cScratch[att[o + 1]];
    const u = unionN(g, 2, kk);
    if (u < sh[att[o]]) sh[att[o]] = u;
    if (u < sh[att[o + 1]]) sh[att[o + 1]] = u;
  }
  if (cap.cuts) for (let j = 0; j < cnt; j++) cap.cuts[q + kid[j]] = cScratch[j];
  if (cap.shares) for (let j = 0; j < cnt; j++) cap.shares[q + kid[j]] = sh[j];
  if (cap.piece) {
    // The piece: the least share. A blend lowers both of its pieces' shares alike, so they tie
    // inside it. A tie goes first to a child whose own cut is the share (inside a digit's zone,
    // deep in the palm, the blend is just the palm's cut and the point is the palm's), then to
    // the child in fewer attachments (`rank`, counted over the node's full table at compile — a
    // palm holds every digit's, a digit its own), so a digit's web is the digit's and two
    // digits' webs stay two pieces whatever order the children are listed in; equal ranks go to
    // the lesser child. Nothing here reads the pruned attachment list, so every leaf labels a
    // shared sample alike.
    let bp = -1, bs = Infinity, bo = 1;
    for (let j = 0; j < cnt; j++) {
      const sj = sh[j];
      const own = sj === cScratch[j] ? 0 : 1;   // 0: its own cut makes the share, not a blend
      if (bp < 0 || sj < bs || (sj === bs && (own < bo || (own === bo && (rank[j] < rank[bp] || (rank[j] === rank[bp] && kid[j] < kid[bp])))))) { bp = j; bs = sj; bo = own; }
    }
    cap.piece[lane] = kid[bp];
  }
  if (cap.owner) {
    // TEST-ONLY: no production stage passes `owner` — meshing reads the order-free `piece` above.
    // The merged owner is kept for the tests that pin it (and its native twin, capture_owner).
    // The least cut (the first, on a tie); overlapping attachment zones merge to the lesser child of
    // the pair holding it, until stable.
    let best = 0;
    for (let j = 1; j < cnt; j++) if (cScratch[j] < cScratch[best]) best = j;
    let owner = kid[best];
    for (let moved = true; moved;) {
      moved = false;
      for (let a = 0; a < nA; a++) {
        if (!(wScratch[a] > 0)) continue;
        const o = a * ATTACH_STRIDE, ka = kid[att[o]], kb = kid[att[o + 1]];
        if ((ka === owner || kb === owner) && Math.min(ka, kb) < owner) { owner = Math.min(ka, kb); moved = true; }
      }
    }
    cap.owner[lane] = owner;
  }
}

/**
 * evalBatch for a program holding a contact op, also capturing per point (into `cap`,
 * whichever arrays are present; K the child count): `owner[i]` (TEST-ONLY — no production stage
 * reads it: the argmin child of the cuts, merged to the lesser child across attachment zones —
 * never AIR, the caller applies the sign), `cuts[i·K + child]` (each child's cut value, +Infinity for a pruned child) and
 * `shares` (the cut lowered by any attachment blend the child takes part in) and `piece[i]` (the
 * child of the least share, a tie going to the child in fewer attachments, then the lesser: the owner the meshing stages use,
 * where attached pieces tie inside their blend but two digits both blended into the palm stay two
 * pieces). `out` is bit-identical to evalBatch's.
 */
export function evalBatchContact(prog, textures, X, Y, Z, out, cap) {
  const N = X.length;
  if (cap.owner) cap.owner.fill(-1);
  if (cap.piece) cap.piece.fill(-1);
  if (cap.cuts) cap.cuts.fill(Infinity);
  if (cap.shares) cap.shares.fill(Infinity);
  for (let s = 0; s < N; s += BATCH) {
    const n = Math.min(BATCH, N - s);
    runProgram(prog, textures, X.subarray(s, s + n), Y.subarray(s, s + n), Z.subarray(s, s + n), n, out.subarray(s, s + n), cap, s);
  }
}

export function evalBatch(prog, textures, X, Y, Z, out) {
  const N = X.length;
  for (let s = 0; s < N; s += BATCH) {
    const n = Math.min(BATCH, N - s);
    const o = out.subarray(s, s + n);
    runProgram(prog, textures, X.subarray(s, s + n), Y.subarray(s, s + n), Z.subarray(s, s + n), n, o);
  }
}

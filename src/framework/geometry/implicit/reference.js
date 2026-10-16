// src/framework/geometry/implicit/reference.js
// The semantic oracle: a plain recursive walk of the IR. The interval pass and the
// bytecode interpreter must agree with it EXACTLY (tests hold them to it).
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, unionN, intersectN, warpPoint, mirrorPoint, sanitize, clampUnit } from "./primitives.js";
import { contactValue, clearance, bulgeOffset, ATTACH_STRIDE, BULGE_STRIDE, FILL_STRIDE } from "./contact.js";
import { evalExprScalar } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";

export const evalReference = (compiled, x, y, z, edge = 0) => evalNode(compiled, compiled.ir.root, x, y, z, edge, 0);
/** Evaluates one IR node at a point in its parent's coordinates (applying its own `inv`). */
export const evalNodeAt = (compiled, id, x, y, z, edge = 0) => evalNode(compiled, id, x, y, z, edge, 0);

// Scratch for a node's children's values, one per recursion depth (a child's walk only
// touches deeper ones), so a walk allocates nothing; the arithmetic is unchanged.
const Q = [0, 0, 0], SCRATCH = [];
const scratch = (dep, n) => {
  let s = SCRATCH[dep];
  if (!s || s.length < n) SCRATCH[dep] = s = new Float64Array(Math.max(n, 8));
  return s;
};

function evalNode(c, id, x, y, z, edge, dep) {
  const n = c.ir.nodes[id];
  if (n.inv) { xformPoint(Q, n.inv, x, y, z); x = Q[0]; y = Q[1]; z = Q[2]; }
  switch (n.kind) {
    case "prim": return evalPrim(n.prim.code, n.prim.P, x, y, z);
    case "expr": return sanitize(evalExprScalar(n.expr, x, y, z, c.textures, sampleTexture));
    case "union": case "intersect": case "subtract": {
      const N = n.children.length, v = scratch(dep, N);
      for (let i = 0; i < N; i++) { const d = evalNode(c, n.children[i], x, y, z, edge, dep + 1); v[i] = n.kind === "subtract" && i > 0 ? -d : d; }
      return n.kind === "union" ? unionN(v, N, n.k) : intersectN(v, N, n.k);
    }
    case "contact": {
      const v = new Float64Array(n.children.length);
      // Bulge first (a slot with regions), then the clearance cut and the gated pad fill.
      n.children.forEach((ch, i) => {
        const d = evalNode(c, ch, x, y, z, edge, dep + 1), R = n.regions[i];
        v[i] = R.length ? d - bulgeOffset(R, 0, R.length / BULGE_STRIDE, x, y, z) : d;
      });
      return contactValue(v, v.length, clearance(n.gap, edge), n.fuse, n.att, n.att.length / ATTACH_STRIDE, n.fillRegions, n.fillRegions.length / FILL_STRIDE, x, y, z);
    }
    case "mirror": {
      const a = evalNode(c, n.children[0], x, y, z, edge, dep + 1), m = [0, 0, 0];
      mirrorPoint(m, n.axis, x, y, z);
      const b = evalNode(c, n.children[0], m[0], m[1], m[2], edge, dep + 1);
      return Math.min(a, b);
    }
    case "round": return evalNode(c, n.children[0], x, y, z, edge, dep + 1) - n.r;
    case "onion": return Math.abs(evalNode(c, n.children[0], x, y, z, edge, dep + 1)) - n.t;
    case "displace": {
      const d = evalNode(c, n.children[0], x, y, z, edge, dep + 1);
      return d - n.amount * clampUnit(evalExprScalar(n.by, x, y, z, c.textures, sampleTexture));
    }
    case "warp": {
      const q = [x, y, z], w = [0, 0, 0];
      if (n.warp.B) xformDir(q, n.warp.B, x, y, z);
      warpPoint(w, n.warp.kind, n.warp.W, q[0], q[1], q[2]);
      if (n.warp.Bt) xformDir(w, n.warp.Bt, w[0], w[1], w[2]);
      return evalNode(c, n.children[0], w[0], w[1], w[2], edge, dep + 1);
    }
    case "ref": return evalNode(c, n.children[0], x, y, z, edge, dep + 1);
    default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
  }
}

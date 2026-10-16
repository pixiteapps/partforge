// src/framework/geometry/implicit/reference.js
// The semantic oracle: a plain recursive walk of the IR. The interval pass and the
// bytecode interpreter must agree with it EXACTLY (tests hold them to it).
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, unionN, intersectN, warpPoint, mirrorPoint, sanitize, clampUnit } from "./primitives.js";
import { evalExprScalar } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";

export const evalReference = (compiled, x, y, z) => evalNode(compiled, compiled.ir.root, x, y, z);

function evalNode(c, id, x, y, z) {
  const n = c.ir.nodes[id];
  if (n.inv) { const q = [0, 0, 0]; xformPoint(q, n.inv, x, y, z); x = q[0]; y = q[1]; z = q[2]; }
  switch (n.kind) {
    case "prim": return evalPrim(n.prim.code, n.prim.P, x, y, z);
    case "expr": return sanitize(evalExprScalar(n.expr, x, y, z, c.textures, sampleTexture));
    case "union": case "intersect": case "subtract": {
      const v = new Float64Array(n.children.length);
      n.children.forEach((ch, i) => { const d = evalNode(c, ch, x, y, z); v[i] = n.kind === "subtract" && i > 0 ? -d : d; });
      return n.kind === "union" ? unionN(v, v.length, n.k) : intersectN(v, v.length, n.k);
    }
    case "mirror": {
      const a = evalNode(c, n.children[0], x, y, z), m = [0, 0, 0];
      mirrorPoint(m, n.axis, x, y, z);
      const b = evalNode(c, n.children[0], m[0], m[1], m[2]);
      return Math.min(a, b);
    }
    case "round": return evalNode(c, n.children[0], x, y, z) - n.r;
    case "onion": return Math.abs(evalNode(c, n.children[0], x, y, z)) - n.t;
    case "displace": {
      const d = evalNode(c, n.children[0], x, y, z);
      return d - n.amount * clampUnit(evalExprScalar(n.by, x, y, z, c.textures, sampleTexture));
    }
    case "warp": {
      const q = [x, y, z], w = [0, 0, 0];
      if (n.warp.B) xformDir(q, n.warp.B, x, y, z);
      warpPoint(w, n.warp.kind, n.warp.W, q[0], q[1], q[2]);
      if (n.warp.Bt) xformDir(w, n.warp.Bt, w[0], w[1], w[2]);
      return evalNode(c, n.children[0], w[0], w[1], w[2]);
    }
    case "ref": return evalNode(c, n.children[0], x, y, z);
    default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
  }
}

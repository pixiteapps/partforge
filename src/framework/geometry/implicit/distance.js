// implicitDistance(node) → (x, y, z) => mm: a k.implicit node's field as a plain point
// function — what the kinematics domain's `grip.around` takes for a shape its own
// closed forms (the kinematics shapes module) cannot measure: a blend, a warp, an expr.
// It is the engine's field exactly (the full program, nothing pruned), so on the plain
// shapes it agrees with those closed forms. Like k.implicit's own field it is a bound,
// not always a true distance (an ellipsoid, a blend, a warp): negative inside, zero on
// the surface.
import { compileImplicit } from "./compile.js";
import { fullDecision } from "./interval.js";
import { emitProgram, evalBatch } from "./program.js";

/**
 * The signed distance (negative inside) to `node`, in part coordinates. The node is a
 * k.implicit root (validated and lowered once, here; a bad one throws ImplicitSpecError).
 * It names no frames — there are none to resolve. `images` maps the image names an
 * expr's textures read to their decoded grids, as a Map or a plain object.
 */
export function implicitDistance(node, { images } = {}) {
  const map = images instanceof Map ? images : new Map(Object.entries(images ?? {}));
  const compiled = compileImplicit({ root: node }, { images: map });
  const prog = emitProgram(compiled, fullDecision(compiled));
  // One set of 1-element buffers per returned function, reused by every call: the function is
  // not reentrant (calling it from inside itself would clobber them) — fine for grip's
  // sequential probes; a caller that nests calls should make a second function.
  const X = new Float64Array(1), Y = new Float64Array(1), Z = new Float64Array(1), out = new Float64Array(1);
  return (x, y, z) => {
    X[0] = x; Y[0] = y; Z[0] = z;
    evalBatch(prog, compiled.textures, X, Y, Z, out);
    return out[0];
  };
}

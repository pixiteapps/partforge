// src/framework/geometry/solid-sugar.js
// The backend-shared Solid front, defined ONCE over both geometry backends. Every
// Solid a backend's wrap() returns is passed through addSugar(), which:
//   - attaches the readable transform/placement vocabulary (rotateX/along/at/…),
//     composed purely from the solid's own rotate()/translate() primitives, so the
//     sugar is geometry-identical on Manifold and OCCT alike;
//   - validates arguments the backends would otherwise each check (scale factor);
//   - derives boundingBox center/size from the backend's raw {min,max};
//   - normalizes the options-object calling convention for fillet/chamfer/shell
//     when the backend provides them natively (OCCT);
//   - stubs any OCCT-only op the backend lacks with a KernelCapabilityError, so
//     the needs-occt reroute works without hand-written per-backend stubs.
import { KernelCapabilityError } from "./errors.js";
import { OCCT_ONLY_OPS } from "./kernel.js";
import { isPlainOptions, isZeroMagnitudeCadOp, SOLID_OP_SPECS } from "./op-options.js";

const ORIGIN = [0, 0, 0];
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

export const SUGAR = {
  rotateX(deg) { return this.rotate(deg, ORIGIN, [1, 0, 0]); },
  rotateY(deg) { return this.rotate(deg, ORIGIN, [0, 1, 0]); },
  rotateZ(deg) { return this.rotate(deg, ORIGIN, [0, 0, 1]); },
  rotateAbout({ axis, deg, through = ORIGIN }) {
    const ax = Array.isArray(axis) ? axis : AXIS[axis];
    if (!ax) throw new Error(`rotateAbout: unknown axis ${JSON.stringify(axis)} (use "X"|"Y"|"Z" or a [x,y,z] vector)`);
    return this.rotate(deg, through, ax);
  },
  along(dir) {
    switch (dir) {
      case "+Z": return this.translate(ORIGIN);   // fresh handle, identity geometry — consistent with the other directions
      case "-Z": return this.rotate(180, ORIGIN, [1, 0, 0]);
      case "+Y": return this.rotate(-90, ORIGIN, [1, 0, 0]);
      case "-Y": return this.rotate(90, ORIGIN, [1, 0, 0]);
      case "+X": return this.rotate(90, ORIGIN, [0, 1, 0]);
      case "-X": return this.rotate(-90, ORIGIN, [0, 1, 0]);
      default: throw new Error(`along: unknown direction ${JSON.stringify(dir)} (use "+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z")`);
    }
  },
  at(v) { return this.translate(v); },
};

export function addSugar(s) {
  const rawScale = s.scale;
  s.scale = (factor, center = ORIGIN) => {
    if (!(factor > 0)) throw new Error("scale: factor must be > 0");
    return rawScale(factor, center);
  };

  const rawBoundingBox = s.boundingBox;
  s.boundingBox = () => {
    const { min, max } = rawBoundingBox();
    return {
      min, max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    };
  };

  // Options-object calling convention for the multi-param B-rep ops. Wrap only
  // when the backend provides the op natively (OCCT); the Manifold stubs below
  // read their arguments just enough to spot the zero-magnitude identity case,
  // and throw the routing error for everything else.
  for (const [op, { toArgs }] of Object.entries(SOLID_OP_SPECS)) {
    const raw = s[op];
    if (raw) s[op] = (...a) => raw(...(a.length === 1 && isPlainOptions(a[0]) ? toArgs(a[0]) : a));
  }

  for (const op of OCCT_ONLY_OPS) {
    // Zero magnitude is the identity per the contract — return a fresh handle
    // (same idiom as along("+Z")) so an unguarded `.fillet(p.r)` at r = 0 builds
    // on the core kernel instead of throwing the routing error.
    s[op] ??= (...a) => {
      if (isZeroMagnitudeCadOp(op, a)) return s.translate(ORIGIN);
      throw new KernelCapabilityError(`${op} requires the OCCT backend`);
    };
  }

  return Object.assign(s, SUGAR);
}

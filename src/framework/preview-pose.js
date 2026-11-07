// The cached preview's pose ladder: rung 1 only, with the FILE as the delivery. A
// preview GLB holds one view's meshes already posed at the params it was written at
// (the file params, which it carries since encoder 6); re-posing a mesh for other
// params needs no kernel when its place() is a rigid motion — the matrix that moves
// it is place(p, d) · place(file)⁻¹, the same relative-matrix rule the collision
// world's relativeMatsAt implements. A handle is place-only here exactly when every
// sub-part its params move has a trusted rigid placement (collide/place.js's
// placeMatrix); one whose placement is untrusted or non-rigid reads null and stays
// where the file put it.
//
// openingParams is the params a file's meshes sit at: in a file with a baked
// autoplay animation every tracked mesh decodes at that animation's first frame, so
// its t = 0 values win over the live params.
//
// Rules: matricesAt never derives (it takes a resolved p, d); apply never re-sends a
// matrix equal to the one last applied (pose-fast-path.js's setPose rule —
// setSubPose restarts the contact shadow) and never sends null.
//
// Pure: no DOM, no three.js, no node:. The oracle imports it in a Web Worker, so it
// imports only pure leaves — never collide/world.js, which carries the BVH and the
// native core.
import { placeMatrix } from "./collide/place.js";
import { invertRigid, mulMat4 } from "./geometry/pose.js";
import { resolveParams } from "./part-model.js";
import { viewAnimations, evaluate } from "./animation.js";

/** The params a preview file's meshes sit at: live params under the autoplay animation's t = 0 values. */
export function openingParams(part, view, params = {}) {
  const live = { ...part.defaults, ...params };
  let anim;
  try { anim = viewAnimations(part).get(view)?.find((a) => a.autoplay); } catch { anim = undefined; }
  return anim ? { ...live, ...evaluate(anim, 0).values } : live;
}

const same = (a, b) => a === b || (a != null && b != null && a.every((v, i) => v === b[i]));

/**
 * Places a preview file's meshes at other params. `base` is each drawn sub-part's
 * placement at the file params (null: untrusted or non-rigid); a drawn name the part
 * lacks is left out.
 */
export function createFilePlacer(part, view, fileParams, drawnNames) {
  const has = (name) => Object.prototype.hasOwnProperty.call(part.parts ?? {}, name);
  const r0 = resolveParams(part, fileParams);
  const base = new Map();
  const inverses = new Map();
  for (const name of drawnNames) {
    if (!has(name)) continue;
    const m = placeMatrix(part.parts[name], view, r0.p, r0.d);
    base.set(name, m);
    inverses.set(name, m ? invertRigid(m) : null);
  }

  /** place(p, d) · base⁻¹ per name; null when either side is null or the name was never placed. */
  function matricesAt(p, d, names = drawnNames) {
    const out = new Map();
    for (const name of names) {
      const inv = inverses.get(name);
      if (!inv) { if (base.has(name)) out.set(name, null); continue; }
      const m = placeMatrix(part.parts[name], view, p, d);
      out.set(name, m ? mulMat4(m, inv) : null);
    }
    return out;
  }

  // What each mesh shows: the matrix at the file params to begin with (the identity,
  // computed the same way, so recomputing it there compares equal and is not sent).
  const shown = matricesAt(r0.p, r0.d);

  /** Pose the viewer's meshes at params; returns the names whose matrix was sent. */
  function apply(viewer, params) {
    const { p, d } = resolveParams(part, params);
    const sent = [];
    for (const [name, m] of matricesAt(p, d)) {
      if (m == null || same(shown.get(name), m)) continue;
      shown.set(name, m);
      viewer.setSubPose(name, m);
      sent.push(name);
    }
    return sent;
  }

  return { base, matricesAt, apply };
}

// Pure core: turn a backend-agnostic raycast hit into a semantic Selection.
// No three.js, no DOM, no kernel — only the param-deps read-key analysis.
import { subPartParamKeys } from "../param-deps.js";

const COS_3DEG = 0.99863; // a normal within 3° of an axis snaps to that axis
const q2 = (x) => { const r = Math.round(x * 100) / 100; return r === 0 ? 0 : r; }; // 0.01mm, kill -0

export function quantizePoint(p) {
  return [q2(p[0]), q2(p[1]), q2(p[2])];
}

export function snapNormal(n) {
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const u = [n[0] / len, n[1] / len, n[2] / len];
  let ai = 0; // index of the dominant axis
  if (Math.abs(u[1]) > Math.abs(u[ai])) ai = 1;
  if (Math.abs(u[2]) > Math.abs(u[ai])) ai = 2;
  if (Math.abs(u[ai]) >= COS_3DEG) {
    const axis = [0, 0, 0];
    axis[ai] = u[ai] > 0 ? 1 : -1;
    return axis;
  }
  return [q2(u[0]), q2(u[1]), q2(u[2])];
}

// Only the params the clicked sub-part reads — "this geometry, at these inputs".
// Recorded from its last real build when the host passes ctx.readsOf (mount's
// mesh cache), else predicted (param-deps.subPartParamKeys).
function scopeParams(part, ctx, subPart) {
  const out = {};
  for (const k of subPartParamKeys(part, ctx.view, ctx.params, ctx.readsOf, subPart)) out[k] = ctx.params[k];
  return out;
}

export function resolveSelection(part, ctx, hit) {
  const point = quantizePoint(hit.pointLocal);
  const selection = {
    subPart: hit.subPart,
    point,
    normal: snapNormal(hit.normalLocal),
    params: scopeParams(part, ctx, hit.subPart),
  };
  // Feature attribution from the mesh payload (Solid.label() in the part's build) —
  // the same name the hover tooltip shows, so user, agent, and viewer share vocabulary.
  if (hit.feature) selection.feature = { label: hit.feature.label };
  // A cutaway section pick: the point is inside the material, on the cut face,
  // not on a surface the part was built with. Callers that describe the click
  // in words need to say so — the coordinates alone read as a normal surface.
  if (hit.onCutPlane) selection.onCutPlane = true;
  return selection;
}

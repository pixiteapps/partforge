// One sub-part's place() as a rigid matrix, and every in-view sub-part's (poseMatrices).
// An import-light leaf (pose-probe-core, geometry/pose and the part model) so the
// main-thread bundle and lint can share the rule with the collision world without
// carrying the BVH or the native core.
import { CANONICAL, probeSubPartPose } from "../pose-probe-core.js";
import { addSugar } from "../geometry/solid-sugar.js";
import { MAX_PROBE_OPS } from "../geometry/probe.js";
import { composePose, isRigid, mulMat4 } from "../geometry/pose.js";
import { viewSubParts } from "../part-model.js";
import { placeOf } from "../sub-part-views.js";

// The rigid case, fast. The collision guard asks for placements on every solver
// evaluation, and the full place-scope probe builds a token carrying every kernel op
// for each transform step — most of a placement's cost. A place() that only moves its
// solid (translate, rotate, clone and the transform sugar composed from them, which
// addSugar puts on this prototype exactly as it does on every Solid) needs none of
// that: this token records the same pose steps the probe's would. Anything else — a
// query, a reshaping op, a throw, a non-finite step, a runaway, a returned value that
// is not one of these tokens — is not answered here: the full probe runs instead, so
// every placement reads exactly what probeSubPartPose's rule gives.
const RIGID = addSugar({
  translate(v) { return rigidToken(this._session, [...this._pose, { t: "translate", v }]); },
  rotate(deg, center, axis) { return rigidToken(this._session, [...this._pose, { t: "rotate", deg, center, axis }]); },
  clone() { return this; }, // immutable, like the probe's tokens
});

function rigidToken(session, pose) {
  if (++session.ops > MAX_PROBE_OPS) throw new Error("rigid place probe: runaway");
  const t = Object.create(RIGID);
  t._session = session; t._pose = pose;
  return t;
}

const finiteVec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const stepsFinite = (steps) => steps.every((st) =>
  st.t === "translate" ? finiteVec(st.v) : Number.isFinite(st.deg) && finiteVec(st.center) && finiteVec(st.axis));

/** The pose steps of a place() that only moves its solid, else undefined (not answered). */
function rigidSteps(sp, view, p, d) {
  const place = placeOf(sp);
  if (!place) return [];
  try {
    const s = place(rigidToken({ ops: 0 }, []), { view, purpose: "display", p, d });
    if (!s || Object.getPrototypeOf(s) !== RIGID || !stepsFinite(s._pose)) return undefined;
    return s._pose;
  } catch {
    return undefined;
  }
}

/** One sub-part's place() as a rigid mat4, or null when it is not a trusted rigid motion. */
export function placeMatrix(sp, view, p, d) {
  let steps = rigidSteps(sp, view, p, d);
  if (steps === undefined) {
    const probe = probeSubPartPose(sp, { view, purpose: "display", p, d }, { scope: "place" });
    if (!probe?.trusted || probe.baseHash !== CANONICAL) return null;
    steps = probe.pose;
  }
  const m = Array.from(composePose(steps));
  return isRigid(m) ? m : null;
}

/**
 * placeMatrix for every in-view sub-part at an already-resolved (p, d); never derives.
 * `only` (an iterable of names): just those of them — a map that leaves the others out,
 * which the mats contract reads as identity, so it is for callers that read no other.
 */
export function poseMatrices(part, view, p, d, { deltas, only = null } = {}) {
  const out = new Map();
  const want = only ? new Set(only) : null;
  for (const name of viewSubParts(part, view, p)) {
    if (want && !want.has(name)) continue;
    const m = placeMatrix(part.parts[name], view, p, d);
    const delta = deltas?.get(name);
    out.set(name, m && delta ? mulMat4(delta, m) : m);
  }
  return out;
}

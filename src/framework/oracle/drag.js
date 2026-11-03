// dragHandle: a handle drag played without a browser (spec 2026-11-02 handles for limbs,
// goal 4). An agent writing a part asks "turn the input gear 90°: does driveAngle go +90?"
// or "pull the drawer out 40 mm: which param moves, and does it get there?" and gets the
// answer from derive alone — no kernel, no viewer.
//
// It plays the drag the way Pose mode would with no pins: from the handle's point at the
// starting params to the target in `steps` evenly spaced frames (a rotary drag at least one
// per 30°, its turn tracked unwrapped so a miss of whole turns still reads), each solved warm from the
// last frame's values through pose-session's defaultSolve (which routes generic, goal and
// angles handles, a goal limb grabbed mid-chain included), then snapped as a release
// snaps them (snapValues). The grab point is read again at the snapped values.
//
// Never throws: a bad request or a failed solve returns `{ handle, error }`.
// DOM-free, three-free and node:-free like the rest of the oracle.

import { resolveParams } from "../part-model.js";
import { defaultSolve } from "../pose/pose-session.js";
import { snapValues, limbInfo, goalGrabJoints } from "../pose/param-solve.js";
import { handleKind, handleAt, locateHandle, handleAxis } from "../pose/handle-source.js";
import { handlesShownInView } from "../pose/handle-views.js";
import { angleAbout, wrapTo180 } from "../solve/axis-angle.js";

const ROTARY_STEP_DEG = 30; // a rotary drag's largest frame
const ROTARY_LEAD_DEG = 90; // the most a rotary frame asks for past where the point is
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, t) => add(a, scale(sub(b, a), t));
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? scale(a, 1 / l) : null;
};
const round = (v) => Math.round(v * 1000) / 1000 + 0; // + 0 turns -0 into 0
const roundVec = (v) => v.map(round);
const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 160);

/** `p` turned by `deg` about the axis line (Rodrigues; right-hand rule about direction). */
function rotateAbout(p, axis, deg) {
  const k = unit(axis.direction);
  const v = sub(p, axis.origin);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const kxv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  const r = add(add(scale(v, c), scale(kxv, s)), scale(k, dot(k, v) * (1 - c)));
  return add(axis.origin, r);
}

/**
 * Play a drag of `handle` and report where it lands.
 * @param part a PartDefinition with `handles`
 * @param req.handle the handle id
 * @param req.to [x, y, z] (point / axis / plane / goal / angles): an axis drag projects it
 *   onto its axis line, a plane drag onto its plane, both through the handle's start point
 * @param req.turn degrees (rotary), right-handed about the handle's axis; accumulated, so 720 is two turns
 * @param req.grab goal / angles only: a joint name or "tip" (default: the goal's `at`, an angles limb's tip)
 * @param req.params starting param overrides (merged over the part's defaults)
 * @param req.view the view the drag happens in (default the part's first); it must show the handle
 * @param req.steps frames from start to target (default 12; a rotary drag takes one per 30° at least)
 * @returns `{ handle, drag, grab, from, target, reached, missMm, values }` or `{ handle, error }`
 */
export function dragHandle(part, { handle: id, to, turn, grab, params = {}, view, steps = 12 } = {}) {
  const fail = (error) => ({ handle: id, error });
  try {
    return play(part, { id, to, turn, grab, params, view, steps }, fail);
  } catch (e) {
    return fail(`drag failed: ${firstLine(e)}`);
  }
}

function play(part, { id, to, turn, grab, params, view, steps }, fail) {
  const handles = isObj(part?.handles) ? part.handles : null;
  if (typeof id !== "string" || !id) return fail("dragHandle needs { handle: <id> }");
  if (!handles) return fail("the part declares no handles");
  const handle = handles[id];
  if (!isObj(handle)) {
    const ids = Object.keys(handles).filter((k) => isObj(handles[k]));
    return fail(`unknown handle "${id}"; the part declares: ${ids.join(", ") || "none"}`);
  }
  if (!isObj(params)) return fail("params must be an object of param overrides");
  if (!Number.isInteger(steps) || steps < 1) return fail("steps must be a whole number >= 1");
  const views = isObj(part.views) ? Object.keys(part.views) : [];
  const v = view ?? views[0];
  if (!views.includes(v)) return fail(`unknown view "${v}"; the part's views: ${views.join(", ") || "none"}`);
  const base = { ...part.defaults, ...params };
  let shown;
  try { shown = handlesShownInView(part, v, base); } catch { shown = [id]; }
  if (!shown.includes(id)) {
    return fail(`view "${v}" does not show handle "${id}" (it shows: ${shown.join(", ") || "none"}); pass view`);
  }
  let start;
  try { start = resolveParams(part, base); } catch (e) { return fail(`derive throws at the starting params: ${firstLine(e)}`); }
  const kind = handleKind(handle, start.d);
  if (kind == null) return fail(`handle "${id}" needs exactly one of on, point`);
  const allHandles = Object.values(handles);
  const drag = kind === "limb" ? handle.drag : handle.drag ?? "point";

  // ---- the start point, the grab and the per-frame targets --------------------------
  let from, grabName, frameTarget, target, missOf, rotary = null;
  if (kind === "limb") {
    if (to === undefined || !isVec(to)) return fail(`a ${drag} drag needs to: [x, y, z]`);
    if (turn !== undefined) return fail(`a ${drag} drag takes to, not turn`);
    const info = limbInfo(part, base, handle);
    if (!info) return fail(`derive().${handle.on} is not a posed limb at the starting params`);
    const own = drag === "goal" ? (typeof handle.at === "string" ? handle.at : "tip") : "tip";
    grabName = grab ?? own;
    const grabs = drag === "goal"
      ? [own, ...goalGrabJoints(info, handle).filter((n) => n !== own)]
      : ["tip", ...info.joints.map((j) => j.name)];
    if (typeof grabName !== "string" || !grabs.includes(grabName)) {
      return fail(`handle "${id}" cannot be grabbed by "${grabName}"; grab one of: ${grabs.join(", ")}`);
    }
    from = info.points?.[grabName];
    if (!isVec(from)) return fail(`handle "${id}": no readable point at "${grabName}"`);
    target = [...to];
    frameTarget = (t) => lerp(from, target, t);
    missOf = (p) => Math.hypot(...sub(p, target));
  } else {
    if (grab !== undefined) return fail(`grab is for goal / angles handles; "${id}" is a ${drag} handle`);
    grabName = handleAt(handle);
    try { from = locateHandle(part, start.p, start.d, handle); } catch (e) { return fail(`handle "${id}": ${firstLine(e)}`); }
    let axis = null;
    if (drag === "axis" || drag === "plane" || drag === "rotary") {
      try { axis = handleAxis(handle, start.p, start.d); } catch { axis = null; }
      const dir = axis && unit(axis.direction);
      if (!dir) return fail(`handle "${id}": no readable ${drag === "plane" ? "normal" : "axis"}`);
      axis = { origin: axis.origin, direction: dir };
    }
    if (drag === "rotary") {
      if (!isNum(turn)) return fail(`a rotary drag needs turn: <degrees> (right-handed about its axis)`);
      if (to !== undefined) return fail("a rotary drag takes turn, not to");
      const a0 = angleAbout(from, axis);
      const rel = sub(from, axis.origin);
      const r = Math.hypot(...sub(rel, scale(axis.direction, dot(rel, axis.direction))));
      const radius = r > 1e-9 ? r : 1;
      target = rotateAbout(from, axis, turn);
      // The solve's angle residual is wrapped (-180..180), so a frame asking for more
      // than half a turn past where the point is would go the short way round. The grab
      // point's UNWRAPPED angle since the start is tracked frame by frame (`spun`), and
      // each frame asks for at most ROTARY_LEAD_DEG past it: a point held by its param's
      // range stays held, never pulled back, and the miss is the turn left undone.
      rotary = { a0, spun: 0, axis };
      frameTarget = (t) => {
        const want = turn * t - rotary.spun;
        const lead = Math.max(-ROTARY_LEAD_DEG, Math.min(ROTARY_LEAD_DEG, want));
        return { angleDeg: a0 + rotary.spun + lead, axis, radius };
      };
      missOf = () => (radius * Math.abs(turn - rotary.spun) * Math.PI) / 180;
    } else {
      if (to === undefined || !isVec(to)) return fail(`a ${drag} drag needs to: [x, y, z]`);
      if (turn !== undefined) return fail(`a ${drag} drag takes to, not turn`);
      const n = axis?.direction;
      if (drag === "axis") target = add(from, scale(n, dot(sub(to, from), n)));
      else if (drag === "plane") target = sub(to, scale(n, dot(sub(to, from), n)));
      else target = [...to];
      frameTarget = (t) => ({ point: lerp(from, target, t) });
      missOf = (p) => Math.hypot(...sub(p, target));
    }
  }

  // ---- play it: each frame solved warm from the last ---------------------------------
  // A rotary drag takes a frame per ROTARY_STEP_DEG at least, so each stays well inside
  // the solve's half-turn residual.
  const frames = rotary ? Math.max(steps, Math.ceil(Math.abs(turn) / ROTARY_STEP_DEG)) : steps;
  /** Add the point's turn since the last read to the unwrapped total (rotary only). */
  const spin = (p) => {
    if (!isVec(p)) return;
    rotary.spun += wrapTo180(angleAbout(p, rotary.axis) - (rotary.a0 + rotary.spun));
  };
  const current = { ...base };
  const touched = {};
  for (let i = 1; i <= frames; i++) {
    const result = defaultSolve({ part, params: current, handle, grab: grabName, target: frameTarget(i / frames), holds: [], allHandles });
    if (!result?.values) return fail(`the solve failed at frame ${i} of ${frames}: the handle's point could not be read there`);
    Object.assign(current, result.values);
    Object.assign(touched, result.values);
    if (rotary) {
      let p;
      try { const r = resolveParams(part, current); p = locateHandle(part, r.p, r.d, handle); } catch { p = null; }
      spin(p);
    }
  }

  // ---- release: snap, re-derive, read the grab point ---------------------------------
  const snapped = snapValues(part, touched);
  const final = { ...base, ...snapped };
  let reached;
  try {
    if (kind === "limb") reached = limbInfo(part, final, handle)?.points?.[grabName];
    else { const { p, d } = resolveParams(part, final); reached = locateHandle(part, p, d, handle); }
  } catch { reached = null; }
  if (!isVec(reached)) return fail(`handle "${id}": no readable point after the release`);
  if (rotary) spin(reached); // the snap may nudge it
  const values = {};
  for (const [k, val] of Object.entries(snapped)) if (!Object.is(val, base[k])) values[k] = val;
  return {
    handle: id, drag, grab: grabName,
    from: roundVec(from), target: roundVec(target), reached: roundVec(reached),
    missMm: round(missOf(reached)), values,
  };
}

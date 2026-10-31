// Pose mode's drag session: the state machine behind one handle drag, and the pin set.
// Pure — no DOM, no three.js. Everything effectful is injected, so mount.js decides
// what "write", "hold" and "ghost" mean and the tests drive it with recording fakes.
//
//   begin(handleId, grab)  snapshot params, hold(true), capture each pin's held point
//   frame(target)          solve (angles) or goal values (+ seed), write, ghost new stale
//   ringFrame(axis, deg)   goal handles with `aim`: tilt one aim param, then as frame
//   jointFrame(ring, slot, deg)  a joint ring: turn that one joint by deg from where the
//                          drag began (clamped to its range) — forward kinematics; a goal
//                          handle's goal follows the turned pose (param-solve's jointRingValues)
//   end()                  write the snapped values, hold(false), commit(changed) once
//   cancel()               restore(snapshot), hold(false), unghost what is current, no commit
//   externalWrite()        the same as cancel — something else wrote params mid-drag
//   delivered(name)        a ghosted sub-part's new mesh landed: unghost it (mid-drag only
//                          when the drag has not made it stale again)
//
// One drag is one commit, so one host undo step. A ghost is lifted only when its
// sub-part is current (staleSubParts() no longer lists it) — at its delivery, or at
// end/cancel when the values it was built from are back — never while stale, which
// would show the old shape at full opacity until the release regen.
//
// Pins are ids "<handle>:<at>" (at: a joint name or "tip"). A pin's held point is read
// at begin, from the params the drag starts from, and stays fixed for that drag.
import { limbInfo, solveAngles, goalValues, seedValues, snapValues, jointRingValues, posedJointValue } from "./param-solve.js";

const AIM_AXES = ["pitch", "yaw", "roll"];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Split a pin id at its LAST ":" — a handle id may itself hold one, a joint name rarely. */
export function parsePinId(id) {
  const s = String(id);
  const i = s.lastIndexOf(":");
  return i <= 0 ? null : { handleId: s.slice(0, i), at: s.slice(i + 1) };
}
export const pinId = (handleId, at) => `${handleId}:${at}`;

/**
 * The drag's values for one frame, from param-solve. Angles mode solves the handle's
 * listed params through derive (holding every pin); goal mode writes the target (and
 * the aim angles, for a ring) onto the goal params and the solved joint angles into
 * the seed. Returns `{ values, error }` or null when the start pose itself fails.
 */
export function defaultSolve({ part, params, handle, grab, target, aimAngles, holds, allHandles }) {
  if (handle.mode === "goal") {
    const values = goalValues({ handle, point: target, aimAngles, part });
    const seed = Array.isArray(handle.seed) && handle.seed.length
      ? seedValues({ part, params: { ...params, ...values }, handle })
      : null;
    return { values: { ...values, ...(seed ?? {}) }, error: 0 };
  }
  return solveAngles({ part, params, handle, grab, target, holds, allHandles });
}

/** Where a pinned point sits at these params (part coordinates), or null. */
function defaultLocate({ part, params, handle, at }) {
  const p = limbInfo(part, params, handle)?.points?.[at];
  return Array.isArray(p) ? [...p] : null;
}

export function createPoseSession({
  part,
  getParams,
  write,
  commit,
  restore,
  solve = defaultSolve,
  locate = defaultLocate,
  snap = (values) => snapValues(part, values),
  staleSubParts = () => [],
  ghost = () => {},
  unghost = () => {},
  hold = () => {},
  onCancel = () => {},
  onPinsChange = () => {},
}) {
  const handles = part?.handles && typeof part.handles === "object" ? part.handles : {};
  const allHandles = Object.values(handles);
  let pins = [];
  let drag = null;          // { handleId, handle, grab, snapshot, holds, touched }
  const ghosted = new Set(); // ghosted by any drag, waiting for their delivery

  const notifyPins = () => onPinsChange([...pins]);

  function begin(handleId, grab) {
    if (drag) cancel();
    const handle = handles[handleId];
    if (!handle) return false;
    const params = getParams();
    const snapshot = { ...params };
    const holds = [];
    for (const id of pins) {
      const pin = parsePinId(id);
      const h = pin && handles[pin.handleId];
      if (!h || (pin.handleId === handleId && pin.at === grab)) continue;
      const point = locate({ part, params: snapshot, handle: h, at: pin.at });
      if (point) holds.push({ limb: h.limb, at: pin.at, point });
    }
    drag = { handleId, handle, grab, snapshot, holds, touched: {} };
    hold(true);
    return true;
  }

  /** Write one frame's values and ghost whatever just went stale. */
  function apply(result) {
    if (!result || !result.values) return null;
    write(result.values);
    Object.assign(drag.touched, result.values);
    const fresh = [];
    for (const name of staleSubParts() ?? []) {
      if (ghosted.has(name)) continue;
      ghosted.add(name);
      fresh.push(name);
    }
    if (fresh.length) ghost(fresh);
    return result;
  }

  function frame(target) {
    if (!drag) return null;
    const point = Array.isArray(target) ? target : target?.point;
    if (!Array.isArray(point) || !point.every(isNum)) return null;
    const result = solve({
      part, params: { ...getParams() }, handleId: drag.handleId, handle: drag.handle,
      grab: drag.grab, target: point, holds: drag.holds, allHandles,
    });
    return apply(result);
  }

  function ringFrame(axis, deltaDeg) {
    if (!drag || drag.handle.mode !== "goal" || !isNum(deltaDeg)) return null;
    const aim = drag.handle.params?.aim;
    const i = typeof axis === "number" ? axis : AIM_AXES.indexOf(axis);
    if (!Array.isArray(aim) || !(i >= 0) || typeof aim[i] !== "string") return null;
    const params = { ...getParams() };
    const value = (k) => (isNum(drag.snapshot[k]) ? drag.snapshot[k] : isNum(part.defaults?.[k]) ? part.defaults[k] : 0);
    // Every aim angle as the grab left it, the dragged one turned by the delta since.
    const angles = aim.map((k, j) => (isNum(params[k]) ? params[k] : value(k)));
    angles[i] = value(aim[i]) + deltaDeg;
    const values = goalValues({ handle: drag.handle, point: null, aimAngles: angles, part });
    const seed = Array.isArray(drag.handle.seed) && drag.handle.seed.length
      ? seedValues({ part, params: { ...params, ...values }, handle: drag.handle })
      : null;
    return apply({ values: { ...values, ...(seed ?? {}) }, error: 0 });
  }

  /**
   * A joint ring's frame: `ring` is one of param-solve's jointRings entries, `slot` its ring
   * name, `deltaDeg` the turn since the press. The joint goes to its value at begin plus the
   * turn, clamped to the slot's range; the result's `clamped` says whether the clamp bit.
   * Pins are not held: a ring turns one joint and nothing else.
   */
  function jointFrame(ring, slot, deltaDeg) {
    if (!drag || !ring?.slots?.[slot] || !isNum(deltaDeg)) return null;
    const s = ring.slots[slot];
    if (drag.jointStart === undefined) {
      drag.jointStart = posedJointValue(part, drag.snapshot, ring.limb, ring.joint, s.component);
    }
    if (!isNum(drag.jointStart)) return null;
    const want = drag.jointStart + deltaDeg;
    const value = Math.min(s.range[1], Math.max(s.range[0], want));
    const result = jointRingValues({ part, params: { ...getParams() }, ring, slot, value });
    if (!result) return null;
    return apply({ values: result.values, error: 0, clamped: value !== want || result.clamped });
  }

  function end() {
    if (!drag) return;
    const ending = drag;
    drag = null;
    const snapped = snap({ ...ending.touched });
    if (Object.keys(snapped).length) write(snapped);
    // A ghost whose sub-part is current again at the released values (a drag back to
    // its start, a cache hit, or a delivery that landed during this drag) gets no
    // delivery to lift it: lift it now. Current means its mesh already shows these
    // params, so nothing stale appears at full opacity.
    reconcile();
    hold(false);
    const changed = Object.keys(snapped).filter((k) => snapped[k] !== ending.snapshot[k]);
    if (changed.length) commit(changed);
  }

  function cancel() {
    if (!drag) return;
    const ending = drag;
    drag = null;
    restore({ ...ending.snapshot });
    hold(false);
    // Only the ghosts the restore made current again: one still waiting on an earlier
    // drag's release regen would flash its stale mesh at full opacity.
    reconcile();
    onCancel();
  }

  /** Unghost every ghosted name staleSubParts() no longer lists. */
  function reconcile() {
    if (!ghosted.size) return;
    const stale = new Set(staleSubParts() ?? []);
    const names = [...ghosted].filter((n) => !stale.has(n));
    if (!names.length) return;
    for (const n of names) ghosted.delete(n);
    unghost(names);
  }

  function delivered(name) {
    if (!ghosted.has(name)) return;
    // Mid-drag a delivery only lifts a ghost the drag has not made stale again (an
    // earlier drag's regen landing during this one); otherwise it waits for the release.
    if (drag && (staleSubParts() ?? []).includes(name)) return;
    ghosted.delete(name);
    unghost([name]);
  }

  function togglePin(id) {
    const key = String(id);
    const had = pins.includes(key);
    pins = had ? pins.filter((p) => p !== key) : [...pins, key];
    notifyPins();
    return !had;
  }

  function setPins(ids) {
    pins = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
    notifyPins();
  }

  function releasePins() {
    if (!pins.length) return;
    pins = [];
    notifyPins();
  }

  return {
    begin,
    frame,
    ringFrame,
    jointFrame,
    end,
    cancel,
    externalWrite: cancel,
    delivered,
    togglePin,
    setPins,
    releasePins,
    isActive: () => drag !== null,
    /** The drag in progress, or null: `{ handleId, grab }`. */
    get active() { return drag ? { handleId: drag.handleId, grab: drag.grab } : null; },
    get pins() { return [...pins]; },
    /** Sub-parts ghosted by a drag and not yet delivered. */
    get ghosted() { return [...ghosted]; },
  };
}

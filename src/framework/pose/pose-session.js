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
//   end()                  write the snapped values, hold(false), commit(changed) once;
//                          returns { handleId, changed, moved, held, blocked } (null with no drag):
//                          moved — some frame wrote a value that, snapped, left the start;
//                          held — a pin held the drag still: it wrote nothing, and the
//                          last target solved WITHOUT the pins would have moved a value
//                          (a pin on an unrelated point, or a range end, holds nothing);
//                          blocked — the pair `{ a, b }` the last frame stopped at, or null
//   cancel()               restore(snapshot), hold(false), unghost what is current, no commit
//   externalWrite()        the same as cancel — something else wrote params mid-drag
//   delivered(name)        a ghosted sub-part's new mesh landed: unghost it (mid-drag only
//                          when the drag has not made it stale again)
//
// COLLISIONS (spec "Pose mode: collision in the solver"). `collide({ handle, snapshot })`
// is called once at begin and returns a drag guard (collide/guard.js) or null (the part
// declares no collisions, or nothing is indexed yet). With one, every frame — IK, ring
// and joint ring alike — goes through it before anything is written:
//   - guard.settle(lastClear, end, { blend, pinDrift }) walks from the last clear
//     params (the snapshot at first) toward the solve's answer, stops at contact and slides
//     the rest of the move along it; its params are what `write` gets, and they become the
//     next frame's lastClear. While pins are set, `pinDrift` lets settle undo a slide that
//     moves a pinned point (the slide works outside the solver, where pins are not held).
//   - the stop's contact normals are kept (drag.normals), and a limb drag's next target
//     is slid along them before it is solved (tangentTarget), so the solve aims along the
//     surface rather than into it. A normal is dropped once the pointer pulls away from it. `blend` is read
//     straight off the solve's result: it is NON-enumerable (param-solve's withBlend), so a
//     spread or copy of the result silently drops it, and settle would then walk a linear
//     blend — wrong for a goal drag, whose path is the joint-space one. Never copy a result
//     before this point.
//   - `blockedChange(pair | null)` fires when the pair a frame stopped at changes (mount
//     tints it), and with null when the drag ends or is cancelled.
//   - a settle that throws holds that frame at lastClear (writes nothing new; lastClear
//     stays) and keeps the guard: later frames try it again, and the first throw of a drag
//     is logged, the rest are not. A frame the guard could not check is never written, and
//     a drag is never left unguarded by one bad frame.
//   - end()'s snap is checked too: the nearest snap can round a value toward contact, so if
//     the snapped pose is not clear (guard.isClear over lastClear) each touched key snaps
//     toward its value at the drag's start instead, and if that is not clear either the
//     last clear values are written unsnapped. `changed` and the commit follow what was written.
// The guard's `release()`, if it has one, is called once the drag is over.
//
// One drag is one commit, so one host undo step. A ghost is lifted only when its
// sub-part is current (staleSubParts() no longer lists it) — at its delivery, or at
// end/cancel when the values it was built from are back — never while stale, which
// would show the old shape at full opacity until the release regen.
//
// Pins are ids "<handle>:<at>" (at: a joint name or "tip"; "<limb>.<joint>" for a joint of
// another limb the handle's `joints` map names, the hand's palm wrist). A pin's held point
// is read at begin, from the params the drag starts from, and stays fixed for that drag.
// On a generic handle (`on` / `point`) the id is "<handle>:<at>" or "<handle>:point", and the
// pin holds that handle's point still, on every handle kind: a generic handle's drag goes
// through solveHandle with every pin as a hold. The pinned handle's own pin is skipped.
// Every IK drag holds them: angles mode through solveAngles (any limb), goal mode through
// solveGoalPinned (the goal handle's own limb) once a pin is on that limb. Joint rings and
// a goal drag with no pin on its limb do not.
import { limbInfo, solveAngles, solveGoalPinned, solveHandle, goalValues, seedValues, snapValues, snapValuesToward, linearBlend, withBlend, jointRingValues, posedJointValue, parseJointKey } from "./param-solve.js";
import { handleKind, handleAt, locateHandle } from "./handle-source.js";
import { resolveParams } from "../part-model.js";

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
 * Where a pin id points: `{ handleId, handle, limb (derive's key), at }`, or null when its
 * handle is gone. An `at` of "<limb>.<joint>" names a joint on another limb (a key of
 * derive's result) — the form a joint of a limb only a `joints` entry shows takes.
 */
export function pinTarget(id, handles) {
  const pin = parsePinId(id);
  const handle = pin && handles?.[pin.handleId];
  if (!handle) return null;
  // a generic handle's point is read through locateHandle, keyed by handle (no limb)
  if (handleKind(handle) === "on" || handleKind(handle) === "point") {
    return { handleId: pin.handleId, handle, ref: { handleId: pin.handleId, handle } };
  }
  const { limb, joint } = parseJointKey(pin.at);
  return { handleId: pin.handleId, handle, limb: limb ?? handle.on, at: joint };
}

/**
 * The drag's values for one frame, from param-solve. Angles mode solves the handle's
 * listed params through derive (holding every pin); goal mode writes the target (and
 * the aim angles, for a ring) onto the goal params and the solved joint angles into
 * the seed. Returns `{ values, error }` (with a non-enumerable `blend`, withBlend) or null
 * when the start pose itself fails; `blend(t)` is the path the drag guard's settle walks
 * from `params` to the result.
 *
 * `collide` (a drag guard, or null) adds its collision rows to the solve. A goal drag
 * with one starts the guard's frame first: in open air (no row active: no pair's gap
 * inside the guard's margin, whatever the travel slack pulled into its window) it writes
 * the goal directly, as without one, so a goal can still be dragged out of reach; near an
 * obstacle it solves the seeded joints instead (solveGoalPinned, holding the current aim
 * unless a ring gives one), so the arm slides along it, and writes that pose back as goal
 * params. A solve that cannot read the limb falls back to the direct write.
 */
export function defaultSolve({ part, params, handle, grab, target, aimAngles, holds = [], allHandles }) {
  const kind = handleKind(handle);
  if (kind === "on" || kind === "point") return solveHandle({ part, params, handle, target, holds, allHandles });
  if (handle.drag === "goal") {
    // grabbed by a middle joint: the seeded joints carry that joint to the target and the
    // tool rides along. A failed solve holds still — never the goal write below, which would put
    // the tool on the cursor.
    if (typeof grab === "string" && grab !== (typeof handle.at === "string" ? handle.at : "tip")) {
      return solveGoalPinned({ part, params, handle, target, holds, grab });
    }
    if (holds.some((h) => h.limb === handle.on)) {
      // a pin on the goal's own limb: solve the seeded joints around it (solveGoalPinned)
      const pinned = solveGoalPinned({ part, params, handle, target, holds });
      if (pinned) return pinned;
    }
    const values = goalValues({ handle, point: target, aimAngles, part });
    const seed = Array.isArray(handle.seed) && handle.seed.length
      ? seedValues({ part, params: { ...params, ...values }, handle })
      : null;
    const written = { ...values, ...(seed ?? {}) };
    return withBlend({ values: written, error: 0 }, linearBlend({ ...part.defaults, ...params }, written));
  }
  return solveAngles({ part, params, handle, grab, target, holds, allHandles });
}

/** Where a pinned point sits at these params (part coordinates), or null. */
function defaultLocate({ part, params, handle, at }) {
  const kind = handleKind(handle);
  if (kind === "on" || kind === "point") {
    try {
      const { p, d } = resolveParams(part, { ...part.defaults, ...params });
      return locateHandle(part, p, d, handle);
    } catch { return null; }
  }
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
  // the release snap toward the drag's start, when the nearest snap is not clear (collisions)
  snapToward = (values, toward) => snapValuesToward(part, values, toward),
  staleSubParts = () => [],
  ghost = () => {},
  unghost = () => {},
  hold = () => {},
  onCancel = () => {},
  onPinsChange = () => {},
  // Whether a pin acts right now: pose mode passes "its point is badged in this view", so a
  // pin on a handle the view does not show never holds anything unseen.
  pinActive = () => true,
  // The drag guard factory (see COLLISIONS above): ({ handle, handleId, snapshot }) → guard | null.
  collide = () => null,
  blockedChange = () => {},
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
    const generic = handleKind(handle) === "on" || handleKind(handle) === "point";
    if (generic) grab = handleAt(handle);
    const holds = [];
    for (const id of pins) {
      const pin = pinTarget(id, handles);
      if (!pin || !pinActive(id)) continue;
      if (pin.ref) {
        if (pin.handleId === handleId) continue;
        const point = locate({ part, params: snapshot, handle: pin.handle, at: handleAt(pin.handle) });
        if (point) holds.push({ ref: pin.ref, point, where: { handle: pin.handle, at: handleAt(pin.handle) } });
        continue;
      }
      if (pin.handleId === handleId && pin.limb === handle.on && pin.at === grab) continue;
      const point = locate({ part, params: snapshot, handle: { ...pin.handle, on: pin.limb }, at: pin.at });
      if (point) holds.push({ limb: pin.limb, at: pin.at, point, where: { handle: { ...pin.handle, on: pin.limb }, at: pin.at } });
    }
    let guard = null;
    try { guard = collide({ handle, handleId, snapshot }) ?? null; } catch (err) { console.error("pose collisions: no guard for this drag", err); }
    const lastClear = { ...part?.defaults, ...snapshot };
    drag = { handleId, handle, grab, snapshot, holds, touched: {}, moved: false, guard, lastClear, blocked: null, settleLogged: false };
    hold(true);
    return true;
  }

  /**
   * The values a frame writes: the solve's own, or — with a guard — settle's, from the last
   * clear params toward the solve's answer, stopped at contact. Keys: the solve's, plus any
   * settle's path moved (a goal drag's joint-space blend sets its seeds and goal together).
   */
  function settled(result) {
    const guard = drag.guard;
    if (!guard) return result.values;
    const blend = result.blend; // straight off the result: non-enumerable (see COLLISIONS)
    const from = drag.lastClear;
    let s;
    try {
      const end = typeof blend === "function" ? blend(1) : { ...from, ...result.values };
      // The slide works outside the solver, where a pin is not held (a goal param alone
      // re-solves the whole arm): with pins, settle undoes a slide that moves one (pinDrift)
      // and stops at contact instead. The stop still reports the contact normals, and
      // tangentTarget slides the next solve's target along them, where pins are held.
      s = guard.settle(from, end, {
        ...(typeof blend === "function" ? { blend } : {}),
        ...(drag.holds.length ? { pinDrift } : {}),
      });
    } catch (err) {
      // a pose the guard cannot place: hold this frame at the last clear values, keep the
      // guard (the next frame tries again), and log the drag's first such throw only
      if (!drag.settleLogged) {
        drag.settleLogged = true;
        console.error("pose collisions: settle failed; holding this frame at the last clear pose", err);
      }
      return {};
    }
    const values = {};
    for (const k of Object.keys(result.values)) values[k] = s.params[k];
    for (const k of Object.keys(s.params)) if (!(k in values) && !Object.is(s.params[k], from[k])) values[k] = s.params[k];
    drag.lastClear = { ...s.params };
    if (s.contacts?.length) drag.normals = s.contacts.map((c) => c.normal);
    const blocked = s.blocked ? { a: s.blocked.a, b: s.blocked.b } : null;
    const was = drag.blocked;
    drag.blocked = blocked;
    if ((was?.a ?? null) !== (blocked?.a ?? null) || (was?.b ?? null) !== (blocked?.b ?? null)) blockedChange(blocked);
    return values;
  }

  /** Write one frame's values and ghost whatever just went stale. */
  function apply(result) {
    if (!result || !result.values) return null;
    const values = settled(result);
    if (Object.keys(values).length) write(values);
    Object.assign(drag.touched, values);
    if (!drag.moved) {
      const snapped = snap({ ...values });
      drag.moved = Object.keys(snapped).some((k) => !Object.is(snapped[k], drag.snapshot[k]));
    }
    const fresh = [];
    for (const name of staleSubParts() ?? []) {
      if (ghosted.has(name)) continue;
      ghosted.add(name);
      fresh.push(name);
    }
    if (fresh.length) ghost(fresh);
    return values === result.values ? result : withBlend({ ...result, values }, result.blend);
  }

  /** The drag's guard is done with: let it go, and clear the blocked tint. */
  function releaseGuard(ending) {
    if (ending.blocked) blockedChange(null);
    try { ending.guard?.release?.(); } catch { /* the owner's problem */ }
  }

  /** How far, at most, the drag's pinned points sit from where they were pinned (mm). */
  function pinDrift(params) {
    let worst = 0;
    for (const h of drag.holds) {
      const p = h.where && locate({ part, params, handle: h.where.handle, at: h.where.at });
      if (!p) return Infinity;
      worst = Math.max(worst, Math.hypot(p[0] - h.point[0], p[1] - h.point[1], p[2] - h.point[2]));
    }
    return worst;
  }

  /**
   * The drag target slid along the surfaces the piece last stopped at (COLLISIONS): the
   * grab point's move toward `point` less its part into any contact's normal, so the solve
   * aims along the surface instead of into it, and the piece follows the pointer around it.
   * A normal is dropped once the pointer pulls away from it; the next contact brings a fresh
   * one. Pose mode's target is a point on its drag plane, so this keeps the pointer's
   * sideways travel and drops only the push.
   */
  function tangentTarget(params, point) {
    if (!drag.normals?.length) return point;
    const at = locate({ part, params, handle: drag.handle, at: drag.grab });
    if (!at) return point;
    const d = [point[0] - at[0], point[1] - at[1], point[2] - at[2]];
    const dot = (n) => n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    drag.normals = drag.normals.filter((n) => dot(n) <= 0);
    for (let pass = 0; pass < 3; pass++) {
      for (const n of drag.normals) {
        const k = dot(n);
        if (k < 0) for (let i = 0; i < 3; i++) d[i] -= k * n[i];
      }
    }
    return [at[0] + d[0], at[1] + d[1], at[2] + d[2]];
  }

  function frame(target) {
    if (!drag) return null;
    const kind = handleKind(drag.handle);
    if (kind === "on" || kind === "point") {
      // generic: the target goes to solveHandle as is (a point, or a rotary angle target)
      const t = Array.isArray(target) ? { point: target } : target;
      const ok = Array.isArray(t?.point) ? t.point.length === 3 && t.point.every(isNum)
        : isNum(t?.angleDeg) && t.axis && Array.isArray(t.axis.origin) && Array.isArray(t.axis.direction);
      if (!ok) return null;
      drag.lastTarget = t;
      return apply(solve({
        part, params: { ...getParams() }, handleId: drag.handleId, handle: drag.handle,
        grab: drag.grab, target: t, holds: drag.holds, allHandles,
      }));
    }
    const point = Array.isArray(target) ? target : target?.point;
    if (!Array.isArray(point) || !point.every(isNum)) return null;
    const params = { ...getParams() };
    const result = solve({
      part, params, handleId: drag.handleId, handle: drag.handle,
      grab: drag.grab, target: tangentTarget(params, point), holds: drag.holds, allHandles,
    });
    return apply(result);
  }

  function ringFrame(axis, deltaDeg) {
    if (!drag || drag.handle.drag !== "goal" || !isNum(deltaDeg)) return null;
    const aim = drag.handle.params?.aim;
    const i = typeof axis === "number" ? axis : AIM_AXES.indexOf(axis);
    if (!Array.isArray(aim) || !(i >= 0) || typeof aim[i] !== "string") return null;
    const params = { ...getParams() };
    const value = (k) => (isNum(drag.snapshot[k]) ? drag.snapshot[k] : isNum(part.defaults?.[k]) ? part.defaults[k] : 0);
    // Every aim angle as the grab left it, the dragged one turned by the delta since.
    const angles = aim.map((k) => value(k));
    angles[i] = value(aim[i]) + deltaDeg;
    // A pin on the goal's limb: hold it, pulling the aim toward these angles while the goal
    // point stays where the drag began (solveGoalPinned); a pin can stop the aim short.
    if (drag.holds.some((h) => h.limb === drag.handle.on)) {
      const position = drag.handle.params?.position ?? [];
      const point = position.map((k) => value(k));
      if (position.length === 3) {
        const pinned = solveGoalPinned({ part, params, handle: drag.handle, target: point, holds: drag.holds, aimAngles: angles });
        if (pinned) return apply(pinned);
      }
    }
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
    if (!drag) return null;
    const ending = drag;
    drag = null;
    const snapped = releaseValues(ending);
    if (Object.keys(snapped).length) write(snapped);
    // A ghost whose sub-part is current again at the released values (a drag back to
    // its start, a cache hit, or a delivery that landed during this drag) gets no
    // delivery to lift it: lift it now. Current means its mesh already shows these
    // params, so nothing stale appears at full opacity.
    reconcile();
    hold(false);
    releaseGuard(ending);
    const changed = Object.keys(snapped).filter((k) => snapped[k] !== ending.snapshot[k]);
    if (changed.length) commit(changed);
    return { handleId: ending.handleId, changed, moved: ending.moved, held: !changed.length && !ending.moved && pinBound(ending), blocked: ending.blocked };
  }

  /**
   * The values end() writes: the touched values snapped — checked against the drag's guard,
   * if it has one: nearest, else toward the start, else the last clear values unsnapped.
   */
  function releaseValues(ending) {
    const touched = { ...ending.touched };
    const nearest = snap({ ...touched });
    const guard = ending.guard;
    if (!guard || !Object.keys(touched).length) return nearest;
    const clear = (vals) => { try { return guard.isClear({ ...ending.lastClear, ...vals }); } catch { return false; } };
    if (clear(nearest)) return nearest;
    const toward = snapToward({ ...touched }, ending.snapshot);
    if (clear(toward)) return toward;
    return Object.fromEntries(Object.keys(touched).map((k) => [k, ending.lastClear[k]]));
  }

  /**
   * Whether a pin bound the (generic) drag: its last target, solved from the start with no
   * holds, moves a value off the start once snapped. One extra solve, at release only.
   */
  function pinBound(ending) {
    if (!ending.holds.length || !ending.lastTarget) return false;
    let r = null;
    try {
      r = solve({
        part, params: { ...ending.snapshot }, handleId: ending.handleId, handle: ending.handle,
        grab: ending.grab, target: ending.lastTarget, holds: [], allHandles,
      });
    } catch { return false; }
    if (!r?.values) return false;
    const free = snap({ ...r.values });
    return Object.keys(free).some((k) => !Object.is(free[k], ending.snapshot[k]));
  }

  function cancel() {
    if (!drag) return;
    const ending = drag;
    drag = null;
    restore({ ...ending.snapshot });
    hold(false);
    releaseGuard(ending);
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

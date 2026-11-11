// How the pointer moves a generic handle: one function per drag kind turns a pointer ray
// (part coordinates) and a screen position into the target `solveHandle` takes. Pure: no
// DOM, no three.js. `point` is the plane rule pose mode already uses for a limb dot;
// `axis` slides on a line, `plane` on a plane, `rotary` turns about an axis.
import { angleAbout, wrapTo180 } from "../solve/axis-angle.js";
import { dragPlanePoint, dragPlaneNormal } from "./pose-geom.js";

const NEAR_VIEW = Math.cos((18 * Math.PI) / 180); // an axis this close to the view direction is end-on
const EDGE_ON = Math.sin((18 * Math.PI) / 180); // a plane this close to the view direction's line is edge-on
const CENTRE_PX = 4; // a rotary read this close to the axis centre on screen is unstable
const AMBIGUOUS_DEG = 150; // a single read step this large is a pass over the axis centre, not a turn: hold and rebase
const FAR = 1e5; // default cap on how far a hit may run out, mm
const STEP_MM = 10; // the length projected to read a pixels-per-mm scale

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/** Begin a drag of `kind` ("point" | "axis" | "plane" | "rotary") grabbed at `point`. */
export function startDrag(kind, { point, axis, ray, screen, maxDist = FAR }) {
  const state = { kind, point: [...point], maxDist };
  if (kind === "point") {
    state.normal = dragPlaneNormal(ray.forward, [0, 0, 0]);
    state.offset = sub(point, dragPlanePoint(ray.origin, ray.dir, point, state.normal, maxDist));
  } else if (kind === "axis") {
    const a = unit(axis.direction);
    state.dir = a;
    state.origin = [...axis.origin];
    state.screenMode = Math.abs(dot(a, unit(ray.forward))) > NEAR_VIEW;
    if (state.screenMode) {
      const s0 = screen?.project ? screen.project(point) : null;
      const s1 = screen?.project ? screen.project(add(point, scale(a, STEP_MM))) : null;
      state.s0 = s0;
      state.e = s0 && s1 ? [s1.x - s0.x, s1.y - s0.y] : null;
    }
    state.t0 = axisParam(state, ray, screen);
  } else if (kind === "plane") {
    const n = unit(axis.direction);
    state.normal = n;
    state.edgeOn = Math.abs(dot(n, unit(ray.forward))) < EDGE_ON;
    if (state.edgeOn) {
      state.fallback = dragPlaneNormal(ray.forward, [0, 0, 0]);
      state.offset = sub(point, dragPlanePoint(ray.origin, ray.dir, point, state.fallback, maxDist));
    } else {
      state.hit0 = dragPlanePoint(ray.origin, ray.dir, point, n, maxDist);
    }
  } else if (kind === "rotary") {
    const a = unit(axis.direction);
    state.axis = { origin: [...axis.origin], direction: a };
    state.angleDeg = angleAbout(point, state.axis);
    const rel = sub(point, axis.origin);
    // The pointer is read on the plane the grabbed point turns in: square to the axis,
    // through the point — not through the axis origin, which may sit far along the axis
    // (a crank knob above its gear's plane), where the cursor's hit would not track the
    // handle on screen. `centre` is where the axis pierces that plane.
    state.centre = add(axis.origin, scale(a, dot(rel, a)));
    const radius = len(sub(rel, scale(a, dot(rel, a))));
    state.radius = radius > 1e-9 ? radius : 1;
    state.last = rotaryRead(state, ray, screen);
  } else {
    throw new Error(`startDrag: unknown drag kind "${kind}"`);
  }
  return state;
}

/** The solver target for the pointer now. Mutates `state` (rotary accumulates). */
export function dragTarget(state, { ray, screen }) {
  switch (state.kind) {
    case "point": {
      const p = dragPlanePoint(ray.origin, ray.dir, sub(state.point, state.offset), state.normal, state.maxDist);
      return { point: add(p, state.offset) };
    }
    case "axis": {
      const t = axisParam(state, ray, screen);
      const dt = Number.isFinite(t) && Number.isFinite(state.t0) ? t - state.t0 : 0;
      return { point: add(state.point, scale(state.dir, dt)) };
    }
    case "plane": {
      if (state.edgeOn) {
        const p = dragPlanePoint(ray.origin, ray.dir, sub(state.point, state.offset), state.fallback, state.maxDist);
        return { point: add(p, state.offset) };
      }
      const hit = dragPlanePoint(ray.origin, ray.dir, state.point, state.normal, state.maxDist);
      return { point: add(state.point, sub(hit, state.hit0)) };
    }
    default: {
      const r = rotaryRead(state, ray, screen);
      if (r && state.last && state.last.mode === r.mode) {
        const step = wrapTo180(r.value - state.last.value);
        if (Math.abs(step) <= AMBIGUOUS_DEG && !crossesCentre(state.last, r)) state.angleDeg += step;
      }
      state.last = r; // a held (null) read rebases the next one: no jump across the axis centre
      return { angleDeg: state.angleDeg, axis: state.axis, radius: state.radius };
    }
  }
}

// Position along the axis line the pointer asks for, in mm from state.origin; NaN when
// the screen fallback has nothing to read.
function axisParam(state, ray, screen) {
  const a = state.dir;
  if (state.screenMode) {
    const e = state.e;
    const ee = e ? e[0] * e[0] + e[1] * e[1] : 0;
    if (!(ee > 1e-9) || !screen) return NaN;
    return (((screen.x - state.s0.x) * e[0] + (screen.y - state.s0.y) * e[1]) / ee) * STEP_MM;
  }
  // closest point on the line to the ray
  const d = unit(ray.dir);
  const w = sub(state.origin, ray.origin);
  const b = dot(a, d);
  const den = 1 - b * b;
  if (!(den > 1e-12)) return NaN;
  return (b * dot(d, w) - dot(a, w)) / den;
}

// The pointer's angle about the axis: read on the grabbed point's rotation plane (square
// to the axis through the point), or by screen turn about the projected centre when the plane is edge-on or the hit is within CENTRE_PX of it.
// null when no stable reading exists (the caller holds).
function rotaryRead(state, ray, screen) {
  const { direction } = state.axis;
  const origin = state.centre;
  const fwd = unit(ray.forward);
  const facing = dot(direction, fwd);
  const centre = screen?.project ? screen.project(origin) : null;
  if (Math.abs(facing) >= EDGE_ON) {
    const hit = dragPlanePoint(ray.origin, ray.dir, origin, direction, state.maxDist);
    const h = screen?.project ? screen.project(hit) : null;
    if (Number.isFinite(hit[0]) && h && centre && Math.hypot(h.x - centre.x, h.y - centre.y) >= CENTRE_PX) {
      return { mode: "plane", value: angleAbout(hit, state.axis), pos: h, centre };
    }
    if (!centre) return null; // no projection to fall back on
  }
  if (!centre || !screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return null;
  const dx = screen.x - centre.x;
  const dy = screen.y - centre.y;
  if (Math.hypot(dx, dy) < CENTRE_PX) return null;
  // screen y is down: a turn counter-clockwise about an axis pointing away from the eye
  // reads as increasing atan2
  const sign = facing > 0 ? 1 : facing < 0 ? -1 : 1;
  return { mode: "screen", value: (sign * Math.atan2(dy, dx) * 180) / Math.PI, pos: { x: screen.x, y: screen.y }, centre };
}

// Did the pointer's straight path between two reads pass within CENTRE_PX of the axis
// centre? Then the step is a pass over the centre, however small its angle reads.
function crossesCentre(a, b) {
  const c = b.centre;
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.pos.x) * dx + (c.y - a.pos.y) * dy) / l2)) : 0;
  return Math.hypot(a.pos.x + dx * t - c.x, a.pos.y + dy * t - c.y) < CENTRE_PX;
}

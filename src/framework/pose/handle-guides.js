// What Pose mode draws beside a generic handle (spec 2026-11-02 section 5, section 4
// item 1): the guide it moves on — a double arrow along an axis drag, a square on a
// plane drag, a ring about a rotary drag's axis — its path (the curve its point travels
// as a one-parameter handle's param sweeps its range), the drag readout's text, and the
// values the readout chip writes when it is edited (readoutKeys, chipValues). Every
// guide is `{ kind, points }` in PART coordinates; the screen-constant ones take the
// part mm per CSS px at the point. Pure: no DOM, no three.js, no node:.
import { resolveParams } from "../part-model.js";
import { locateHandle } from "./handle-source.js";
import { rangesOf, snapValues } from "./param-solve.js";
import { controlNodes } from "../panel/model.js";
import { desugar } from "../panel/legacy.js";

/** Points on a path preview: the param's range, ends included. */
export const PATH_SAMPLES = 32;
/** An axis guide's arrows reach this far (CSS px) each way from the point. */
export const AXIS_ARROW_PX = 12;
/** A plane guide's square, side in CSS px, centred on the point. */
export const PLANE_SQUARE_PX = 24;
/** Arrow heads on an axis guide: back along the shaft, and out to each side (CSS px). */
const HEAD_BACK_PX = 4;
const HEAD_SIDE_PX = 3;
/** Points round a rotary guide's ring. */
const RING_SAMPLES = 48;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : null; };

/** Two unit vectors square to unit `a` and to each other. */
function basis(a) {
  const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(sub(ref, scale(a, dot(ref, a))));
  return { u, v: cross(a, u) };
}

/**
 * An axis drag's double arrow: one polyline (it retraces itself at each head) from
 * AXIS_ARROW_PX behind the point to AXIS_ARROW_PX ahead along `direction`, with a head at
 * each end. `forward` (the camera's look, part coordinates) turns the heads to face it.
 */
export function axisGuide(point, direction, mmPerPx, forward = null) {
  const d = unit(direction ?? [0, 0, 0]);
  if (!isVec(point) || !d || !(mmPerPx > 0)) return null;
  const reach = AXIS_ARROW_PX * mmPerPx;
  const a = add(point, scale(d, -reach)), b = add(point, scale(d, reach));
  const f = isVec(forward) ? unit(cross(d, forward)) : null;
  const side = f ?? basis(d).u;
  const back = HEAD_BACK_PX * mmPerPx, out = HEAD_SIDE_PX * mmPerPx;
  const head = (tip, dir) => [add(add(tip, scale(dir, -back)), scale(side, out)), add(add(tip, scale(dir, -back)), scale(side, -out))];
  const [a1, a2] = head(a, scale(d, -1));
  const [b1, b2] = head(b, d);
  return { kind: "axis", points: [a1, a, a2, a, b, b1, b, b2] };
}

/** A plane drag's square: PLANE_SQUARE_PX a side, centred on the point, square to `normal`. Closed (the last corner joins the first). */
export function planeGuide(point, normal, mmPerPx) {
  const n = unit(normal ?? [0, 0, 0]);
  if (!isVec(point) || !n || !(mmPerPx > 0)) return null;
  const { u, v } = basis(n);
  const h = (PLANE_SQUARE_PX / 2) * mmPerPx;
  const corner = (su, sv) => add(point, add(scale(u, su * h), scale(v, sv * h)));
  return { kind: "plane", points: [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)] };
}

/**
 * A rotary drag's ring: the circle the point turns on about `axis` ({ origin, direction }),
 * through the point. A point on the axis has no circle: the ring is AXIS_ARROW_PX round it.
 * Closed.
 */
export function rotaryGuide(point, axis, mmPerPx) {
  const a = unit(axis?.direction ?? [0, 0, 0]);
  if (!isVec(point) || !a || !isVec(axis.origin) || !(mmPerPx > 0)) return null;
  const rel = sub(point, axis.origin);
  const centre = add(axis.origin, scale(a, dot(rel, a)));
  let radius = len(sub(point, centre));
  if (!(radius > 1e-9)) radius = AXIS_ARROW_PX * mmPerPx;
  const { u, v } = basis(a);
  const points = Array.from({ length: RING_SAMPLES }, (_, k) => {
    const t = (k / RING_SAMPLES) * Math.PI * 2;
    return add(centre, add(scale(u, radius * Math.cos(t)), scale(v, radius * Math.sin(t))));
  });
  return { kind: "rotary", points };
}

/** The one param a handle's path sweeps, or null (none, or more than one). */
export function pathParam(handle) {
  const keys = Array.isArray(handle?.params) ? handle.params.filter((k) => typeof k === "string") : [];
  return keys.length === 1 ? keys[0] : null;
}

/**
 * What a path depends on: every param but the swept one. A drag of that param leaves the
 * key as it was, so the path drawn at the drag's start holds through it.
 */
export function pathKey(params, swept) {
  const rest = Object.keys(params ?? {}).filter((k) => k !== swept).sort();
  try {
    return JSON.stringify(rest.map((k) => [k, params[k]]));
  } catch {
    return null; // not serializable: never cached
  }
}

/**
 * A one-parameter handle's path: PATH_SAMPLES points of its point as the param runs from
 * its range's min to its max (a wrapped param: one turn), through derive. Samples the
 * point cannot be read at are skipped. Null for a handle with no single param, a param
 * with no finite range, or fewer than two readable samples.
 */
export function sweepPath(part, params, handle) {
  const key = pathParam(handle);
  const r = key ? rangesOf(part).get(key) : null;
  if (!r || !isNum(r.min) || !isNum(r.max) || !(r.max > r.min)) return null;
  const points = [];
  for (let i = 0; i < PATH_SAMPLES; i++) {
    const value = r.min + ((r.max - r.min) * i) / (PATH_SAMPLES - 1);
    try {
      const { p, d } = resolveParams(part, { ...params, [key]: value });
      points.push(locateHandle(part, p, d, handle));
    } catch { /* an unreadable sample: skipped */ }
  }
  return points.length >= 2 ? { kind: "path", points } : null;
}

/** Decimal places of a step (0.1 -> 1, 0.25 -> 2, 5 -> 0, 1e-7 -> 7). */
function decimals(n) {
  if (!isNum(n)) return 0;
  const s = String(n);
  const e = s.match(/e-(\d+)$/);
  if (e) return Number(e[1]);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/** The params a handle's readout shows: its `readout` (one name or a list), else its `params`. */
export function readoutKeys(handle) {
  const listed = typeof handle?.readout === "string" ? [handle.readout]
    : Array.isArray(handle?.readout) ? handle.readout
    : Array.isArray(handle?.params) ? handle.params : [];
  return listed.filter((k) => typeof k === "string");
}

/**
 * The drag readout: each `readout` param (default: the handle's `params`) as
 * "<key> <value>", rounded to its step's decimals (no step: an integer as is, else two
 * places), joined by " · ". A param with no numeric value is left out.
 */
export function readoutText(part, params, handle) {
  return readoutItems(part, params, handle).map((i) => `${i.key} ${i.text}`).join(" · ");
}

/**
 * The readout's values one by one, `[{ key, label, unit, value, text }]`: `text` the value
 * as readoutText rounds it, `label` the control's label (else the key), `unit` its unit
 * (else null). The readout chip names its values by these.
 */
export function readoutItems(part, params, handle) {
  const ranges = rangesOf(part);
  const controls = new Map();
  try {
    for (const c of controlNodes(desugar(part?.parameters))) if (typeof c.key === "string" && !controls.has(c.key)) controls.set(c.key, c);
  } catch { /* a malformed schema: keys alone */ }
  const out = [];
  for (const key of readoutKeys(handle)) {
    const v = isNum(params?.[key]) ? params[key] : part?.defaults?.[key];
    if (!isNum(v)) continue;
    const step = ranges.get(key)?.step;
    const places = isNum(step) && step > 0 ? decimals(step) : Number.isInteger(v) ? 0 : 2;
    const c = controls.get(key);
    out.push({
      key,
      label: typeof c?.label === "string" && c.label ? c.label : key,
      unit: typeof c?.unit === "string" && c.unit ? c.unit : null,
      value: v,
      text: v.toFixed(Math.min(places, 20)),
    });
  }
  return out;
}

/**
 * The values the readout chip writes for what was typed into it (`typed`: key -> number),
 * as a slider would set them: a wrapped param kept in the turn it has now (the panel's
 * numeric.js sameTurn), then every value snapped to its control's step and clamped to its
 * range (param-solve's snapValues, which leaves a wrapped one unclamped). A value that is
 * not a finite number is left out.
 */
export function chipValues(part, params, typed) {
  const ranges = rangesOf(part);
  const raw = {};
  for (const [key, v] of Object.entries(typed ?? {})) {
    if (!isNum(v)) continue;
    const r = ranges.get(key);
    const stored = params?.[key];
    raw[key] = r?.wrap && isNum(r.min) && isNum(r.max) && r.max > r.min && isNum(stored)
      ? sameTurn(stored, v, r.min, r.max) : v;
  }
  return snapValues(part, raw);
}

/** numeric.js's sameTurn, restated here (that module is DOM chrome): `shown` reduced into [min, max), in the turn nearest `stored`. */
function sameTurn(stored, shown, min, max) {
  const span = max - min;
  const base = min + ((((shown - min) % span) + span) % span);
  return base + Math.round((stored - base) / span) * span;
}

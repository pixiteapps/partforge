// Rigid 3×4 transforms and the named frame tree. Shared core: the kinematics domain and the implicit engine both build on it.
// Layout: [r00 r01 r02 r10 r11 r12 r20 r21 r22 tx ty tz]; x' = r00·x + r01·y + r02·z + tx.
// Math.cos/Math.sin appear ONLY in `rotation` — lowering-time constants that the
// native port receives as data.
import { hypot3 } from "./js-math.js";
import { SpecError } from "./errors.js";

export const IDENTITY = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);

/** A∘B: apply B, then A. */
export function compose(A, B) {
  const o = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) o[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    o[9 + i] = A[3 * i] * B[9] + A[3 * i + 1] * B[10] + A[3 * i + 2] * B[11] + A[9 + i];
  }
  return o;
}

/** Inverse of a rigid transform: Rᵀ, −Rᵀ·t. */
export function invert(M) {
  const o = new Float64Array(12);
  o[0] = M[0]; o[1] = M[3]; o[2] = M[6];
  o[3] = M[1]; o[4] = M[4]; o[5] = M[7];
  o[6] = M[2]; o[7] = M[5]; o[8] = M[8];
  for (let i = 0; i < 3; i++) o[9 + i] = -(o[3 * i] * M[9] + o[3 * i + 1] * M[10] + o[3 * i + 2] * M[11]);
  return o;
}

export const translation = (t) => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, t[0], t[1], t[2]);

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export function axisVector(axis) {
  const a = typeof axis === "string" ? AXES[axis] : axis;
  if (!a) throw new SpecError(`unknown axis ${JSON.stringify(axis)}`);
  const l = hypot3(a[0], a[1], a[2]);
  if (!(l > 0)) throw new SpecError(`axis ${JSON.stringify(axis)} has zero length`);
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function rotation(axis, deg) {
  const [x, y, z] = axisVector(axis);
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return Float64Array.of(
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
    0, 0, 0);
}

export function xformPoint(out, M, x, y, z) {
  out[0] = M[0] * x + M[1] * y + M[2] * z + M[9];
  out[1] = M[3] * x + M[4] * y + M[5] * z + M[10];
  out[2] = M[6] * x + M[7] * y + M[8] * z + M[11];
}

export function xformDir(out, M, x, y, z) {
  out[0] = M[0] * x + M[1] * y + M[2] * z;
  out[1] = M[3] * x + M[4] * y + M[5] * z;
  out[2] = M[6] * x + M[7] * y + M[8] * z;
}

const frameError = (issue) => new SpecError(issue, { issues: [issue] });

/** A frame's local transform: translate(at), then each rotate step about the current axes. */
function localOf(def) {
  let M = translation(def.at ?? [0, 0, 0]);
  const steps = def.rotate == null ? [] : Array.isArray(def.rotate) ? def.rotate : [def.rotate];
  for (const r of steps) M = compose(M, rotation(r.axis ?? "z", r.deg ?? 0));
  return M;
}

/** Every frame's world transform (and inverse), resolved through the parent chain. */
export function resolveFrames(frames = {}) {
  const out = new Map();
  const visiting = new Set();
  const get = (name, from) => {
    if (out.has(name)) return out.get(name).world;
    const def = Object.hasOwn(frames, name) ? frames[name] : null;
    if (!def) throw frameError(`${from}: unknown frame "${name}"`);
    if (visiting.has(name)) throw frameError(`frames.${name}: frame "${name}" is its own ancestor`);
    visiting.add(name);
    const parent = def.parent == null ? IDENTITY : get(def.parent, `frames.${name}.parent`);
    const world = compose(parent, localOf(def));
    visiting.delete(name);
    out.set(name, { world, inv: invert(world) });
    return world;
  };
  for (const name of Object.keys(frames)) get(name, `frames.${name}`);
  return out;
}

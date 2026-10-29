// Closed-form signed distances for the plain shapes grip can close on, so
// `grip.around` needs no implicit engine. The vocabulary, field names and defaults are
// k.implicit's grammar; the formulas are its primitives' closed forms with the same
// parameter packing (axis basis, capsule `a` at the origin, `r` as one radius or a taper),
// so a node here measures what it measures there. Anything else — a blend, a warp, an
// expr — needs the engine: pass a distance function instead.
import { SpecError } from "../../geometry/errors.js";
import { axisVector } from "../../geometry/xform.js";
import { hypot3 } from "../../geometry/js-math.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// Field type → problem string or null (k.implicit grammar.js's checkers, same wording).
const TYPES = {
  pos: (v) => (isNum(v) && v > 0 ? null : "must be a number > 0"),
  nonneg: (v) => (isNum(v) && v >= 0 ? null : "must be a number ≥ 0"),
  num: (v) => (isNum(v) ? null : "must be a finite number"),
  vec3: (v) => (isVec3(v) ? null : "must be [x, y, z]"),
  pos3: (v) => (isVec3(v) && v.every((c) => c > 0) ? null : "must be [x, y, z] with every value > 0"),
  axis: (v) => (v === "x" || v === "y" || v === "z" || (isVec3(v) && v.some((c) => c !== 0))
    ? null : 'must be "x", "y", "z" or a non-zero [x, y, z]'),
  radius: (v) => ((isNum(v) && v > 0) || (Array.isArray(v) && v.length === 2 && v.every((c) => isNum(c) && c > 0))
    ? null : "must be a number > 0 or [r0, r1] with both > 0"),
  tubeRadius: (v) => ((isNum(v) && v > 0) || (Array.isArray(v) && v.every((c) => isNum(c) && c > 0))
    ? null : "must be a number > 0 or one number > 0 per point"),
  points: (v) => (Array.isArray(v) && v.length >= 2 && v.every(isVec3) ? null : "must be at least two [x, y, z] points"),
  string: (v) => (typeof v === "string" && v.length > 0 ? null : "must be a non-empty string"),
  children: (v) => (Array.isArray(v) && v.length > 0 ? null : "must be a non-empty array of nodes"),
};

// `frame` is not here: shapes are in part coordinates (checked before the fields).
const COMMON = { at: "vec3", label: "string" };
const SHAPE_KINDS = {
  sphere: { req: { r: "pos" } },
  ellipsoid: { req: { r: "pos3" } },
  capsule: { req: { b: "vec3", r: "radius" }, opt: { a: "vec3" } },
  box: { req: { size: "pos3" }, opt: { round: "nonneg" } },
  cylinder: { req: { h: "pos", r: "pos" }, opt: { round: "nonneg", axis: "axis" } },
  torus: { req: { R: "pos", r: "pos" }, opt: { axis: "axis" } },
  tube: { req: { points: "points", r: "tubeRadius" } },
  halfspace: { req: { normal: "axis" }, opt: { offset: "num" } },
  union: { req: { children: "children" }, opt: { k: "nonneg" } },
};
/** k.implicit kinds with no closed form here (they need the implicit engine). */
const ENGINE_KINDS = new Set(["intersect", "subtract", "contact", "mirror", "round", "onion", "displace", "twist", "bend", "taper", "repeat", "expr"]);
const ENGINE_FIX = "needs the implicit engine — pass a distance function (x, y, z) => mm instead — implicitDistance(node) from partforge/geometry makes one";

const defaultFail = (field, msg) => { throw new SpecError(`${field}: ${msg}`, { field }); };

/**
 * The rows of the basis taking `axis` to z (implicit/ir.js warpBasis with no `toward`): x̂ is
 * [1, 0, 0] made perpendicular, or [0, 1, 0] when the axis lies within ~25° of x.
 */
function axisBasis(axis) {
  const z = axisVector(axis);
  let t = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = t[0] * z[0] + t[1] * z[1] + t[2] * z[2];
  t = [t[0] - d * z[0], t[1] - d * z[1], t[2] - d * z[2]];
  const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
  const x = [t[0] / tl, t[1] / tl, t[2] / tl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x, y, z];
}

/** A distance about `axis` (default z): `f(x, y, z)` in the basis where the axis is z. */
function aboutAxis(axis, f) {
  if (axis == null || axis === "z") return f;
  const [X, Y, Z] = axisBasis(axis);
  return (x, y, z) => f(
    X[0] * x + X[1] * y + X[2] * z,
    Y[0] * x + Y[1] * y + Y[2] * z,
    Z[0] * x + Z[1] * y + Z[2] * z);
}

/** Capsule from a to b, radius r (implicit primitives.js case 3). */
function capsule(a, b, r) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const bb = bx * bx + by * by + bz * bz;
  return (x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2];
    let h = bb > 0 ? (px * bx + py * by + pz * bz) / bb : 0;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    return hypot3(px - bx * h, py - by * h, pz - bz * h) - r;
  };
}

const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
/** Round cone from a (radius r1) to b (radius r2): Quilez sdRoundCone, exact (primitives.js case 4). */
function roundCone(a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - a[0], pay = y - a[1], paz = z - a[2];
    const yv = pax * bax + pay * bay + paz * baz, zv = yv - l2;
    const xx = pax * l2 - bax * yv, xy = pay * l2 - bay * yv, xz = paz * l2 - baz * yv;
    const x2 = xx * xx + xy * xy + xz * xz, y2 = yv * yv * l2, z2 = zv * zv * l2;
    const k = sgn(rr) * rr * rr * x2;
    if (sgn(zv) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (sgn(yv) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
  };
}

/** A capsule node's packing (ir.js): `a` at the origin by default, `r` one radius or a taper. */
function capsuleOf(a, b, r) {
  const [r1, r2] = Array.isArray(r) ? r : [r, r];
  return r1 === r2 ? capsule(a, b, r1) : roundCone(a, b, r1, r2);
}

function minOf(fs) {
  if (fs.length === 1) return fs[0];
  return (x, y, z) => {
    let m = Infinity;
    for (const f of fs) { const v = f(x, y, z); if (v < m) m = v; }
    return m;
  };
}

/** Validate one node (and its children), then build its distance in its parent's coordinates. */
function compile(node, path, fail) {
  if (!isObj(node)) fail(path, "must be a node object");
  if (Object.hasOwn(node, "frame")) fail(path, 'shapes are in part coordinates; drop "frame"');
  const { kind } = node;
  if (ENGINE_KINDS.has(kind)) fail(path, `node kind "${kind}" ${ENGINE_FIX}`);
  const schema = typeof kind === "string" && Object.hasOwn(SHAPE_KINDS, kind) ? SHAPE_KINDS[kind] : null;
  if (!schema) fail(`${path}.kind`, `unknown kind ${JSON.stringify(kind)} (expected one of ${Object.keys(SHAPE_KINDS).join(", ")})`);

  const known = { ...COMMON, ...schema.req, ...(schema.opt ?? {}) };
  for (const key of Object.keys(node)) if (key !== "kind" && !(key in known)) fail(path, `unknown field "${key}"`);
  for (const [key, type] of Object.entries(known)) {
    const v = node[key];
    if (v === undefined) { if (key in schema.req) fail(`${path}.${key}`, "required"); continue; }
    const problem = TYPES[type](v);
    if (problem) fail(`${path}.${key}`, problem);
  }
  if (kind === "tube" && Array.isArray(node.r) && node.r.length !== node.points.length) fail(`${path}.r`, `needs one radius per point (${node.points.length})`);
  if (kind === "box" && node.round != null && node.round > Math.min(...node.size) / 2) fail(`${path}.round`, `must be at most half the smallest size (${Math.min(...node.size) / 2})`);
  if (kind === "cylinder" && node.round != null && node.round > Math.min(node.r, node.h / 2)) fail(`${path}.round`, "must be at most min(r, h/2)");
  if (kind === "union" && node.k > 0) fail(path, `a blended union ${ENGINE_FIX}`);

  let f;
  switch (kind) {
    case "sphere": { const { r } = node; f = (x, y, z) => hypot3(x, y, z) - r; break; }
    case "ellipsoid": {
      // The scaled-sphere field min(r)·(|p/r| − 1): 1-Lipschitz, not a true distance.
      const [a, b, c] = node.r, m = Math.min(a, b, c);
      f = (x, y, z) => m * (hypot3(x / a, y / b, z / c) - 1);
      break;
    }
    case "capsule": f = capsuleOf(node.a ?? [0, 0, 0], node.b, node.r); break;
    case "box": {
      const [hx, hy, hz] = node.size.map((v) => v / 2), r = node.round ?? 0;
      f = (x, y, z) => {
        const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r, qz = Math.abs(z) - hz + r;
        return hypot3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
      };
      break;
    }
    case "cylinder": {
      const hh = node.h / 2, R = node.r, r = node.round ?? 0;
      f = aboutAxis(node.axis, (x, y, z) => {
        const dx = Math.sqrt(x * x + y * y) - R + r, dz = Math.abs(z) - hh + r;
        const mx = Math.max(dx, 0), mz = Math.max(dz, 0);
        return Math.sqrt(mx * mx + mz * mz) + Math.min(Math.max(dx, dz), 0) - r;
      });
      break;
    }
    case "torus": {
      const { R, r } = node;
      f = aboutAxis(node.axis, (x, y, z) => { const q = Math.sqrt(x * x + y * y) - R; return Math.sqrt(q * q + z * z) - r; });
      break;
    }
    case "halfspace": {
      const [nx, ny, nz] = axisVector(node.normal), o = node.offset ?? 0;
      f = (x, y, z) => nx * x + ny * y + nz * z - o;
      break;
    }
    case "tube": {
      const pts = node.points, radii = Array.isArray(node.r) ? node.r : pts.map(() => node.r);
      const segs = [];
      for (let i = 0; i + 1 < pts.length; i++) segs.push(capsuleOf(pts[i], pts[i + 1], radii[i] === radii[i + 1] ? radii[i] : [radii[i], radii[i + 1]]));
      f = minOf(segs);
      break;
    }
    case "union": f = minOf(node.children.map((c, i) => compile(c, `${path}.children[${i}]`, fail))); break;
  }
  if (node.at) {
    const [ax, ay, az] = node.at, g = f;
    f = (x, y, z) => g(x - ax, y - ay, z - az);
  }
  return f;
}

/**
 * `distanceFor(node) → (x, y, z) => mm`: the signed distance (negative inside) to a plain
 * shape node, in part coordinates. The node is validated once, here; errors go through
 * `fail(field, msg)` (default: throw a SpecError `<field>: <msg>`), with fields named from
 * `path` (default "grip.around").
 */
export function distanceFor(node, { fail = defaultFail, path = "grip.around" } = {}) {
  return compile(node, path, fail);
}

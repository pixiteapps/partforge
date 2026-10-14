// The k.implicit grammar as data, and the validator that turns a bad spec into
// one ImplicitSpecError listing every issue with its exact path. Expr SOURCE is
// checked later, when it is lowered (ir.js); everything structural is here.
import { ImplicitSpecError } from "./errors.js";
import { resolveFrames } from "./frames.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// Field type → checker returning a problem string or null. Checkers that need to
// recurse receive (value, path, ctx).
const TYPES = {
  pos: (v) => (isNum(v) && v > 0 ? null : "must be a number > 0"),
  nonneg: (v) => (isNum(v) && v >= 0 ? null : "must be a number ≥ 0"),
  num: (v) => (isNum(v) ? null : "must be a finite number"),
  vec3: (v) => (isVec3(v) ? null : "must be [x, y, z]"),
  pos3: (v) => (isVec3(v) && v.every((c) => c > 0) ? null : "must be [x, y, z] with every value > 0"),
  axis: (v) => (v === "x" || v === "y" || v === "z" || (isVec3(v) && v.some((c) => c !== 0))
    ? null : 'must be "x", "y", "z" or a non-zero [x, y, z]'),
  axisName: (v) => (v === "x" || v === "y" || v === "z" ? null : 'must be "x", "y" or "z"'),
  radius: (v) => ((isNum(v) && v > 0) || (Array.isArray(v) && v.length === 2 && v.every((c) => isNum(c) && c > 0))
    ? null : "must be a number > 0 or [r0, r1] with both > 0"),
  tubeRadius: (v) => ((isNum(v) && v > 0) || (Array.isArray(v) && v.every((c) => isNum(c) && c > 0))
    ? null : "must be a number > 0 or one number > 0 per point"),
  points: (v) => (Array.isArray(v) && v.length >= 2 && v.every(isVec3) ? null : "must be at least two [x, y, z] points"),
  plane: (v) => (["yz", "xz", "xy"].includes(v) ? null : 'must be "yz", "xz" or "xy"'),
  string: (v) => (typeof v === "string" && v.length > 0 ? null : "must be a non-empty string"),
  source: (v) => (typeof v === "string" ? null : "must be a string of expr source"),
  size2: (v) => (Array.isArray(v) && v.length === 2 && v.every((c) => isNum(c) && c > 0) ? null : "must be [u, v] with both > 0"),
  taperEnd: (v) => (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[1] > 0 ? null : "must be [position, scale] with scale > 0"),
  box: (v) => (Array.isArray(v) && v.length === 2 && isVec3(v[0]) && isVec3(v[1]) && v[0].every((c, i) => c < v[1][i])
    ? null : "must be [[minX, minY, minZ], [maxX, maxY, maxZ]] with min < max"),
  projection: (v) => (["planar", "cylindrical", "triplanar"].includes(v) ? null : 'must be "planar", "cylindrical" or "triplanar"'),
  uniforms: (v) => (isObj(v) && Object.values(v).every(isNum) ? null : "must be an object of finite numbers"),
  child: (v, path, ctx) => { if (!isObj(v)) return "must be a node object"; walkNode(v, path, ctx); return null; },
  children: (v, path, ctx) => {
    if (!Array.isArray(v) || v.length === 0) return "must be a non-empty array of nodes";
    v.forEach((c, i) => (isObj(c) ? walkNode(c, `${path}[${i}]`, ctx) : ctx.issues.push(`${path}[${i}]: must be a node object`)));
    return null;
  },
  textureMap: (v, path, ctx) => {
    if (!isObj(v)) return "must be an object of { image } entries";
    for (const [name, t] of Object.entries(v)) {
      if (!isObj(t) || typeof t.image !== "string") { ctx.issues.push(`${path}.${name}: must be { image: "<name>" }`); continue; }
      if (ctx.imageNames && !ctx.imageNames.has(t.image)) {
        ctx.issues.push(`${path}.${name}.image: unknown image "${t.image}" — declare it in the part's \`images\` field`);
      }
    }
    return null;
  },
  exprSpec: (v, path, ctx) => {
    if (!isObj(v) || typeof v.expr !== "string") return "must be { expr: \"<source>\", uniforms?, textures? }";
    if (v.uniforms != null) { const p = TYPES.uniforms(v.uniforms); if (p) ctx.issues.push(`${path}.uniforms: ${p}`); }
    if (v.textures != null) TYPES.textureMap(v.textures, `${path}.textures`, ctx);
    return null;
  },
  linear: (v) => (isObj(v) && isVec3(v.step) && v.step.some((c) => c !== 0) && Number.isInteger(v.count) && v.count >= 1 && v.count <= 256
    ? null : "must be { step: [x, y, z] (non-zero), count: 1–256 }"),
  polar: (v) => (isObj(v) && Number.isInteger(v.count) && v.count >= 1 && v.count <= 256 && (v.axis == null || TYPES.axis(v.axis) === null)
    ? null : "must be { count: 1–256, axis? }"),
};

const COMMON = { frame: "string", at: "vec3", label: "string" };

export const NODE_KINDS = {
  sphere: { req: { r: "pos" } },
  ellipsoid: { req: { r: "pos3" } },
  capsule: { req: { b: "vec3", r: "radius" }, opt: { a: "vec3" } },
  box: { req: { size: "pos3" }, opt: { round: "nonneg" } },
  cylinder: { req: { h: "pos", r: "pos" }, opt: { round: "nonneg", axis: "axis" } },
  torus: { req: { R: "pos", r: "pos" }, opt: { axis: "axis" } },
  tube: { req: { points: "points", r: "tubeRadius" } },
  halfspace: { req: { normal: "axis" }, opt: { offset: "num" } },
  union: { req: { children: "children" }, opt: { k: "nonneg" } },
  intersect: { req: { children: "children" }, opt: { k: "nonneg" } },
  subtract: { req: { children: "children" }, opt: { k: "nonneg" } },
  mirror: { req: { child: "child" }, opt: { plane: "plane" } },
  round: { req: { child: "child", r: "pos" } },
  onion: { req: { child: "child", t: "pos" } },
  displace: { req: { child: "child", amount: "pos", by: "exprSpec" } },
  twist: { req: { child: "child", degPerMm: "num" }, opt: { axis: "axis" } },
  bend: { req: { child: "child", radius: "pos" }, opt: { axis: "axis", toward: "axis" } },
  taper: { req: { child: "child", from: "taperEnd", to: "taperEnd" }, opt: { axis: "axis" } },
  repeat: { req: { child: "child" }, opt: { linear: "linear", polar: "polar" } },
  expr: { req: { sdf: "source", box: "box" }, opt: { uniforms: "uniforms", textures: "textureMap", lipschitz: "pos" } },
};

const DETAIL_COMMON = { frame: "string", at: "vec3", radius: "pos", side: "axis" };
export const DETAIL_KINDS = {
  creases: { req: { amplitude: "num", wavelength: "pos" }, opt: { axis: "axisName" } },
  noise: { req: { amplitude: "num", wavelength: "pos" } },
  texture: { req: { image: "string", amplitude: "num", size: "size2" }, opt: { projection: "projection", axis: "axisName" } },
  expr: { req: { height: "source" }, opt: { uniforms: "uniforms", textures: "textureMap", wavelength: "pos" } },
};

function checkFields(obj, schema, common, path, ctx) {
  const known = { ...common, ...schema.req, ...(schema.opt ?? {}) };
  for (const key of Object.keys(obj)) {
    if (key === "kind") continue;
    if (!(key in known)) ctx.issues.push(`${path}: unknown field "${key}"`);
  }
  for (const [key, type] of Object.entries(known)) {
    const v = obj[key];
    if (v === undefined) { if (key in schema.req) ctx.issues.push(`${path}.${key}: required`); continue; }
    const problem = TYPES[type](v, `${path}.${key}`, ctx);
    if (problem) ctx.issues.push(`${path}.${key}: ${problem}`);
  }
}

function walkNode(node, path, ctx) {
  const schema = NODE_KINDS[node.kind];
  if (!schema) {
    ctx.issues.push(`${path}.kind: unknown kind ${JSON.stringify(node.kind)} (expected one of ${Object.keys(NODE_KINDS).join(", ")})`);
    return;
  }
  checkFields(node, schema, COMMON, path, ctx);
  if (typeof node.frame === "string" && !ctx.frameNames.has(node.frame)) ctx.issues.push(`${path}.frame: unknown frame "${node.frame}"`);
  if (node.kind === "repeat" && (node.linear == null) === (node.polar == null)) ctx.issues.push(`${path}: repeat needs exactly one of \`linear\` or \`polar\``);
  if (node.kind === "tube" && Array.isArray(node.r) && Array.isArray(node.points) && node.r.length !== node.points.length) {
    ctx.issues.push(`${path}.r: needs one radius per point (${node.points.length})`);
  }
  if (node.kind === "box" && isNum(node.round) && isVec3(node.size) && node.round > Math.min(...node.size) / 2) {
    ctx.issues.push(`${path}.round: must be at most half the smallest size (${Math.min(...node.size) / 2})`);
  }
  if (node.kind === "cylinder" && isNum(node.round) && isNum(node.r) && isNum(node.h) && node.round > Math.min(node.r, node.h / 2)) {
    ctx.issues.push(`${path}.round: must be at most min(r, h/2)`);
  }
}

export function validateSpec(spec, { imageNames = null } = {}) {
  const issues = [];
  if (!isObj(spec)) throw new ImplicitSpecError("expected an options object { frames?, root, detail?, resolution?, preview? }");
  const ctx = { issues, imageNames, frameNames: new Set() };
  if (spec.frames != null) {
    if (!isObj(spec.frames)) issues.push("frames: must be an object of named frames");
    else {
      for (const [name, f] of Object.entries(spec.frames)) {
        ctx.frameNames.add(name);
        if (!isObj(f)) { issues.push(`frames.${name}: must be { parent?, at?, rotate? }`); continue; }
        for (const key of Object.keys(f)) if (!["parent", "at", "rotate"].includes(key)) issues.push(`frames.${name}: unknown field "${key}"`);
        if (f.at != null && !isVec3(f.at)) issues.push(`frames.${name}.at: must be [x, y, z]`);
        const steps = f.rotate == null ? [] : Array.isArray(f.rotate) ? f.rotate : [f.rotate];
        steps.forEach((r, i) => {
          if (!isObj(r) || TYPES.axis(r.axis) !== null || !isNum(r.deg)) issues.push(`frames.${name}.rotate[${i}]: must be { axis, deg }`);
        });
      }
      if (issues.length === 0) {
        try { resolveFrames(spec.frames); } catch (e) { if (e.code === "IMPLICIT_SPEC") issues.push(...e.issues); else throw e; }
      }
    }
  }
  if (spec.root == null) issues.push("root: required");
  else if (!isObj(spec.root)) issues.push("root: must be a node object");
  else walkNode(spec.root, "root", ctx);
  for (const key of ["resolution", "preview"]) {
    if (spec[key] != null && !(isNum(spec[key]) && spec[key] >= 0.05)) issues.push(`${key}: must be a number ≥ 0.05`);
  }
  if (spec.detail != null) {
    if (!Array.isArray(spec.detail)) issues.push("detail: must be an array");
    else spec.detail.forEach((d, i) => {
      const path = `detail[${i}]`;
      const schema = isObj(d) && DETAIL_KINDS[d.kind];
      if (!schema) { issues.push(`${path}.kind: unknown detail kind ${JSON.stringify(d?.kind)} (expected one of ${Object.keys(DETAIL_KINDS).join(", ")})`); return; }
      checkFields(d, schema, DETAIL_COMMON, path, ctx);
      if (typeof d.frame === "string" && !ctx.frameNames.has(d.frame)) issues.push(`${path}.frame: unknown frame "${d.frame}"`);
      if (d.kind === "texture" && ctx.imageNames && !ctx.imageNames.has(d.image)) {
        issues.push(`${path}.image: unknown image "${d.image}" — declare it in the part's \`images\` field`);
      }
    });
  }
  for (const key of Object.keys(spec)) {
    if (!["frames", "root", "detail", "resolution", "preview"].includes(key)) issues.push(`${key}: unknown option`);
  }
  if (issues.length) throw new ImplicitSpecError(issues);
}

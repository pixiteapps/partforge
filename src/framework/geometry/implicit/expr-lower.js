// src/framework/geometry/implicit/expr-lower.js
// Lowers a parsed expr to scalar SSA ops (vectors become 2 or 3 scalar registers,
// loops unroll). The scalar function tables here are THE semantics: the reference
// evaluator and the bytecode interpreter both call them, so they agree exactly.
import { pfSin, pfCos } from "../js-math.js";
import { parseExpr, ExprError } from "./expr-parse.js";

export function smin2(a, b, k) {
  if (!(k > 0)) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export const smax2 = (a, b, k) => -smin2(-a, -b, k);

export const UN = {
  neg: (a) => -a, abs: Math.abs, floor: Math.floor, fract: (a) => a - Math.floor(a), sqrt: Math.sqrt,
  sin: pfSin, cos: pfCos, not: (a) => (a === 0 ? 1 : 0),
};
export const BIN = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b,
  min: Math.min, max: Math.max, mod: (a, b) => a - b * Math.floor(a / b), step: (e, x) => (x < e ? 0 : 1),
  lt: (a, b) => (a < b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0), le: (a, b) => (a <= b ? 1 : 0), ge: (a, b) => (a >= b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0), ne: (a, b) => (a !== b ? 1 : 0),
  and: (a, b) => (a !== 0 && b !== 0 ? 1 : 0), or: (a, b) => (a !== 0 || b !== 0 ? 1 : 0),
};
export const TER = {
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  mix: (a, b, t) => a * (1 - t) + b * t,
  smoothstep: (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); },
  smin: smin2, smax: smax2,
  select: (c, a, b) => (c !== 0 ? a : b),
};

const SIZE = { float: 1, bool: 1, vec2: 2, vec3: 3 };
const VEC = { 2: "vec2", 3: "vec3" };
const BIN_OPS = { "+": "add", "-": "sub", "*": "mul", "/": "div", "<": "lt", ">": "gt", "<=": "le", ">=": "ge", "==": "eq", "!=": "ne", "&&": "and", "||": "or" };
const COMPONENTWISE_UN = new Set(["abs", "floor", "fract", "sqrt", "sin", "cos"]);
const SWZ = { x: 0, y: 1, z: 2, r: 0, g: 1, b: 2 };
const MAX_LOOP = 16;
const MAX_OPS = 8192;

export function lowerExpr(ast, { uniforms = {}, textureSlots = {} } = {}) {
  const ops = [];
  let nregs = 0;
  const reg = () => nregs++;
  const emit = (o) => { if (ops.length >= MAX_OPS) throw new ExprError(`formula is too large (over ${MAX_OPS} operations after unrolling)`, 1); ops.push(o); return o.dst; };
  const konst = (val) => emit({ op: "const", dst: reg(), val });
  const val = (type, regs) => ({ type, regs });
  const P = val("vec3", [0, 1, 2].map((comp) => emit({ op: "get", dst: reg(), comp })));
  const scopes = [new Map()];
  const lookup = (name) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); return null; };

  const un = (fn, v) => val(v.type, v.regs.map((a) => emit({ op: "un", fn, dst: reg(), a })));
  const broadcast = (v, n, line) => {
    if (v.type === "bool") throw new ExprError("expected a number, got a comparison", line);
    if (SIZE[v.type] === n) return v.regs;
    if (v.type === "float") return Array(n).fill(v.regs[0]);
    throw new ExprError(`cannot combine ${v.type} with ${VEC[n] ?? "float"}`, line);
  };
  const widest = (...vs) => Math.max(...vs.map((v) => (v.type === "bool" ? 1 : SIZE[v.type])));
  const bin = (fn, a, b, line) => {
    const n = widest(a, b), A = broadcast(a, n, line), B = broadcast(b, n, line);
    return val(n === 1 ? "float" : VEC[n], A.map((ra, i) => emit({ op: "bin", fn, dst: reg(), a: ra, b: B[i] })));
  };
  const ter = (fn, a, b, c, line) => {
    const n = widest(a, b, c), A = broadcast(a, n, line), B = broadcast(b, n, line), C = broadcast(c, n, line);
    return val(n === 1 ? "float" : VEC[n], A.map((ra, i) => emit({ op: "ter", fn, dst: reg(), a: ra, b: B[i], c: C[i] })));
  };
  const sumOf = (regs) => regs.slice(1).reduce((acc, r) => emit({ op: "bin", fn: "add", dst: reg(), a: acc, b: r }), regs[0]);
  const lengthOf = (v) => val("float", [emit({ op: "un", fn: "sqrt", dst: reg(), a: sumOf(v.regs.map((r) => emit({ op: "bin", fn: "mul", dst: reg(), a: r, b: r }))) })]);
  const needFloat = (v, what, line) => { if (v.type !== "float") throw new ExprError(`${what} must be a float, got ${v.type}`, line); return v; };
  const needVec = (v, what, line) => { if (v.type !== "vec2" && v.type !== "vec3") throw new ExprError(`${what} must be a vec2 or vec3, got ${v.type}`, line); return v; };
  const arity = (name, args, n, line) => { if (args.length !== n) throw new ExprError(`${name} expects ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`, line); };

  function call(node) {
    const { name, line } = node;
    if (name === "texture") {
      arity(name, node.args, 2, line);
      const tn = node.args[0];
      if (tn.t !== "id" || !Object.hasOwn(textureSlots, tn.name)) throw new ExprError(`unknown texture '${tn.t === "id" ? tn.name : "?"}' — list it in this formula's \`textures\``, line);
      const uv = ex(node.args[1]);
      if (uv.type !== "vec2") throw new ExprError(`texture uv must be a vec2, got ${uv.type}`, line);
      return val("float", [emit({ op: "tex", dst: reg(), slot: textureSlots[tn.name], u: uv.regs[0], v: uv.regs[1] })]);
    }
    const args = node.args.map(ex);
    if (name === "float") { arity(name, args, 1, line); return val("float", [args[0].regs[0]]); }
    if (name === "vec2" || name === "vec3") {
      const n = SIZE[name];
      const regs = args.flatMap((a) => a.regs);
      if (regs.length === 1) return val(name, Array(n).fill(regs[0]));
      if (regs.length !== n) throw new ExprError(`${name} needs ${n} components, got ${regs.length}`, line);
      return val(name, regs);
    }
    if (COMPONENTWISE_UN.has(name)) { arity(name, args, 1, line); return un(name, args[0]); }
    if (name === "min" || name === "max" || name === "mod" || name === "step") { arity(name, args, 2, line); return bin(name, args[0], args[1], line); }
    if (name === "clamp" || name === "mix" || name === "smoothstep") { arity(name, args, 3, line); return ter(name, args[0], args[1], args[2], line); }
    if (name === "smin" || name === "smax") { arity(name, args, 3, line); args.forEach((a) => needFloat(a, `${name} argument`, line)); return ter(name, args[0], args[1], args[2], line); }
    if (name === "length") { arity(name, args, 1, line); return lengthOf(needVec(args[0], "length argument", line)); }
    if (name === "dot") {
      arity(name, args, 2, line);
      if (args[0].type !== args[1].type) throw new ExprError("dot needs two vectors of the same size", line);
      needVec(args[0], "dot argument", line);
      return val("float", [sumOf(args[0].regs.map((r, i) => emit({ op: "bin", fn: "mul", dst: reg(), a: r, b: args[1].regs[i] })))]);
    }
    if (name === "normalize") {
      arity(name, args, 1, line);
      const l = lengthOf(needVec(args[0], "normalize argument", line)).regs[0];
      return val(args[0].type, args[0].regs.map((r) => emit({ op: "bin", fn: "div", dst: reg(), a: r, b: l })));
    }
    if (name === "cross") {
      arity(name, args, 2, line);
      if (args[0].type !== "vec3" || args[1].type !== "vec3") throw new ExprError("cross needs two vec3s", line);
      const [ax, ay, az] = args[0].regs, [bx, by, bz] = args[1].regs;
      const m = (a, b) => emit({ op: "bin", fn: "mul", dst: reg(), a, b });
      const s = (a, b) => emit({ op: "bin", fn: "sub", dst: reg(), a, b });
      return val("vec3", [s(m(ay, bz), m(az, by)), s(m(az, bx), m(ax, bz)), s(m(ax, by), m(ay, bx))]);
    }
    throw new ExprError(`unknown function '${name}'`, line);
  }

  function ex(node) {
    switch (node.t) {
      case "num": return val("float", [konst(node.v)]);
      case "id": {
        if (node.name === "p") return P;
        const local = lookup(node.name);
        if (local) return local;
        if (Object.hasOwn(uniforms, node.name)) return val("float", [konst(uniforms[node.name])]);
        throw new ExprError(`unknown name '${node.name}'`, node.line);
      }
      case "un": {
        const a = ex(node.a);
        if (node.op === "!") { if (a.type !== "bool") throw new ExprError("'!' needs a comparison", node.line); return val("bool", un("not", a).regs); }
        return un("neg", a);
      }
      case "bin": {
        const a = ex(node.a), b = ex(node.b), fn = BIN_OPS[node.op];
        if (fn === "and" || fn === "or") {
          if (a.type !== "bool" || b.type !== "bool") throw new ExprError(`'${node.op}' needs comparisons on both sides`, node.line);
          return val("bool", [emit({ op: "bin", fn, dst: reg(), a: a.regs[0], b: b.regs[0] })]);
        }
        if (["lt", "gt", "le", "ge", "eq", "ne"].includes(fn)) {
          needFloat(a, "a comparison operand", node.line); needFloat(b, "a comparison operand", node.line);
          return val("bool", [emit({ op: "bin", fn, dst: reg(), a: a.regs[0], b: b.regs[0] })]);
        }
        return bin(fn, a, b, node.line);
      }
      case "tern": {
        const c = ex(node.c);
        if (c.type !== "bool") throw new ExprError("the condition of '?:' must be a comparison", node.line);
        const a = ex(node.a), b = ex(node.b);
        if (a.type !== b.type) throw new ExprError(`both branches of '?:' must have the same type (${a.type} vs ${b.type})`, node.line);
        return val(a.type, a.regs.map((ra, i) => emit({ op: "ter", fn: "select", dst: reg(), a: c.regs[0], b: ra, c: b.regs[i] })));
      }
      case "swz": {
        const a = ex(node.a);
        if (a.type !== "vec2" && a.type !== "vec3") throw new ExprError(`cannot swizzle a ${a.type}`, node.line);
        const idx = [...node.s].map((ch) => SWZ[ch]);
        if (idx.length > 3 || idx.some((i) => i === undefined || i >= SIZE[a.type])) throw new ExprError(`bad swizzle '.${node.s}' on a ${a.type}`, node.line);
        return val(idx.length === 1 ? "float" : VEC[idx.length], idx.map((i) => a.regs[i]));
      }
      case "call": return call(node);
      default: throw new ExprError(`unsupported expression`, node.line ?? 1);
    }
  }

  let result = null;
  function stmts(list, top) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (result !== null) throw new ExprError("code after return", s.line);
      if (s.t === "decl") {
        const v = ex(s.e);
        if (v.type !== s.type) throw new ExprError(`'${s.name}' is declared ${s.type} but assigned a ${v.type}`, s.line);
        scopes[scopes.length - 1].set(s.name, v);
      } else if (s.t === "assign") {
        let found = null;
        for (let j = scopes.length - 1; j >= 0 && !found; j--) if (scopes[j].has(s.name)) found = scopes[j];
        if (!found) throw new ExprError(`unknown name '${s.name}'`, s.line);
        const v = ex(s.e);
        if (v.type !== found.get(s.name).type) throw new ExprError(`cannot assign a ${v.type} to ${found.get(s.name).type} '${s.name}'`, s.line);
        found.set(s.name, v);
      } else if (s.t === "for") {
        if (s.to - s.from > MAX_LOOP) throw new ExprError(`loops may run at most ${MAX_LOOP} iterations`, s.line);
        for (let it = s.from; it < s.to; it++) {
          scopes.push(new Map([[s.v, val("float", [konst(it)])]]));
          stmts(s.body, false);
          scopes.pop();
        }
      } else if (s.t === "ret") {
        if (!top) throw new ExprError("return is only allowed at the top level", s.line);
        const v = ex(s.e);
        if (v.type !== "float") throw new ExprError(`return must be a float, got ${v.type}`, s.line);
        result = v.regs[0];
      }
    }
  }
  stmts(ast, true);
  if (result === null) throw new ExprError("a formula must end with a return statement", ast.length ? ast[ast.length - 1].line : 1);
  return { ops, result, nregs };
}

export const compileExprSource = (src, opts) => lowerExpr(parseExpr(src), opts);

/** Scalar interpreter for lowered ops — used by the reference evaluator and surface detail. */
export function evalExprScalar(L, x, y, z, textures, sample) {
  const r = new Float64Array(L.nregs);
  for (const o of L.ops) {
    switch (o.op) {
      case "const": r[o.dst] = o.val; break;
      case "get": r[o.dst] = o.comp === 0 ? x : o.comp === 1 ? y : z; break;
      case "un": r[o.dst] = UN[o.fn](r[o.a]); break;
      case "bin": r[o.dst] = BIN[o.fn](r[o.a], r[o.b]); break;
      case "ter": r[o.dst] = TER[o.fn](r[o.a], r[o.b], r[o.c]); break;
      case "tex": r[o.dst] = sample(textures[o.slot], r[o.u], r[o.v]); break;
    }
  }
  return r[L.result];
}

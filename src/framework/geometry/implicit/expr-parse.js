// src/framework/geometry/implicit/expr-parse.js
// A GLSL subset for implicit formulas (spec §1 "expr formulas"): float/vec2/vec3
// locals, arithmetic, comparisons, && || !, the ternary, swizzles, calls, and
// `for (int i = A; i < B; i++)` with literal bounds (unrolled by the lowerer).
export class ExprError extends Error {
  constructor(message, line) { super(`line ${line}: ${message}`); this.name = "ExprError"; this.line = line; }
}

const PUNCT = ["<=", ">=", "==", "!=", "&&", "||", "++", "+=", "+", "-", "*", "/", "(", ")", "{", "}", ",", ";", ".", "?", ":", "<", ">", "!", "="];
const NUM = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const ID = /^[A-Za-z_]\w*/;

function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    const rest = src.slice(i);
    let m = NUM.exec(rest);
    if (m) { toks.push({ k: "num", v: Number(m[0]), line }); i += m[0].length; continue; }
    m = ID.exec(rest);
    if (m) { toks.push({ k: "id", v: m[0], line }); i += m[0].length; continue; }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (p) { toks.push({ k: "p", v: p, line }); i += p.length; continue; }
    throw new ExprError(`unexpected character '${c}'`, line);
  }
  toks.push({ k: "eof", v: "", line });
  return toks;
}

const TYPE_NAMES = new Set(["float", "vec2", "vec3"]);

export function parseExpr(src) {
  const toks = lex(src);
  let pos = 0;
  const peek = (o = 0) => toks[pos + o];
  const next = () => toks[pos++];
  const isP = (v, o = 0) => peek(o).k === "p" && peek(o).v === v;
  const isId = (v) => peek().k === "id" && peek().v === v;
  const expect = (v) => {
    if (!(isP(v) || isId(v))) throw new ExprError(`expected '${v}' but found '${peek().v || "end of source"}'`, peek().line);
    return next();
  };
  const ident = () => {
    const t = next();
    if (t.k !== "id") throw new ExprError(`expected a name but found '${t.v || "end of source"}'`, t.line);
    return t.v;
  };
  const intLit = () => {
    const t = next();
    if (t.k !== "num" || !Number.isInteger(t.v)) throw new ExprError("loop bounds must be integer literals", t.line);
    return t.v;
  };

  function block() {
    if (!isP("{")) return [statement()];
    next();
    const out = [];
    while (!isP("}")) {
      if (peek().k === "eof") throw new ExprError("missing '}'", peek().line);
      out.push(statement());
    }
    next();
    return out;
  }

  function statement() {
    const t = peek();
    if (t.k === "id" && TYPE_NAMES.has(t.v) && peek(1).k === "id") {
      next();
      const name = ident();
      expect("=");
      const e = expr();
      expect(";");
      return { t: "decl", type: t.v, name, e, line: t.line };
    }
    if (isId("return")) { next(); const e = expr(); expect(";"); return { t: "ret", e, line: t.line }; }
    if (isId("for")) {
      next(); expect("("); expect("int");
      const v = ident(); expect("="); const from = intLit(); expect(";");
      if (ident() !== v) throw new ExprError(`loop condition must test '${v}'`, t.line);
      expect("<"); const to = intLit(); expect(";");
      if (ident() !== v) throw new ExprError(`loop step must be '${v}++'`, t.line);
      expect("++"); expect(")");
      return { t: "for", v, from, to, body: block(), line: t.line };
    }
    if (t.k === "id" && (isP("=", 1) || isP("+=", 1))) {
      next();
      const op = next().v;
      const e = expr();
      expect(";");
      const value = op === "+=" ? { t: "bin", op: "+", a: { t: "id", name: t.v, line: t.line }, b: e, line: t.line } : e;
      return { t: "assign", name: t.v, e: value, line: t.line };
    }
    throw new ExprError("expected a declaration, an assignment, 'for' or 'return'", t.line);
  }

  const expr = () => ternary();
  function ternary() {
    const c = binary(0);
    if (!isP("?")) return c;
    const line = next().line;
    const a = ternary();
    expect(":");
    const b = ternary();
    return { t: "tern", c, a, b, line };
  }
  const LEVELS = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/"]];
  function binary(level) {
    if (level === LEVELS.length) return unary();
    let a = binary(level + 1);
    while (peek().k === "p" && LEVELS[level].includes(peek().v)) {
      const t = next();
      a = { t: "bin", op: t.v, a, b: binary(level + 1), line: t.line };
    }
    return a;
  }
  function unary() {
    if (isP("-") || isP("!")) { const t = next(); return { t: "un", op: t.v, a: unary(), line: t.line }; }
    return postfix();
  }
  function postfix() {
    let a = primary();
    while (isP(".")) { const t = next(); a = { t: "swz", a, s: ident(), line: t.line }; }
    return a;
  }
  function primary() {
    const t = next();
    if (t.k === "num") return { t: "num", v: t.v, line: t.line };
    if (t.k === "p" && t.v === "(") { const e = expr(); expect(")"); return e; }
    if (t.k === "id") {
      if (isP("(")) {
        next();
        const args = [];
        if (!isP(")")) { do args.push(expr()); while (isP(",") && next()); }
        expect(")");
        return { t: "call", name: t.v, args, line: t.line };
      }
      return { t: "id", name: t.v, line: t.line };
    }
    throw new ExprError(`unexpected '${t.v || "end of source"}'`, t.line);
  }

  const stmts = [];
  while (peek().k !== "eof") stmts.push(statement());
  return stmts;
}

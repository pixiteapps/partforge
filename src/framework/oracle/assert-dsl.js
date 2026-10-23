// Assertion mini-DSL: parse a declared expectation into a normalized predicate.
// Numeric values are normalized to base units (mm for length, mm³ for volume) at
// parse time so the evaluator compares plain numbers. Strict: any unrecognized form
// throws an Error naming the offending string.

const UNIT = { mm: 1, cm: 10, mm3: 1, cm3: 1000 };

function toBase(numStr, unit) {
  const n = Number(numStr);
  if (!Number.isFinite(n)) throw new Error(`assertion: not a number: "${numStr}"`);
  if (unit === undefined) return n;
  if (!(unit in UNIT)) throw new Error(`assertion: unknown unit: "${unit}"`);
  return n * UNIT[unit];
}

const NUM = "[-+]?[0-9]*\\.?[0-9]+";
const U = "(mm3|cm3|mm|cm)?";
const reScalar = new RegExp(`^(>=|<=|>|<)?\\s*(${NUM})\\s*${U}$`);
const reRange = new RegExp(`^(${NUM})\\s*\\.\\.\\s*(${NUM})\\s*${U}$`);
const reVec = /^(>=|<=)\s*\[\s*(.+?)\s*\]$/;

// A vector with no comparison — `[40,40,10]` or `"[40,40,10]"` (or `"=[…]"`) — is the
// commonest slip: the writer means "exactly this size". A vector is only ever
// one-sided, so the error hands back both legal spellings built from the writer's
// own numbers, which is a one-step fix. Returns that hint, or null when `expr` is
// not a bare vector. An exact vector is deliberately not offered: a mesh's box is
// tessellation-dependent (a curved face chords inside its true extent), so no
// tolerance would be honest for every part — a writer who wants both sides
// declares the tolerance themselves with the per-axis range form below.
const reBareVec = /^(?:==?)?\s*\[(.*)\]$/;
const VEC_TAIL = "(componentwise; * skips an axis)";

export function bareVectorHint(expr) {
  let comps;
  if (Array.isArray(expr)) comps = expr.map((c) => String(c).trim());
  else if (typeof expr === "string") {
    const m = expr.trim().match(reBareVec);
    if (!m) return null;
    comps = m[1].split(",").map((t) => t.trim());
    // A component with `..` in it is a range-vector attempt (below), not a bare
    // vector: its own parse error names the right fix, and the two-spelling hint
    // here would send the writer back to a one-sided form.
    if (comps.some((c) => c.includes(".."))) return null;
  } else return null;
  comps = comps.map((c) => c.replace(/\s*mm$/, ""));
  const ok = comps.length === 3 && comps.every((c) => c === "*" || (c !== "" && Number.isFinite(Number(c))));
  if (!ok) return `use "<=[x,y,z]" or ">=[x,y,z]" (exactly 3 plain numbers in mm; componentwise; * skips an axis)`;
  const v = `[${comps.join(",")}]`;
  return `use "<=${v}" or ">=${v}" ${VEC_TAIL}`;
}

const show = (expr) => (typeof expr === "string" ? `"${expr}"` : JSON.stringify(expr));

// The two-sided vector form: a RANGE per axis, `"[28..32, 18..22, 9..11]"`, with `*`
// skipping an axis. The brackets are optional because the bare comma form
// (`"28..32,18..22,9..11"`) is what a model produces when it reaches for this —
// three trials wrote it before the form existed and were told "unrecognized form".
// Components are plain numbers in mm, like the one-sided vectors: a unit suffix
// is refused rather than scaled. Returns null when `s` is not a range-vector
// attempt at all (no `..` inside a bracket pair or comma list), so the other
// forms get their turn; a malformed attempt throws its own error.
const reRangeComp = new RegExp(`^(${NUM})\\s*\\.\\.\\s*(${NUM})$`);
const RANGE_VEC_SHAPE = "exactly 3 components, each a range a..b in mm or *";

function rangeVector(s) {
  const bracketed = s.match(/^\[(.*)\]$/);
  const inner = bracketed ? bracketed[1] : s;
  if (!inner.includes("..") || !inner.includes(",")) return null;
  if (!bracketed && /[\[\]]/.test(s)) return null; // one bracket of a pair — not this form
  const parts = inner.split(",").map((t) => t.trim());
  if (parts.length !== 3) throw new Error(`assertion: a range vector takes ${RANGE_VEC_SHAPE}: "${s}"`);
  const vec = parts.map((t) => {
    if (t === "*") return null;
    const m = t.match(reRangeComp);
    if (!m) throw new Error(`assertion: a range vector takes ${RANGE_VEC_SHAPE}: "${s}"`);
    return [toBase(m[1], undefined), toBase(m[2], undefined)];
  });
  return { op: "vrange", vec };
}

export function parseAssertion(expr) {
  if (typeof expr === "number" || typeof expr === "boolean") return { op: "eq", value: expr };
  const bare = bareVectorHint(expr);
  if (bare) throw new Error(`assertion: a vector needs a comparison, got ${show(expr)} — ${bare}`);
  if (typeof expr !== "string") throw new Error(`assertion: unsupported value ${JSON.stringify(expr)}`);
  const s = expr.trim();

  const vr = rangeVector(s);
  if (vr) return vr;
  const vec = s.match(reVec);
  if (vec) {
    const parts = vec[2].split(",").map((t) => t.trim());
    const plain = (t) => t === "*" || (t !== "" && Number.isFinite(Number(t)));
    if (parts.length !== 3 || !parts.every(plain)) {
      throw new Error(`assertion: a vector takes exactly 3 components, each a plain number in mm or *: "${expr}"`);
    }
    return { op: vec[1] === "<=" ? "vle" : "vge", vec: parts.map((t) => (t === "*" ? null : toBase(t, undefined))) };
  }
  const range = s.match(reRange);
  if (range) return { op: "range", min: toBase(range[1], range[3] || undefined), max: toBase(range[2], range[3] || undefined) };

  const sc = s.match(reScalar);
  if (sc) {
    const op = sc[1] ? { ">=": "gte", "<=": "lte", ">": "gt", "<": "lt" }[sc[1]] : "eq";
    return { op, value: toBase(sc[2], sc[3] || undefined) };
  }
  throw new Error(`assertion: unrecognized form: "${expr}"`);
}

const EPS = 1e-6;
const approxEq = (a, b) => Math.abs(a - b) <= EPS + EPS * Math.abs(b);
const fmtVec = (v) => "[" + v.map((x) => (x === null ? "*" : x)).join(",") + "]";
const fmtRangeVec = (v) => "[" + v.map((c) => (c === null ? "*" : `${c[0]}..${c[1]}`)).join(",") + "]";

export function evaluateAssertion(parsed, actual) {
  switch (parsed.op) {
    case "eq": {
      const pass = typeof parsed.value === "boolean" ? actual === parsed.value : approxEq(actual, parsed.value);
      return { pass, message: `${actual} ${pass ? "==" : "!="} ${parsed.value}` };
    }
    case "gte": return mk(actual >= parsed.value - EPS, actual, ">=", parsed.value);
    case "lte": return mk(actual <= parsed.value + EPS, actual, "<=", parsed.value);
    case "gt": return mk(actual > parsed.value, actual, ">", parsed.value);
    case "lt": return mk(actual < parsed.value, actual, "<", parsed.value);
    case "range": {
      const pass = actual >= parsed.min - EPS && actual <= parsed.max + EPS;
      return { pass, message: `${actual} ${pass ? "in" : "out of"} ${parsed.min}..${parsed.max}` };
    }
    case "vle":
    case "vge": {
      const ge = parsed.op === "vge";
      let pass = true;
      for (let i = 0; i < 3; i++) {
        const lim = parsed.vec[i];
        if (lim === null) continue;
        if (ge ? actual[i] < lim - EPS : actual[i] > lim + EPS) pass = false;
      }
      return { pass, message: `${fmtVec(actual)} ${ge ? ">=" : "<="} ${fmtVec(parsed.vec)}` };
    }
    case "vrange": {
      let pass = true;
      for (let i = 0; i < 3; i++) {
        const band = parsed.vec[i];
        if (band === null) continue;
        if (actual[i] < band[0] - EPS || actual[i] > band[1] + EPS) pass = false;
      }
      return { pass, message: `${fmtVec(actual)} ${pass ? "in" : "out of"} ${fmtRangeVec(parsed.vec)}` };
    }
    default: throw new Error(`assertion: unknown op "${parsed.op}"`);
  }
}

function mk(pass, actual, opStr, value) {
  return { pass, message: `${actual} ${pass ? opStr : "not " + opStr} ${value}` };
}

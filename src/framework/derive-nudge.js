// Sampling-based derive attribution, used only to RANK controls (orderedReads);
// never to decide what rebuilds. Worker-side leaf: no DOM, no node:.
//
// A single-function derive attributes every derived value to every input it read
// (derive.js attributed()). This nudges each numeric/boolean input once, re-runs
// derive, and records which leaf paths of the output moved.
import { resolveDerived } from "./derive.js";
import { recorder } from "./read-recorder.js";

const isPlain = (v) => {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// Every non-function leaf of arrays / plain objects, keyed by dot-joined path.
function leaves(value, prefix, out) {
  if (typeof value === "function") return out;
  if (isPlain(value)) {
    for (const k of Object.keys(value)) leaves(value[k], prefix === "" ? k : `${prefix}.${k}`, out);
    return out;
  }
  out.set(prefix, value);
  return out;
}

const differs = (a, b) => typeof a !== typeof b || !Object.is(a, b);

export function nudgeAttribution(
  part,
  p,
  { steps = new Map(), budgetMs = 10, maxCalls = 64, now = () => performance.now() } = {},
) {
  if (!part || typeof part.derive !== "function") return null;
  const seen = new Set();
  const t0 = now();
  const baseOut = resolveDerived(part, recorder(p, seen, { through: false }));
  if (now() - t0 > budgetMs) return null;
  const inputs = [...seen];
  const nudgeable = inputs.filter((k) => typeof p[k] === "number" || typeof p[k] === "boolean");
  if (nudgeable.length > maxCalls) return null;

  const base = leaves(baseOut, "", new Map());
  const depsOfPath = new Map();
  const add = (path, key) => {
    let s = depsOfPath.get(path);
    if (!s) depsOfPath.set(path, (s = new Set()));
    s.add(key);
  };
  const addAll = (key) => {
    for (const path of base.keys()) add(path, key);
  };

  for (const key of inputs) {
    const v = p[key];
    let next;
    if (typeof v === "boolean") next = !v;
    else if (typeof v === "number") next = v + (steps.get(key) ?? (v !== 0 ? 1e-3 * Math.abs(v) : 1e-3));
    else {
      addAll(key);
      continue;
    }
    let out;
    try {
      out = leaves(resolveDerived(part, { ...p, [key]: next }), "", new Map());
    } catch {
      addAll(key);
      continue;
    }
    for (const [path, a] of base) if (!out.has(path) || differs(a, out.get(path))) add(path, key);
  }

  const depsForPath = (path) => {
    let union = null;
    for (const [k, set] of depsOfPath) {
      if (k === path || k.startsWith(`${path}.`)) {
        union ??= new Set();
        for (const x of set) union.add(x);
      }
    }
    return union;
  };
  return { depsOfPath, inputs, depsForPath };
}

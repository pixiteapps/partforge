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
  { steps = new Map(), budgetMs = 10, totalMs = 40, maxCalls = 64, now = () => performance.now() } = {},
) {
  // `budgetMs` bounds the first derive call (a slower one skips the pass);
  // `totalMs` bounds the whole pass, which runs once per generate job on the
  // worker's build path. Past it the inputs not yet nudged count as inputs to
  // every output, as a non-numeric one does.
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
    if (now() - t0 > totalMs) {
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

  // Every leaf's deps, unioned into each of its path's prefixes once, so a lookup
  // (orderedReads makes one per { path } log entry) is a Map hit, not a scan.
  const byPrefix = new Map();
  for (const [leaf, set] of depsOfPath) {
    const segs = leaf.split(".");
    let prefix = "";
    for (const seg of segs) {
      prefix = prefix === "" ? seg : `${prefix}.${seg}`;
      let union = byPrefix.get(prefix);
      if (!union) byPrefix.set(prefix, (union = new Set()));
      for (const x of set) union.add(x);
    }
  }
  // Every path the derive's output holds: its leaves and their prefixes.
  const known = new Set();
  for (const leaf of base.keys()) {
    let end = leaf.length;
    while (end > 0 && !known.has(leaf.slice(0, end))) {
      known.add(leaf.slice(0, end));
      end = leaf.lastIndexOf(".", end - 1);
    }
  }
  // A path the output holds answers for itself: its inputs, or none when no
  // nudge moved it (a constant). A path it does not hold - `pts.length`,
  // `pts.map`, a member of a leaf object - answers as its nearest held parent,
  // so iterating a derived array ranks by that array's inputs. Null only when
  // no part of the path is in the output (the recorded attribution stands in).
  const NONE = new Set();
  const depsForPath = (path) => {
    for (let q = path; ; ) {
      const hit = byPrefix.get(q);
      if (hit) return hit;
      if (known.has(q)) return NONE;
      const cut = q.lastIndexOf(".");
      if (cut < 0) return null;
      q = q.slice(0, cut);
    }
  };
  return { depsOfPath, inputs, depsForPath };
}

// Provenance: which params each face run of a build was made from.
//
// While a part's build(k, p, d) runs through provenanceKernel(k, prov), every
// author-facing kernel or Solid op call that returns a Solid is a BOUNDARY: the
// params read since the previous boundary (an ordered read log, expanded by
// `expand`) are attached to the face runs that op minted or moved. Records are
// keyed by run lineage (runKey(id, mat), run-lineage.js) and read back per
// triangle at mesh time (originsFor), matched by id and a 1e-3 transform
// tolerance — runKey's 1e-4 rounding can split a structural transform from the
// kernel's float32 one, so it is only the storage key.
//
// A Proxy rather than a backend hook: the solid cache returns the same wrapper on
// a hit without re-running the op, and the backend calls its own ops internally
// (replay, hoisting, fillet tools, label's chain). The proxy sees exactly the
// author's calls, hit or miss. Boundaries read `_runs()` only — never getMesh().
//
// Pure leaf: imports only run-lineage.js.

import { IDENTITY12, runKey } from "./run-lineage.js";

export const TRANSFORM_OPS = new Set([
  "translate", "rotate", "mirror", "scale", "rotateX", "rotateY", "rotateZ", "rotateAbout", "along", "at",
]);

const MAT_TOL = 1e-3;

const isSolid = (v) => v != null && typeof v === "object" && typeof v._runs === "function";
const isPlainObject = (v) => v != null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

// Newest first, each key once (its first, i.e. newest, occurrence).
const dedupe = (keys) => [...new Set(keys)];

// Solids among an op's arguments: direct, one level into arrays, and the values
// of a plain options object.
function solidsIn(args) {
  const out = [];
  for (const a of args) {
    if (isSolid(a)) out.push(a);
    else if (Array.isArray(a)) { for (const x of a) if (isSolid(x)) out.push(x); }
    else if (isPlainObject(a)) { for (const x of Object.values(a)) if (isSolid(x)) out.push(x); }
  }
  return out;
}

const maxDiff = (a, b) => {
  let d = 0;
  for (let i = 0; i < 12; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};

export function createProvenance({ log, expand }) {
  const table = new Map(); // runKey -> keys newest first
  const byId = new Map(); // run id -> Map<runKey, { mat, key }>
  let mark = log.length; // log position the next boundary's slice starts at
  const allOrigins = []; // every distinct record originsFor has handed out this build
  const allSigs = new Set();

  const set = (id, mat, keys) => {
    const key = runKey(id, mat);
    table.set(key, keys);
    let entries = byId.get(id);
    if (!entries) byId.set(id, (entries = new Map()));
    entries.set(key, { mat: mat ?? IDENTITY12, key });
  };
  const recordOf = (id, mat) => table.get(runKey(id, mat)) ?? [];

  function boundary(op, receiver, args, run) {
    const result = run();
    if (!isSolid(result)) return result; // reads keep accumulating to the next Solid op
    const slice = expand(log.slice(mark));
    mark = log.length;
    if (slice === null) return result; // an enumeration: unknowable, record nothing
    const runs = result._runs();
    if (TRANSFORM_OPS.has(op) && isSolid(receiver)) {
      const inRuns = receiver._runs();
      runs.forEach((r, i) => {
        const src = inRuns[i];
        set(r.id, r.mat, dedupe([...slice, ...(src ? recordOf(src.id, src.mat) : [])]));
      });
      return result;
    }
    const inputs = [...(isSolid(receiver) ? [receiver] : []), ...solidsIn(args)];
    const inputKeys = new Set(inputs.flatMap((s) => s._runs().map((r) => runKey(r.id, r.mat))));
    let oldOf = null;
    if (result._idMap instanceof Map) {
      oldOf = new Map();
      for (const [oldId, newId] of result._idMap) oldOf.set(newId, oldId);
    }
    for (const r of runs) {
      if (inputKeys.has(runKey(r.id, r.mat))) continue;
      const oldId = oldOf?.get(r.id);
      set(r.id, r.mat, dedupe([...slice, ...(oldId !== undefined ? recordOf(oldId, r.mat) : [])]));
    }
    return result;
  }

  // The record for one mesh run: same id and nearest transform within MAT_TOL,
  // else the id's only record whatever its transform, else none.
  function lookup(id, mat) {
    const entries = byId.get(id);
    if (!entries) return null;
    let best = null, bestD = Infinity;
    for (const e of entries.values()) {
      const d = maxDiff(e.mat, mat);
      if (d <= MAT_TOL && d < bestD) { best = e; bestD = d; }
    }
    if (!best && entries.size === 1) best = entries.values().next().value;
    return best ? table.get(best.key) : null;
  }

  // Per-triangle origin indices for a Manifold MeshGL: { originIds, origins }, or
  // null when no triangle carries a non-empty record.
  function originsFor(g) {
    const ri = g.runIndex, ids = g.runOriginalID, rt = g.runTransform;
    const nTri = ((g.triVerts?.length ?? 0) / 3) | 0;
    if (!ri || !ids || nTri === 0) return null;
    const originIds = new Uint16Array(nTri);
    const origins = [];
    const indexOf = new Map(); // record content -> 1-based index
    let any = false;
    for (let r = 0; r < ids.length; r++) {
      const mat = rt && rt.length >= (r + 1) * 12 ? Array.prototype.slice.call(rt, r * 12, r * 12 + 12) : IDENTITY12;
      const rec = lookup(ids[r], mat);
      if (!rec || rec.length === 0) continue;
      const sig = rec.join("\u0000");
      let idx = indexOf.get(sig);
      if (idx === undefined) {
        if (origins.length >= 0xffff) continue;
        origins.push(rec.slice());
        idx = origins.length;
        indexOf.set(sig, idx);
        if (!allSigs.has(sig)) { allSigs.add(sig); allOrigins.push(rec.slice()); }
      }
      const t0 = (ri[r] / 3) | 0, t1 = Math.min(nTri, (ri[r + 1] / 3) | 0);
      for (let t = t0; t < t1; t++) originIds[t] = idx;
      if (t1 > t0) any = true;
    }
    return any ? { originIds, origins } : null;
  }

  return { boundary, originsFor, table, origins: allOrigins };
}

// A Proxy over `kernel` whose author-facing ops (function-valued, not `_`-prefixed)
// are provenance boundaries, and whose Solid results are proxied the same way.
export function provenanceKernel(kernel, prov) {
  const targetOf = new WeakMap(); // proxy -> wrapper
  const proxyOf = new WeakMap(); // wrapper -> proxy

  const unwrap = (v) => targetOf.get(v) ?? v;
  const unwrapArg = (a) => {
    if (a == null || typeof a !== "object") return a;
    if (targetOf.has(a)) return targetOf.get(a);
    if (Array.isArray(a)) return a.some((x) => targetOf.has(x)) ? a.map(unwrap) : a;
    if (isPlainObject(a) && Object.values(a).some((x) => targetOf.has(x))) {
      const o = {};
      for (const [key, x] of Object.entries(a)) o[key] = unwrap(x);
      return o;
    }
    return a;
  };
  const wrapResult = (r) => (isSolid(r) ? solidProxy(r) : r);

  function solidProxy(s) {
    let p = proxyOf.get(s);
    if (p) return p;
    p = new Proxy(s, {
      get(t, name) {
        const v = Reflect.get(t, name);
        if (typeof v !== "function") return v;
        if (typeof name !== "string" || name.startsWith("_")) return v.bind(t);
        return (...args) => {
          const raw = args.map(unwrapArg);
          return wrapResult(prov.boundary(name, t, raw, () => v.apply(t, raw)));
        };
      },
    });
    proxyOf.set(s, p);
    targetOf.set(p, s);
    return p;
  }

  return new Proxy(kernel, {
    get(t, name) {
      const v = Reflect.get(t, name);
      if (typeof v !== "function" || typeof name !== "string" || name.startsWith("_")) return v;
      return (...args) => {
        const raw = args.map(unwrapArg);
        return wrapResult(prov.boundary(name, null, raw, () => v.apply(t, raw)));
      };
    },
  });
}

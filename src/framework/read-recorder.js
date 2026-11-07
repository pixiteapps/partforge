// Read recording shared by the relevance PREDICTION (param-deps.js, against the
// probe kernel) and the REAL build path (part-model.js resolveParams, jobs.js,
// the oracle). A LEAF: no imports, so part-model.js may depend on it.
//
// Three traps record: get (p.x), has ("x" in p), ownKeys (Object.keys / spread /
// entries / JSON.stringify — enumerating p makes the result depend on every key).
// Default: a shallow CLONE, so a probe build can't mutate the caller's params.
// `through: true` wraps the object itself — the real path, where derive() and
// build() must see each other's writes exactly as they did unrecorded.
const SKIP = (key) => typeof key !== "string" || key === "then" || key === "toJSON";
const DEEP_MAX = 3;

// A value the deep recorder may wrap: an array or plain object (null prototype
// included) with no function-valued own property. Anything else - a posed limb,
// a class instance - is used by identity elsewhere, so it is returned raw.
function wrappable(v) {
  if (v === null || typeof v !== "object") return false;
  if (!Array.isArray(v)) {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
  }
  for (const k of Reflect.ownKeys(v)) {
    const desc = Object.getOwnPropertyDescriptor(v, k);
    if (desc && typeof desc.value === "function") return false;
  }
  return true;
}

// `log` (optional): an ordered list of every read - a key string, "*" for an
// enumeration, or with `deep` a { path } for a derived read. `deep` wraps
// nested arrays/plain objects (up to DEEP_MAX levels) so a leaf read logs its
// full path; a nested read replaces its parent's entry in the log.
export function recorder(obj, seen, { through = false, log = null, deep = false } = {}) {
  const cache = new Map();
  const proxyFor = (target, prefix, depth) => {
    const nested = prefix !== null;
    // Records a read of `key`; returns its path, or null for an untracked key.
    const note = (key) => {
      if (SKIP(key)) return null;
      const path = nested ? `${prefix}.${key}` : key;
      if (!nested) seen.add(key);
      if (log) {
        if (nested) {
          for (let i = log.length - 1; i >= 0; i--) {
            if (typeof log[i] === "object" && log[i].path === prefix) {
              log.splice(i, 1);
              break;
            }
          }
        }
        log.push(deep ? { path } : path);
      }
      return path;
    };
    return new Proxy(target, {
      get(t, key) {
        const path = note(key);
        const value = Reflect.get(t, key);
        if (deep && path !== null && depth < DEEP_MAX && wrappable(value)) {
          let hit = cache.get(path);
          if (!hit || hit.target !== value) {
            hit = { target: value, proxy: proxyFor(value, path, depth + 1) };
            cache.set(path, hit);
          }
          return hit.proxy;
        }
        return value;
      },
      has(t, key) {
        note(key);
        return Reflect.has(t, key);
      },
      ownKeys(t) {
        const keys = Reflect.ownKeys(t);
        if (!nested) for (const k of keys) if (typeof k === "string") seen.add(k);
        if (log) log.push(nested ? { path: prefix } : "*");
        return keys;
      },
    });
  };
  return proxyFor(through ? obj : { ...obj }, null, 0);
}

// One build's reads: raw param keys, derived keys, and the derive attribution
// that maps the second onto the first (set by resolveParams).
export function newReadSink() {
  return { raw: new Set(), dSeen: new Set(), attribution: null, log: [] };
}

// Raw params behind a build's reads. With no per-key attribution (single-function
// derive, or a key no group produced) every derive input counts — coarser, sound.
export function expandDerivedReads(raw, dSeen, attribution) {
  const out = new Set(raw);
  if (dSeen.size === 0) return out;
  const depsOf = attribution?.depsOf;
  if (depsOf && [...dSeen].every((k) => depsOf.has(k))) {
    for (const k of dSeen) for (const dep of depsOf.get(k)) out.add(dep);
  } else {
    for (const dep of attribution?.allInputs ?? []) out.add(dep);
  }
  return out;
}

export function expandReads(sink) {
  return [...expandDerivedReads(sink.raw, sink.dSeen, sink.attribution)].sort();
}

// The raw param keys a build read, newest first, each once (its newest read). A
// { path } entry expands to the derive inputs behind it: nudged.depsForPath(path),
// else the attribution's depsOf for the path's top key, else every derive input.
// Keys from one entry share its position and sort by `order` (param keys), else by
// allInputs order. Any enumeration ("*") makes the answer unknowable: null.
export function orderedReads(log, { nudged = null, attribution = null, order = null } = {}) {
  const all = [...(attribution?.allInputs ?? [])];
  const rank = new Map((order ?? all).map((k, i) => [k, i]));
  const seen = new Set();
  const out = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e === "*") return null;
    if (typeof e === "string") {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
      continue;
    }
    const top = e.path.split(".")[0];
    const deps = nudged?.depsForPath(e.path) ?? attribution?.depsOf?.get(top) ?? all;
    const keys = [...deps].filter((k) => !seen.has(k));
    keys.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
    for (const k of keys) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

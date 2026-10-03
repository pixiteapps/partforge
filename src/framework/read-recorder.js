// Read recording shared by the relevance PREDICTION (param-deps.js, against the
// probe kernel) and the REAL build path (part-model.js resolveParams, jobs.js,
// the oracle). A LEAF: no imports, so part-model.js may depend on it.
//
// Three traps record: get (p.x), has ("x" in p), ownKeys (Object.keys / spread /
// entries / JSON.stringify — enumerating p makes the result depend on every key).
// Default: a shallow CLONE, so a probe build can't mutate the caller's params.
// `through: true` wraps the object itself — the real path, where derive() and
// build() must see each other's writes exactly as they did unrecorded.
export function recorder(obj, seen, { through = false } = {}) {
  return new Proxy(through ? obj : { ...obj }, {
    get(target, key) {
      if (typeof key === "string" && key !== "then" && key !== "toJSON") seen.add(key);
      return Reflect.get(target, key);
    },
    has(target, key) {
      if (typeof key === "string" && key !== "then" && key !== "toJSON") seen.add(key);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      for (const k of keys) if (typeof k === "string") seen.add(k);
      return keys;
    },
  });
}

// One build's reads: raw param keys, derived keys, and the derive attribution
// that maps the second onto the first (set by resolveParams).
export function newReadSink() {
  return { raw: new Set(), dSeen: new Set(), attribution: null };
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

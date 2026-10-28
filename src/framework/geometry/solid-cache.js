// Worker-side cache of boundary-op solids, partitioned per sub-part. Retention is
// bounded to the CURRENT build's graph: each begin()/end() bracket rebuilds a
// sub-part's retained set from scratch, disposing any entry not re-used this round.
// Partitions bound RETENTION, never reuse: a `index` keyed by hash spans them all, so
// geometry one sub-part builds is adopted by the next rather than rebuilt (a sheet of
// identical cells split across row sub-parts paid that rebuild per row). An adopted
// entry is retained by BOTH partitions, so disposal is refcounted — see release().
// WASM-agnostic — it stores opaque {value, pin, dispose} triples supplied by the
// caller (the Manifold backend), so it is unit-testable with plain objects.
//
// MEMORY BUDGET (feedback #212). Retaining a whole view's build graph is what makes an
// edit rebuild in seconds, and it is also most of the heap a big view holds: opening a
// 105-plate forge peaked at 3.3 GB with the cache and 0.95 GB without, which a phone's
// browser tab cannot hold. `setBudget(bytes)` bounds it; `trim()` then disposes whole
// partitions, least recently built first, until the retained solids fit. A sub-part
// trimmed away simply rebuilds cold next time. `sizeOf(pin)` is the caller's estimate
// of one retained object's bytes (the Manifold backend reads its triangle and vertex
// counts); it is asked once per entry, at the first trim() after the entry was made.
//
// trim() is NOT done inside end(): a caller may still be using a round's solids after
// closing it (buildView hands its built view to measure), and a trim there would free
// them under it. jobs.js trims where nothing is held — after each display sub-part has
// been meshed and cleaned up, and when a job ends.
export function createSolidCache({ sizeOf = () => 0 } = {}) {
  const caches = new Map(); // name -> Map(hash -> { value, pin, dispose, refs })
  const pinned = new Set();  // every live `pin` across all sub-parts
  const index = new Map();   // hash -> entry, ACROSS partitions: identical geometry built
                             // for one sub-part is reused by every other (see lookup).
  const lastBuilt = new Map(); // name -> rebind generation of the partition's last begin()
  let generation = 0;          // bumped only by sweep() (i.e. per part rebind)
  let name = null, active = null, prev = null;
  let depth = 0;               // bracket nesting; only the OUTERMOST one is real (see begin)
  let hits = 0, misses = 0;
  let budget = Infinity;       // bytes the retained solids may hold (setBudget)
  let bytes = 0;               // the retained solids' estimated size, each entry once
  let tick = 0;                // begin() order, for least-recently-built eviction
  const lastUsed = new Map();  // name -> tick of the partition's last begin()
  const unsized = new Set();   // entries made since the last trim(), size not yet read

  // One partition stops retaining `entry`. Disposal waits for the LAST holder:
  // a solid shared across sub-parts is one WASM object, so disposing it when the
  // first partition drops it would leave every other partition — and the shared
  // index — pointing at freed memory. Dropping the index entry in the same breath
  // is what keeps the cache from handing out a disposed solid later.
  const release = (hash, entry) => {
    if (--entry.refs > 0) return;
    if (index.get(hash) === entry) index.delete(hash);
    pinned.delete(entry.pin);
    unsized.delete(entry);
    bytes -= entry.size ?? 0;
    entry.dispose();
  };
  const dropPartition = (n) => {
    for (const [hash, entry] of caches.get(n) ?? []) release(hash, entry); // refcounted: a shared solid survives
    caches.delete(n);
    lastBuilt.delete(n);
    lastUsed.delete(n);
  };

  return {
    // Nested brackets collapse into the outermost one. There is a single open
    // round (name/active/prev), not a stack, so an inner begin() would otherwise
    // rebind it and the inner end() would commit-and-close the OUTER round early —
    // evicting its entries and leaving the rest of that build uncached. Callers
    // nest legitimately now that buildView brackets: an outer bracket is free to
    // contain one, and the inner pair becomes a no-op.
    begin(n) {
      if (depth++ > 0) return;
      name = n; lastBuilt.set(n, generation); lastUsed.set(n, ++tick); prev = caches.get(n) ?? new Map(); active = new Map();
    },

    end() {
      if (depth > 0 && --depth > 0) return; // inner bracket — the outer one still owns the round
      if (name == null) return;
      for (const [hash, entry] of prev) {
        if (!active.has(hash)) release(hash, entry); // this partition drops it
      }
      caches.set(name, active);
      name = null; active = prev = null;
    },

    // Rebind hygiene: called once per setPart() (never mid-bracket — the worker's
    // job queue is serial). Partitions a rebind renamed or deleted would otherwise
    // pin their last build's solids until worker death; three idle generations is
    // the eviction line, so recently-viewed views stay warm across edits.
    sweep() {
      generation++;
      for (const n of [...caches.keys()]) {
        if (generation - (lastBuilt.get(n) ?? 0) < 3) continue;
        dropPartition(n);
      }
    },

    // Drop EVERY partition, whatever its age — the next build of each sub-part is
    // cold. The worker calls this before an export (feedback #212): the display
    // build's retained solids and the export's own print-quality build share one
    // WASM heap, and on a 105-plate forge the display cache alone held ~1.75 GB,
    // so the export ran out of heap after a few plates on a phone. Like sweep(),
    // never mid-bracket — the worker's job queue is serial.
    clear() {
      for (const entries of caches.values()) {
        for (const [hash, entry] of entries) release(hash, entry); // refcounted: each partition lets go once
      }
      caches.clear();
      lastBuilt.clear();
      lastUsed.clear();
    },

    // Bytes the retained solids may hold; Infinity (the default) never trims.
    setBudget(b) {
      budget = typeof b === "number" && b >= 0 ? b : Infinity;
    },

    // Dispose whole partitions, least recently built first, until the retained solids
    // fit the budget. Never mid-bracket, and only where no caller holds a cached solid
    // (see the header). Returns how many partitions it dropped.
    trim() {
      if (name != null) return 0;
      for (const entry of unsized) {
        let s = 0;
        try { s = Math.max(0, Number(sizeOf(entry.pin)) || 0); } catch { s = 0; }
        entry.size = s;
        bytes += s;
      }
      unsized.clear();
      let dropped = 0;
      while (bytes > budget && lastUsed.size > 0) {
        let oldest = null, at = Infinity;
        for (const [n, t] of lastUsed) if (t < at) { at = t; oldest = n; }
        dropPartition(oldest);
        dropped++;
      }
      return dropped;
    },

    lookup(hash, make) {
      if (name == null) return make().value; // not bracketed → no caching
      if (active.has(hash)) { hits++; return active.get(hash).value; }
      if (prev.has(hash)) { hits++; const e = prev.get(hash); active.set(hash, e); return e.value; }
      // Another sub-part already built this exact solid — adopt it. `refs` rises
      // because a second partition now retains it; see release().
      if (index.has(hash)) { hits++; const e = index.get(hash); e.refs++; active.set(hash, e); return e.value; }
      misses++;
      const entry = make();
      entry.refs = 1;
      unsized.add(entry);
      active.set(hash, entry);
      index.set(hash, entry);
      pinned.add(entry.pin);
      return entry.value;
    },

    isPinned: (pin) => pinned.has(pin),
    stats: () => ({ hits, misses }),
    retainedBytes: () => bytes,
    resetStats: () => { hits = 0; misses = 0; },
  };
}

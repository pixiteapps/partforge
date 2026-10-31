// The preview sample cache: a bounded LRU of leaf samples, keyed by sparse.js's leafKeys —
// a leaf's program bytes, texture digests, first world cell, grid edge and owner count. A
// preview build anchors its grid to a world lattice (planLeaves `anchor`), so after a pose
// change the leaves the change did not reach key the same and take their float32 samples
// (and owners) from here instead of evaluating: the same bytes a cold build samples, so a
// warm build meshes byte for byte what a cold one does. One cache per preview kernel; the
// print/export tier never anchors and never caches.
//
// Pure and DOM-free (the geometry worker holds it). LRU by Map re-insertion on `get`; `put`
// evicts the oldest entries until the cache is back inside its byte bound.
export { leafKeys, programDigest } from "./sparse.js";

/** The default byte bound: 64 MiB of samples (~130k plain leaves). */
export const SAMPLE_CACHE_BYTES = 64 * 2 ** 20;

/**
 * What an entry is charged: 125 float32 samples, plus 125 owner bytes on an owner leaf. The
 * bound counts this sample payload only, so it is approximate: typed-array headers, key
 * strings and Map overhead are not counted.
 */
const entryBytes = (e) => 500 + (e.owner ? 125 : 0);

/**
 * createSampleCache({ maxBytes }) → { get, put, has, bytes, size, clear, stats, resetStats }.
 * An entry is `{ vals: Float32Array(125), owner: Int8Array(125) | null }`, shared, never
 * copied — callers must not write it.
 */
export function createSampleCache({ maxBytes = SAMPLE_CACHE_BYTES } = {}) {
  const map = new Map();
  let bytes = 0, hits = 0, misses = 0;
  const drop = (key) => {
    const e = map.get(key);
    if (e === undefined) return;
    map.delete(key);
    bytes -= entryBytes(e);
  };
  return {
    get(key) {
      const e = map.get(key);
      if (e === undefined) { misses++; return undefined; }
      hits++;
      map.delete(key);
      map.set(key, e);   // most recently used last
      return e;
    },
    put(key, entry) {
      drop(key);
      map.set(key, entry);
      bytes += entryBytes(entry);
      for (const oldest of map.keys()) {
        if (bytes <= maxBytes) break;
        drop(oldest);
      }
    },
    has: (key) => map.has(key),
    get bytes() { return bytes; },
    get size() { return map.size; },
    clear() { map.clear(); bytes = 0; },
    stats: () => ({ hits, misses }),
    resetStats() { hits = 0; misses = 0; },
  };
}

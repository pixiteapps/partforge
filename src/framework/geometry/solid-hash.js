// Stable content hash for cached solids. Serializes scalar args canonically and
// folds via FNV-1a → base36. Solid operands are passed as their own (already
// computed) short `_hash` string, so composing two solids stays O(1) and the
// resulting key length stays bounded no matter how deep the build graph is.

// Optional hash-graph recording for the oracle's change tracker
// (oracle/changes.js). Off by default — `h` pays one null check. While on, every
// call records its result with the op name and the operand hashes it consumed, so
// the tracker can tell WHICH op first produced a different hash between two builds.
// Single-threaded by construction (one worker, one synchronous build).
let recording = null; // { map, limit, overflow }

export function startHashRecording({ limit = 20000 } = {}) {
  recording = { map: new Map(), limit, overflow: false };
}

export function stopHashRecording() {
  const r = recording;
  recording = null;
  if (!r || r.overflow) return null;
  return r.map;
}

const stringLeaves = (x, out) => {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const y of x) stringLeaves(y, out);
  return out;
};

export function h(...parts) {
  const out = fnv(parts.map(canon).join("|"));
  if (recording && !recording.overflow) {
    const { map } = recording;
    if (map.size >= recording.limit) recording.overflow = true;
    else if (!map.has(out)) {
      const op = typeof parts[0] === "string" ? parts[0] : null;
      const inputs = stringLeaves(parts.slice(1), []).filter((s) => map.has(s));
      map.set(out, { op, inputs, label: op === "label" && typeof parts[2] === "string" ? parts[2] : null });
    }
  }
  return out;
}

function canon(x) {
  if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
  if (x && typeof x === "object") return "{" + Object.keys(x).sort().map((k) => k + ":" + canon(x[k])).join(",") + "}";
  return String(x);
}

// FNV-1a folded to 32-bit space (collision risk acceptable: retained only for one
// sub-part's build graph ~3–15 nodes, rebuilt each round, no accumulation).
function fnv(s) {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { hsh ^= s.charCodeAt(i); hsh = Math.imul(hsh, 0x01000193); }
  return (hsh >>> 0).toString(36);
}

// ── byte-aware JSON.stringify support ───────────────────────────────────────
// A shared home for param-deps.js's relevanceHash, backend-select.js's
// reroute-latch snapshot, and oracle/verify.js's memo signature — none of
// which should import one another's concerns. All three wholesale-hash a
// params object with JSON.stringify, and a byte-valued param — an
// ArrayBuffer, a SharedArrayBuffer, or a typed-array/DataView view
// (Buffer included — the shape a param-supplied image takes on the
// partforge-cloud sandbox path, which cannot fetch URLs and puts PNG bytes
// straight into a param, and the shape `fs.readFileSync` hands the CLI) —
// breaks JSON.stringify's default handling two different ways: an
// ArrayBuffer/SharedArrayBuffer has no enumerable own properties, so it
// always serializes as the same "{}" regardless of content (two different
// images collide on one cache/route key); a typed-array VIEW goes the other
// way, expanding to one JSON number per byte (tens of thousands of
// characters for a small PNG, on every hash). `byteAwareReplacer` is a
// JSON.stringify replacer — pass it as the second argument — that
// substitutes a stable content fingerprint for any of these shapes instead.
//
// MUST be a plain function, not an arrow: JSON.stringify calls the replacer
// with `this` bound to the holder (the object/array currently being
// serialized), and `this[key]` is how a replacer recovers the RAW value —
// before `Buffer.prototype.toJSON()` (or any other .toJSON) has already run
// on it. `value`, the second argument, has ALREADY been through that
// conversion: for a Node Buffer, `value` here is
// `{type:"Buffer",data:[...]}`, JSON.stringify's default expansion, one
// number per byte — exactly the pathology this function exists to avoid,
// reached through a different door. `this[key]` bypasses toJSON entirely, an
// ordinary property read of the holder returns whatever object is actually
// stored there.
export function byteAwareReplacer(key, value) {
  const raw = this ? this[key] : value;
  return isByteish(raw) ? fingerprintBytes(raw) : value;
}

// Object.prototype.toString.call(...), not `instanceof`/typed-array
// constructor checks: `instanceof ArrayBuffer` is false for an ArrayBuffer
// from another realm (a different vm context/iframe/worker — Node's `vm`
// module and Electron both make this reachable), and it silently falls back
// to the original bug ("{}") rather than throwing. The [[Class]] internal
// slot Object.prototype.toString reads is realm-independent.
// `ArrayBuffer.isView` itself IS already realm-independent (it checks for a
// [[ViewedArrayBuffer]] internal slot, not a prototype chain), so it is kept
// as-is for the view case — including a Buffer, which is a Uint8Array
// subclass and so already passes it.
function isByteish(v) {
  if (v === null || typeof v !== "object") return false;
  if (ArrayBuffer.isView(v)) return true;
  const tag = Object.prototype.toString.call(v);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
}

// Memoized per buffer/view IDENTITY (not content) in a WeakMap, mirroring
// kernel-front.js's byteCache: the params object these callers hash is
// mutated in place and re-hashed on every regen (mesh-cache.js's hashFor, a
// backend-select reroute check), so re-walking megabytes of image bytes on
// every slider tick that touches some OTHER param would be its own
// regression. A given buffer is fingerprinted once and the string reused for
// as long as that identity survives.
const byteFingerprints = new WeakMap(); // ArrayBuffer|SharedArrayBuffer|ArrayBufferView -> fingerprint string

// Two independent FNV-1a streams over the same bytes (different offset
// bases, same prime), concatenated — a cheap ~64-bit fold. A single 32-bit
// fold (what h() uses, and what this used through fix round 1) collides at
// ~2⁻³² for two same-length buffers, which is fine for h(): that graph is
// rebuilt fresh every build, nothing accumulates. This fingerprint is
// different — it is retained in the mesh cache for a whole session — so a
// collision here means silently stale geometry, the exact failure class
// fix round 1 existed to eliminate. Widening makes it negligible instead of
// merely unlikely.
function fnvBytes64(u8) {
  let h1 = 0x811c9dc5;      // FNV-1a's standard 32-bit offset basis
  let h2 = 0x9e3779b9;      // a distinct, unrelated 32-bit constant (golden-ratio mix constant)
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    h1 ^= b; h1 = Math.imul(h1, 0x01000193);
    h2 ^= b; h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

function fingerprintBytes(value) {
  let cached = byteFingerprints.get(value);
  if (cached !== undefined) return cached;
  const u8 = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value); // ArrayBuffer or SharedArrayBuffer
  // "bytes:" prefix plus the raw byte length folded in alongside the ~64-bit
  // digest. No ordinary control value is a string shaped exactly like this
  // (the panel's own control types are numbers/booleans/strings/enums), so
  // this fingerprint only ever competes with OTHER buffers' fingerprints,
  // not a genuine string param's value.
  cached = `bytes:${fnvBytes64(u8)}:${u8.length}`;
  byteFingerprints.set(value, cached);
  return cached;
}

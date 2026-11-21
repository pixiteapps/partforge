// Provenance: which params each face run of a build was made from.
//
// While a part's build(k, p, d) runs through provenanceKernel(k, prov), every
// author-facing kernel or Solid op call that returns a Solid is a BOUNDARY: the
// params read since the previous boundary (an ordered read log, expanded by
// `expand`) are attached to the face runs that op minted or moved. Records are
// keyed by run lineage (runKey(id, mat), run-lineage.js) and matched — at a
// boundary against its inputs' runs and at mesh time per triangle (originsFor) —
// by id and a 1e-3 transform tolerance: runKey's 1e-4 rounding can split a
// structural transform from the kernel's float32 one, so it is only the storage key.
//
// A Proxy rather than a backend hook: the solid cache returns the same wrapper on
// a hit without re-running the op, and the backend calls its own ops internally
// (replay, hoisting, fillet tools, label's chain). The proxy sees exactly the
// author's calls, hit or miss. Boundaries read `_runs()` only — never getMesh().
// Shape2D results are proxied too, since `shape.extrude(...)` mints a Solid.
//
// A cage body (k.cage … k.subdiv) is one face run, so its faces are told apart another
// way. The cage is proxied too: each extrude / move / scale / rotate is a boundary whose reads go
// to the cage faces that call made or reshaped (found by comparing the cage before and
// after; a face an extrude made also keeps the keys of the faces it grew from), and k.subdiv hands over the limit mesh with each triangle's cage face
// (`_subdivSource`). At mesh time a triangle of that run takes the keys of the cage face
// whose limit triangle sits nearest its centroid, so a click on the fin answers with the
// fin's params even after a boolean has re-cut the skin. The face's own keys come first,
// then the run's (what every face shares: reads before k.subdiv, later moves and cuts).
//
// Pure leaf: imports only run-lineage.js.

import { IDENTITY12, runKey } from "./run-lineage.js";

export const TRANSFORM_OPS = new Set([
  "translate", "rotate", "mirror", "scale", "rotateX", "rotateY", "rotateZ", "rotateAbout", "along", "at",
]);

const MAT_TOL = 1e-3;

const isSolid = (v) => v != null && typeof v === "object" && typeof v._runs === "function";
const isShape2D = (v) => v != null && typeof v === "object" && !!v._shape2d;
const isCage = (v) => v != null && typeof v === "object" && typeof v.snapshot === "function" && typeof v.extrude === "function";
const CAGE_CHANGES = new Set(["extrude", "move", "scale", "rotate"]);
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

// One string per cage face, its four corner positions in order: equal before and after
// a call means the call left the face alone. (The positions themselves, not a weighted
// sum of them: a sum cancels for a stretch that moves two corners one way and two the other.)
function faceShapes(cage) {
  const { points, faces, ids } = cage.snapshot();
  const out = new Map();
  for (let f = 0; f < ids.length; f++) out.set(ids[f], faces[f].map((p) => points[p].join(",")).join(";"));
  return out;
}

// The inverse of a runTransform-layout affine (run-lineage.js), or null when singular.
function invertAffine(m) {
  const [a, b, c, d, e, f, g, h, i, tx, ty, tz] = m;
  const det = a * (e * i - h * f) - d * (b * i - h * c) + g * (b * f - e * c);
  if (!(Math.abs(det) > 1e-12)) return null;
  const s = 1 / det;
  const r = [(e * i - h * f) * s, (h * c - b * i) * s, (b * f - e * c) * s,
    (g * f - d * i) * s, (a * i - g * c) * s, (d * c - a * f) * s,
    (d * h - g * e) * s, (g * b - a * h) * s, (a * e - d * b) * s];
  return [...r, -(r[0] * tx + r[3] * ty + r[6] * tz), -(r[1] * tx + r[4] * ty + r[7] * tz), -(r[2] * tx + r[5] * ty + r[8] * tz)];
}

// (x, y, z) → the cage face of the limit triangle whose centroid is nearest: a hashed
// grid over the centroids, cells about two mean edges wide. A triangle Manifold kept
// whole lands on its own centroid; a cut one lands inside its parent.
function nearestFace({ positions: P, indices: I, triFace }) {
  const n = (I.length / 3) | 0;
  const C = new Float64Array(3 * n);
  let edges = 0;
  for (let t = 0; t < n; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    for (let k = 0; k < 3; k++) C[3 * t + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
    edges += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
  }
  const cell = Math.max(1e-6, (2 * edges) / Math.max(1, n));
  let size = 1;
  while (size < n) size <<= 1;
  const mask = size - 1;
  const slot = (ix, iy, iz) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
  const at = (v) => Math.floor(v / cell);
  const start = new Uint32Array(size + 1), slots = new Uint32Array(n);
  for (let t = 0; t < n; t++) { slots[t] = slot(at(C[3 * t]), at(C[3 * t + 1]), at(C[3 * t + 2])); start[slots[t] + 1]++; }
  for (let s = 0; s < size; s++) start[s + 1] += start[s];
  const fill = start.slice(0, size), order = new Uint32Array(n);
  for (let t = 0; t < n; t++) order[fill[slots[t]]++] = t;
  const exact = (cell * 1e-3) ** 2;
  return (x, y, z) => {
    const ix = at(x), iy = at(y), iz = at(z);
    let best = -1, bestD = Infinity;
    const scan = (s) => {
      for (let o = start[s]; o < start[s + 1]; o++) {
        const t = order[o], dx = C[3 * t] - x, dy = C[3 * t + 1] - y, dz = C[3 * t + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = t; }
      }
    };
    scan(slot(ix, iy, iz));
    if (bestD > exact) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
        if (dx || dy || dz) scan(slot(ix + dx, iy + dy, iz + dz));
    }
    // Nothing within a cell (a triangle far larger than the mean): look at them all.
    if (best < 0) for (let t = 0; t < n; t++) {
      const dx = C[3 * t] - x, dy = C[3 * t + 1] - y, dz = C[3 * t + 2] - z, d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best < 0 ? -1 : triFace[best];
  };
}

export function createProvenance({ log, expand }) {
  const cages = new WeakMap(); // cage -> { keys: Map<face id, keys newest first>, shapes: Map<face id, number> }
  const fields = new Map(); // run id -> { source, faceKeys } for a k.subdiv run
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
  const recordOf = (id, mat) => lookup(id, mat ?? IDENTITY12) ?? [];

  // Whether some input run has this id and a transform within MAT_TOL of `mat`:
  // a result's structural lineage and a restamp's mesh-read lineage can differ by
  // float32 rounding, which an exact runKey compare would read as a new run.
  const sameRun = (inRuns, { id, mat }) =>
    inRuns.some((r) => r.id === id && maxDiff(r.mat ?? IDENTITY12, mat ?? IDENTITY12) <= MAT_TOL);

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
    const inRuns = inputs.flatMap((s) => s._runs());
    let oldOf = null;
    if (result._idMap instanceof Map) {
      oldOf = new Map();
      for (const [oldId, newId] of result._idMap) oldOf.set(newId, oldId);
    }
    for (const r of runs) {
      if (sameRun(inRuns, r)) continue;
      const oldId = oldOf?.get(r.id);
      set(r.id, r.mat, dedupe([...slice, ...(oldId !== undefined ? recordOf(oldId, r.mat) : [])]));
      if (oldId !== undefined && fields.has(oldId)) fields.set(r.id, fields.get(oldId));
    }
    return result;
  }

  // A cage was just made or changed: the reads since the previous boundary go to every
  // face that call made or reshaped. A face an extrude made also keeps the keys of the
  // faces it replaced, since it is shaped from them. An enumeration (a null slice)
  // records nothing.
  function cageChanged(cage) {
    const slice = expand(log.slice(mark));
    mark = log.length;
    const rec = cages.get(cage) ?? { keys: new Map(), shapes: new Map() };
    const shapes = faceShapes(cage);
    if (slice !== null) {
      const replaced = [];
      for (const id of rec.shapes.keys()) if (!shapes.has(id)) replaced.push(...(rec.keys.get(id) ?? []));
      for (const [id, h] of shapes) {
        if (!rec.shapes.has(id)) rec.keys.set(id, dedupe([...slice, ...replaced]));
        else if (rec.shapes.get(id) !== h && slice.length) rec.keys.set(id, dedupe([...slice, ...(rec.keys.get(id) ?? [])]));
      }
    }
    rec.shapes = shapes;
    cages.set(cage, rec);
  }

  // k.subdiv(cage) just returned `solid`: its run answers per cage face from here on.
  // `source` is the backend's limit mesh ({ positions, indices, triFace, ids }).
  function subdivField(solid, cage, source) {
    const rec = cages.get(cage);
    if (!rec || !source?.triFace || !isSolid(solid)) return;
    const faceKeys = source.ids.map((id) => rec.keys.get(id) ?? []);
    for (const r of solid._runs()) fields.set(r.id, { source, faceKeys });
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
    // 1-based index of a record in `origins`, or 0 when it is empty or the table is full.
    const intern = (rec) => {
      if (!rec || rec.length === 0) return 0;
      const sig = rec.join("\u0000");
      let idx = indexOf.get(sig);
      if (idx === undefined) {
        if (origins.length >= 0xffff) return 0;
        origins.push(rec.slice());
        idx = origins.length;
        indexOf.set(sig, idx);
        if (!allSigs.has(sig)) { allSigs.add(sig); allOrigins.push(rec.slice()); }
      }
      return idx;
    };
    for (let r = 0; r < ids.length; r++) {
      const mat = rt && rt.length >= (r + 1) * 12 ? Array.prototype.slice.call(rt, r * 12, r * 12 + 12) : IDENTITY12;
      const rec = lookup(ids[r], mat);
      const t0 = (ri[r] / 3) | 0, t1 = Math.min(nTri, (ri[r + 1] / 3) | 0);
      if (t1 <= t0) continue; // no triangles: never listed
      const field = fields.get(ids[r]);
      const inv = field ? invertAffine(mat) : null;
      if (field && inv && g.vertProperties && g.numProp >= 3) {
        // A cage body: each triangle takes its own cage face's keys, then the run's.
        field.source.nearest ??= nearestFace(field.source);
        const vp = g.vertProperties, np = g.numProp, tv = g.triVerts, ofFace = new Map();
        for (let t = t0; t < t1; t++) {
          const a = np * tv[3 * t], b = np * tv[3 * t + 1], c = np * tv[3 * t + 2];
          const x = (vp[a] + vp[b] + vp[c]) / 3, y = (vp[a + 1] + vp[b + 1] + vp[c + 1]) / 3, z = (vp[a + 2] + vp[b + 2] + vp[c + 2]) / 3;
          const face = field.source.nearest(inv[0] * x + inv[3] * y + inv[6] * z + inv[9],
            inv[1] * x + inv[4] * y + inv[7] * z + inv[10], inv[2] * x + inv[5] * y + inv[8] * z + inv[11]);
          let idx = ofFace.get(face);
          if (idx === undefined) ofFace.set(face, (idx = intern(dedupe([...(field.faceKeys[face] ?? []), ...(rec ?? [])]))));
          originIds[t] = idx;
          if (idx) any = true;
        }
        continue;
      }
      const idx = intern(rec);
      if (!idx) continue;
      for (let t = t0; t < t1; t++) originIds[t] = idx;
      any = true;
    }
    return any ? { originIds, origins } : null;
  }

  return { boundary, cageChanged, subdivField, originsFor, table, origins: allOrigins };
}

// A Proxy over `kernel` whose author-facing ops (function-valued, not `_`-prefixed)
// are provenance boundaries, and whose Solid results are proxied the same way.
export function provenanceKernel(kernel, prov) {
  const targetOf = new WeakMap(); // proxy -> wrapper
  const proxyOf = new WeakMap(); // wrapper -> proxy

  // Proxied Solids/Shape2Ds back to the backend's own wrappers: directly, in
  // arrays, and as plain-object values (one more level, for `{ sections: [...] }`).
  const unwrapArg = (a, depth = 0) => {
    if (a == null || typeof a !== "object") return a;
    if (targetOf.has(a)) return targetOf.get(a);
    if (depth >= 2) return a;
    if (Array.isArray(a)) {
      const out = a.map((x) => unwrapArg(x, depth + 1));
      return out.some((x, i) => x !== a[i]) ? out : a;
    }
    if (isPlainObject(a)) {
      let changed = false;
      const o = {};
      for (const [key, x] of Object.entries(a)) { o[key] = unwrapArg(x, depth + 1); if (o[key] !== x) changed = true; }
      return changed ? o : a;
    }
    return a;
  };
  const wrapResult = (r) => (isSolid(r) || isShape2D(r) ? objectProxy(r) : isCage(r) ? cageProxy(r) : r);

  // A cage's changing methods are boundaries of their own (prov.cageChanged); its reads
  // (centroid, faces, …) pass straight through and consume nothing. A copy, not a
  // Proxy: the cage is frozen, and a Proxy may not answer differently for a frozen method.
  function cageProxy(c) {
    let p = proxyOf.get(c);
    if (p) return p;
    const changed = {};
    for (const name of CAGE_CHANGES) {
      changed[name] = (...args) => {
        const out = c[name](...args);
        prov.cageChanged(c);
        return out;
      };
    }
    p = Object.freeze({ ...c, ...changed });
    proxyOf.set(c, p);
    targetOf.set(p, c);
    return p;
  }

  // One Proxy per wrapper. A Solid's or Shape2D's author-facing methods go through
  // boundary, which only records (and only consumes the slice) when the result is a
  // Solid; a Shape2D result comes back proxied so its own extrude/revolve are seen.
  function objectProxy(s) {
    let p = proxyOf.get(s);
    if (p) return p;
    p = new Proxy(s, {
      get(t, name) {
        const v = Reflect.get(t, name);
        if (typeof v !== "function") return v;
        if (typeof name !== "string" || name.startsWith("_")) return v.bind(t);
        return (...args) => {
          const raw = args.map((a) => unwrapArg(a));
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
        const raw = args.map((a) => unwrapArg(a));
        const out = prov.boundary(name, null, raw, () => v.apply(t, raw));
        if (isCage(out)) prov.cageChanged(out);
        else if (name === "subdiv") prov.subdivField(out, raw[0], t._subdivSource?.(out));
        return wrapResult(out);
      };
    },
  });
}

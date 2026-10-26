// Failure recovery for native OCCT features (fillet/chamfer/shell), extracted from
// occt-backend.js so the backend reads as a clean contract mapping and the pure
// mesh-topology logic is unit-testable without booting OCCT.
//
// Two deliberately different rescue policies:
//   - chamfer → validChamfer: try the requested distance, and if it breaks the
//     solid, binary-search the largest distance that doesn't. An over-large chamfer
//     fails by over-running its faces, which is (near enough) monotonic in the
//     distance — so bisection is sound.
//   - fillet (and shell) → safeOp: attempt once, skip the feature on failure.
//     OCCT fillet failures are NOT monotonic in the radius (a radius equal to an
//     adjacent fillet's can fail while larger ones succeed), so a binary search
//     would converge on garbage; skipping keeps the part alive and warns.

// Is a shape a closed solid? A broken chamfer (one that over-ran and consumed a face)
// meshes to an OPEN surface; a valid one is closed. OCCT meshes each face separately,
// so weld vertices by position, then a closed solid has every edge shared by exactly
// two triangles. (A coarse mesh is enough — this is a topology check.) A triangle
// the weld collapses (two corners in one 1/32 mm cell — a sphere's pole fan, a
// sliver) has no area and bounds nothing, so it is left out of the count: kept,
// its self-edge counts once and its doubled edge three times, and every sphere
// read as open.
export const isClosedSolid = (shape) => {
  const m = shape.mesh({ tolerance: 0.3, angularTolerance: 1.0 });
  const P = m.vertices, T = m.triangles;
  const id = new Map();
  const vid = (i) => {
    const key = Math.round(P[i * 3] * 32) + "," + Math.round(P[i * 3 + 1] * 32) + "," + Math.round(P[i * 3 + 2] * 32);
    let d = id.get(key); if (d === undefined) { d = id.size; id.set(key, d); } return d;
  };
  const edges = new Map();
  for (let t = 0; t < T.length / 3; t++) {
    const a = vid(T[t * 3]), b = vid(T[t * 3 + 1]), c = vid(T[t * 3 + 2]);
    if (a === b || b === c || c === a) continue;
    for (const [x, y] of [[a, b], [b, c], [c, a]]) { const e = x < y ? x * 1e7 + y : y * 1e7 + x; edges.set(e, (edges.get(e) || 0) + 1); }
  }
  for (const n of edges.values()) if (n !== 2) return false;
  return true;
};

// `warn` receives every feature-skip / rescue message. The default keeps the
// historical console.warn; the OCCT backend injects a recorder that ALSO feeds
// the kernel's takeBuildWarnings channel, so a skipped feature reaches the
// build result (and, in the cloud app, the agent) instead of only the console.
export function createOcctRepair(measureVolume, warn = (msg) => console.warn(`partforge: ${msg}`)) {
  // The true maximum chamfer for an edge depends on local angles and adjacent features,
  // which is hard to predict analytically (and OCCT exposes no max-radius query). So
  // VALIDATE the result instead of guessing: try the requested distance, and if it makes
  // a closed solid, use it (valid large chamfers — e.g. on a pill — go through). If not,
  // binary-search the largest distance that does. Discarded attempts are freed so OCCT's
  // WASM heap doesn't grow across regenerates.
  const validChamfer = (shape, finderFn, distance) => {
    if (!(distance > 0)) return shape.clone();
    let attempts = 0;
    const tryAt = (d) => {
      attempts++;
      const probe = shape.clone();
      let res;
      try { res = probe.chamfer(d, finderFn); } catch { return null; } // probe consumed by the op
      if (measureVolume(res) > 0 && isClosedSolid(res)) return res;
      res.delete?.();
      return null;
    };
    const t0 = performance.now();
    let best = tryAt(distance);
    if (best) return best;                                   // requested distance is valid
    let lo = 0, hi = distance, bestD = 0;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      const res = tryAt(mid);
      if (res) { best?.delete?.(); best = res; bestD = mid; lo = mid; } else hi = mid;
    }
    // The rescue re-ran the chamfer per attempt — on a many-edge selection that
    // multiplies an already-expensive op by ~8x, so make the cost loud enough to
    // act on (lower the distance, or bevel profile rims with a loft instead).
    const cost = `${attempts} attempts, ${((performance.now() - t0) / 1000).toFixed(1)}s — see ERROR-PATTERNS.md#chamfer-rescue-bisection`;
    if (best) { warn(`chamfer ${distance} over-ran the geometry — reduced to ${bestD.toFixed(2)} (largest valid; ${cost})`); return best; }
    warn(`chamfer ${distance} has no valid distance for this geometry — feature skipped (${cost})`);
    return shape.clone();                                    // nothing valid — skip the chamfer
  };

  // Native fillet/shell can throw or yield an empty solid for out-of-range radii
  // or awkward edge interactions. Rather than letting the whole part vanish, attempt
  // the op on a clone and fall back to the original shape (feature skipped) on a
  // throw or empty result, with a console warning so it's discoverable.
  //
  // `isValid` is an optional second acceptance gate, evaluated ONLY when the op
  // produces non-empty geometry: (resultVolume, inputVolume) => boolean. Some OCCT
  // fillet failures don't throw or empty out — they return non-empty geometry that
  // is nonetheless topologically invalid (e.g. a rim fillet on a stadium profile
  // whose radius equals the straight-side radius can report MORE volume than the
  // un-filleted input, which is impossible for a material-removing fillet). The
  // default (no `isValid`) keeps every existing caller's behavior unchanged.
  const safeOp = (shape, op, label, isValid) => {
    const backup = shape.clone();
    const beforeVolume = isValid ? measureVolume(shape) : undefined;
    try {
      const result = op(shape);
      const resultVolume = measureVolume(result);
      if (resultVolume > 0 && (!isValid || isValid(resultVolume, beforeVolume))) { backup.delete?.(); return result; }
      result.delete?.();
      if (resultVolume > 0) warn(`${label} produced invalid geometry — feature skipped`);
      else warn(`${label} produced an empty solid — feature skipped (radius out of range?)`);
    } catch (e) {
      warn(`${label} failed (${e?.message || e}) — feature skipped`);
    }
    return backup;
  };

  return { validChamfer, safeOp };
}

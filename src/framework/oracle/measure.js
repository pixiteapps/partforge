import { buildView } from "./build.js";
import { cachedBVH } from "./bvh.js";
import { assemblyOverlaps } from "../assembly.js";
import { resolveParams } from "../part-model.js";
import { meshGaps, pairKey, CONTACT_EPS, GAP_THRESHOLD } from "./gaps.js";
import { bounds, meshArea, meshCentroid } from "./mesh.js";
import { minWall, DIAGNOSTIC_SAMPLES } from "./min-wall.js";
import { overhang } from "./overhang.js";
import { partGatesMinWall, partOverhangAngle } from "./gates.js";
import { summarizeContours } from "./shape-probe.js";

const size = ({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
const unionBounds = (list) => list.reduce(
  (acc, b) => ({ min: acc.min.map((v, i) => Math.min(v, b.min[i])), max: acc.max.map((v, i) => Math.max(v, b.max[i])) }),
  { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
);

// ── probes ──────────────────────────────────────────────────────────────────
// Part-declared measurements: `probes: { name: (k, p, d) => Solid | JSON }`,
// pure functions with build's exact contract but whose result lands in the
// REPORT instead of the scene. The instrument a rebuild-against-reference
// workflow needs — before this, getting a cross-section's numbers out of the
// pipeline meant authoring throwaway `exportable: false` sub-parts and fishing
// their facts out of the sub-part list (the "Probes" feedback report).
// A Solid anywhere in the return value (duck-typed on volume+toMesh, the two
// queries the facts need) is replaced by a fact object; a Shape2D by its arc/corner
// summary (shape-probe.js); scalars/arrays/objects pass through; a throw becomes
// `{ error }` — probes are instrumentation, so they never crash the measurement and
// never gate `ok`.

const isSolid = (v) => v !== null && typeof v === "object"
  && typeof v.volume === "function" && typeof v.toMesh === "function";

// A Shape2D is a class instance with value semantics: walking it as a plain object
// would leak its storage fields. Duck-typed on the two reads the summary needs.
const isShape2D = (v) => v !== null && typeof v === "object"
  && typeof v.toContours === "function" && typeof v.area === "function";

const shapeProbeFacts = (shape) => {
  const empty = typeof shape.isEmpty === "function" ? shape.isEmpty() : false;
  return summarizeContours(shape.toContours(), {
    isEmpty: empty,
    area: empty ? 0 : shape.area(),
    bbox: empty ? null : (typeof shape.boundingBox === "function" ? shape.boundingBox() : null),
  });
};

function solidProbeFacts(solid) {
  const mesh = solid.toMesh();
  // Empty = the probe's boolean found nothing (a slab that misses the part).
  // A first-class answer, not degenerate infinite bounds: "the reference has no
  // material here" is exactly what a localizing probe is asked.
  const empty = typeof solid.isEmpty === "function" ? solid.isEmpty() : mesh.triangles === 0;
  if (empty) {
    return { empty: true, bbox: null, bounds: null, centerOfMass: null,
      volume: 0, surfaceArea: 0, triangleCount: 0, watertight: null, holes: null };
  }
  const b = bounds(mesh.positions);
  return {
    empty: false,
    bbox: size(b),
    bounds: { min: b.min, max: b.max },
    centerOfMass: meshCentroid(mesh.positions, mesh.indices),
    volume: solid.volume(),
    surfaceArea: meshArea(mesh.positions, mesh.indices),
    triangleCount: mesh.triangles,
    // Mirrors the sub-part fact: answered by isEmpty where the backend has it
    // (and this branch already means it said false), null where it can't say.
    watertight: typeof solid.isEmpty === "function" ? true : null,
    holes: typeof solid.genus === "function" ? solid.genus() : null,
  };
}

// Bounded so a self-referential or absurdly deep return value can't hang the
// report; past the cap the value is summarized rather than walked.
const MAX_PROBE_VALUE_DEPTH = 4;
function resolveProbeValue(v, depth = 0) {
  if (isSolid(v)) return solidProbeFacts(v);
  if (isShape2D(v)) return shapeProbeFacts(v);
  if (v === null || typeof v !== "object") {
    return typeof v === "function" ? { error: "probe returned a function — return a Solid or plain JSON" } : v;
  }
  if (depth >= MAX_PROBE_VALUE_DEPTH) return { error: `probe value deeper than ${MAX_PROBE_VALUE_DEPTH} levels` };
  if (Array.isArray(v)) return v.map((x) => resolveProbeValue(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, resolveProbeValue(x, depth + 1)]));
}

// Evaluate every declared probe with resolved (p, d). Reads all solid facts
// eagerly, so the caller may free the kernel's objects afterwards. Never
// throws: each probe's failure is its own `{ error }` entry.
function evaluateProbes(kernel, part, params) {
  const { p, d } = resolveParams(part, params);
  // Oracle-owned cache round, same reasoning as buildView's: probe geometry must
  // not evict what the viewer is showing, and the next round evicts this one.
  kernel.beginSubPart?.("oracle:probes");
  try {
    return Object.fromEntries(Object.entries(part.probes).map(([name, fn]) => {
      try {
        if (typeof fn !== "function") throw new Error("probe must be a function (k, p, d)");
        return [name, resolveProbeValue(fn(kernel, p, d))];
      } catch (e) {
        return [name, { error: e?.message || String(e) }];
      }
    }));
  } finally { kernel.endSubPart?.(); }
}

// Headless geometric report for one view of a part (Manifold-only). Reads exact
// solid facts (volume/genus/emptiness) and mesh facts (bbox/area/triangles), plus
// the assembly overlap check plus pair gap distances (near misses are reported,
// never folded into `ok`). All solid facts are read BEFORE assemblyOverlaps,
// which frees the shared kernel's objects at its end. A sub-part that declares
// `reference: "<import name>"` also gets a `deviation` fact — the posed solid's
// symmetric-difference volume, volume delta %, and bbox-corner drift against
// that import — for the `ref*` gate metrics (verify-metrics.js); every other
// sub-part gets `deviation: null`.
//   → { part, view, measuredMinWall, subparts[], aggregate, overlaps[], gaps[],
//       nearMisses[], ok }
export function measure(kernel, part, view = Object.keys(part.views)[0], params = {}, opts = {}) {
  // `opts.built` is a build of this view the caller already has. The inspect job
  // needs those meshes anyway — it rasterizes them for silhouette match scoring —
  // and a second buildView here would be a whole duplicate build of the part for
  // nothing. Absent, this measures its own build exactly as it always did.
  const built = opts.built ?? buildView(kernel, part, view, params);
  // ONE BVH per sub-part mesh for this call, shared by the two passes that need
  // one: min-wall (inward rays per triangle) and meshGaps (pair distances). They
  // used to index the same mesh objects independently, so every sub-part of a
  // multi-part view was built into a BVH twice — at ~77 bytes/triangle that is a
  // whole second index's worth of build time and peak memory for nothing.
  //
  // This Map is the caller-owned cache cachedBVH documents — see there for why it
  // is a Map of ours and not a module-level WeakMap. It dies with the call. Peak
  // memory is unchanged (meshGaps already held every sub-part's index at once);
  // the cache just fills it earlier. min-wall indexes exactly one mesh, so it is
  // handed the resolved BVH rather than the Map.
  const bvhCache = new Map();
  // Sample budget for the min-wall pass. A part that declares a min-wall gate (a
  // process profile or an `expect` mentioning it) gets the full resolution, because
  // a gate's verdict rides on the reading. Everything else gets the diagnostic
  // budget: min wall is the single most expensive thing the oracle does — one
  // inward ray per sampled triangle plus the BVH those rays need — and on an
  // ungated part it buys a fact nobody checks, at full price, on every agent edit.
  const minWallSamples = partGatesMinWall(part) ? undefined : DIAGNOSTIC_SAMPLES;
  // Overhang is measured only for a part that opted in (dfm-profiles.js
  // overhangAngleFor) — everything else reads null. verify hands the angle it
  // resolved in (a `process` override changes it); `null` there is an explicit
  // "not checked", not a fallback. The angle used is stamped on the result as
  // `measuredOverhang`, and verify refuses a seed whose stamp disagrees with the
  // angle it needs — the min-wall superset rule's counterpart, since a reading
  // taken against the wrong threshold is worse than none.
  const overhangAngle = opts.overhang !== undefined ? opts.overhang : partOverhangAngle(part);
  const subBounds = [];
  const subparts = built.map(({ name, solid, mesh }) => {
    const b = bounds(mesh.positions);
    subBounds.push(b);
    // Resolved lazily and only when asked for: without min-wall, a single-sub-part
    // view (no meshGaps) must still build no index at all.
    const mw = opts.minWall ? minWall(mesh, { bvh: cachedBVH(mesh, bvhCache), maxSamples: minWallSamples }) : null;
    // One pass over the triangles, no index — cheap enough for every lap. The bed
    // is this sub-part's own lowest Z, already in hand from bounds(). A sub-part
    // that is never printed (`exportable: false` — a reference ghost, a probe
    // slab, a placeholder) is not judged. Judged in the DISPLAY pose, which is
    // what measure builds; a part whose export pose differs (a lid that prints
    // flat beside its base) is a known gap, stated in the authoring docs.
    const printed = part.parts[name]?.exportable !== false;
    const oh = overhangAngle != null && printed ? overhang(mesh, { maxAngle: overhangAngle, bedZ: b.min[2] }) : null;
    const vol = solid.volume();
    // Deviation-from-reference: only for a sub-part that declares `reference:
    // "<import name>"` (Task 12 — the gate that holds a parametric rebuild to
    // its imported reference), and only when this kernel can import at all (a
    // bare/third-party kernel may lack `import`). Read here, alongside every
    // other solid fact, so it is captured before assemblyOverlaps/cleanup below
    // frees the shared kernel's objects.
    const refName = part.parts[name]?.reference;
    let deviation = null;
    if (refName && typeof kernel.import === "function") {
      const ref = kernel.import(refName);
      const refVol = ref.volume();
      const rb = ref.boundingBox();
      const inter = solid.intersect(ref).volume();
      deviation = {
        ref: refName,
        xorVolume: vol + refVol - 2 * inter, // symmetric difference, one boolean
        volumeDeltaPct: refVol > 1e-9 ? (100 * Math.abs(vol - refVol)) / refVol : null,
        bboxDelta: [0, 1, 2].map((i) => Math.max(Math.abs(b.min[i] - rb.min[i]), Math.abs(b.max[i] - rb.max[i]))),
      };
    }
    return {
      name,
      bbox: size(b),
      bounds: { min: b.min, max: b.max },
      centerOfMass: meshCentroid(mesh.positions, mesh.indices),
      volume: vol,
      surfaceArea: meshArea(mesh.positions, mesh.indices),
      triangleCount: mesh.triangles,
      watertight: typeof solid.isEmpty === "function" ? !solid.isEmpty() : null,
      holes: typeof solid.genus === "function" ? solid.genus() : null,
      deviation,
      minWall: mw?.value ?? null,
      minWallAt: mw?.location ?? null,
      // Sampling accounting, so a report can tell a guaranteed minimum from an
      // upper bound: on a dense mesh min-wall casts from a spread subset rather
      // than every triangle (see min-wall.js). Exact readings say so explicitly,
      // and a sampled run that found no wall still fills these in — `minWall`
      // null with samples accounted for is "looked, found nothing"; null with
      // `measuredMinWall` false is "never looked".
      minWallSampled: mw?.sampled ?? false,
      minWallSamples: mw ? { sampled: mw.sampledTriangles, total: mw.totalTriangles } : null,
      // Unsupported downward-facing area in mm² (overhang.js), null when the part
      // is not laid out for a bed: bridges and bore ceilings count, by design.
      overhangArea: oh ? oh.area : null,
      overhangAngle: oh?.worstAngle ?? null,
      overhangAt: oh?.at ?? null,
    };
  });

  // Declared probes, evaluated regardless of view (they are part-level facts —
  // per-view probes were exactly the annoyance this replaces) and before
  // assemblyOverlaps/cleanup below frees the kernel's objects. `opts.probes:
  // false` skips them: verify's per-case re-measures pass it because no gate
  // reads probe values, so re-running their booleans per case buys nothing.
  const probes = opts.probes !== false && part.probes && Object.keys(part.probes).length
    ? evaluateProbes(kernel, part, params)
    : undefined;

  // Pair surface distances from the meshes already built — no kernel dependency,
  // so this reads on OCCT too. nearMisses = the issue-#29 signal: pairs that
  // *almost* touch; overlapping pairs are excluded by name (a fully-contained
  // sub-part has surface distance > 0 but is the overlap gate's business).
  // `opts.gaps: false` is the quick lap's second half (see jobs.js): pair distances
  // are the other ray-casting pass, and they and min-wall share the BVH, so skipping
  // only one leaves the index build standing. The result is `undefined`, NEVER `[]`:
  // pairGapChecks reads an empty table as "measured, and this pair has no distance"
  // and fails a declared gate on it, while an absent table reads as no reading.
  const measuredGaps = opts.gaps !== false;
  const gaps = measuredGaps ? (built.length > 1 ? meshGaps(built, { bvhCache }) : []) : undefined;

  // Rebuilds with the same kernel and cleans up at its end — every solid fact
  // above is already read, so this is safe.
  const canIntersect = built.length > 0 && typeof built[0].solid.intersect === "function";
  const overlaps = canIntersect ? assemblyOverlaps(kernel, part, view, params) : [];
  kernel.cleanup?.();

  const overlapping = new Set(overlaps.map((o) => pairKey(o.a, o.b)));
  const gapThreshold = opts.gapThreshold ?? GAP_THRESHOLD;
  const nearMisses = (gaps ?? []).filter(
    (g) => g.distance > CONTACT_EPS && g.distance < gapThreshold && !overlapping.has(pairKey(g.a, g.b)),
  );

  const ub = subparts.length ? unionBounds(subBounds) : { min: [0, 0, 0], max: [0, 0, 0] };
  const weighted = subparts.filter((s) => s.centerOfMass !== null);
  const totalVol = weighted.reduce((a, s) => a + s.volume, 0);
  const aggCom = weighted.length && Math.abs(totalVol) > 1e-9
    ? [0, 1, 2].map((i) => weighted.reduce((a, s) => a + s.volume * s.centerOfMass[i], 0) / totalVol)
    : null;
  const aggregate = {
    bbox: size(ub),
    bounds: { min: ub.min, max: ub.max },
    centerOfMass: aggCom,
    volume: subparts.reduce((a, s) => a + s.volume, 0),
    surfaceArea: subparts.reduce((a, s) => a + s.surfaceArea, 0),
    triangleCount: subparts.reduce((a, s) => a + s.triangleCount, 0),
  };
  return {
    part: part.meta?.title ?? view,
    view,
    // Whether this measurement cast min-wall rays at all — stamped by the pass
    // that did (or didn't) do the work, so a consumer never has to be told. A
    // result with this false carries `minWall: null` on every sub-part because
    // nothing measured it, which reads identically to "no reading available";
    // verify's seeding rule turns on exactly this distinction (see verify.js).
    measuredMinWall: !!opts.minWall,
    // The overhang angle every sub-part's `overhangArea` was measured against,
    // or null when the pass did not run — read by verify's seed gate, never a
    // caller's claim.
    measuredOverhang: overhangAngle ?? null,
    // Companion stamp to measuredMinWall, and read the same way: whether the pass
    // ran, said by the pass itself rather than claimed by whoever holds the result.
    measuredGaps,
    subparts,
    aggregate,
    overlaps,
    gaps,
    nearMisses,
    // Present only when the part declares probes AND this run evaluated them —
    // a probe error stays inside its own entry and never reaches `ok` below.
    ...(probes ? { probes } : {}),
    ok: subparts.every((s) => s.watertight !== false) && overlaps.length === 0,
  };
}

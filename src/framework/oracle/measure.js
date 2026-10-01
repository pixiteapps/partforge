import { buildView } from "./build.js";
import { cachedBVH } from "./bvh.js";
import { assemblyOverlaps } from "../assembly.js";
import { resolveParams, buildPosed } from "../part-model.js";
import { newReadSink, expandReads } from "../read-recorder.js";
import { probeSubPartPose } from "../pose-probe-core.js";
import { composePose, invertRigid, transformPositions } from "../geometry/pose.js";
import { displayToPrintMatrix } from "../materials/print-frame.js";
import { isSheetPart, sheetMeta, SHEET_CHECK_BUDGET_MS, MARK_DEPTH } from "../sheet/constants.js";
import { resolveSheet } from "../sheet/resolve.js";
import { processFor } from "../process/registry.js";
import { meshGaps, pairKey, CONTACT_EPS, GAP_THRESHOLD } from "./gaps.js";
import { bounds, meshArea, meshCentroid } from "./mesh.js";
import { minWall, DIAGNOSTIC_SAMPLES } from "./min-wall.js";
import { overhang } from "./overhang.js";
import { partGatesMinWall, partHasBed, partOverhangAngle, partWallBands } from "./gates.js";
import { summarizeContours } from "./shape-probe.js";

const size = ({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
const unionBounds = (list) => list.reduce(
  (acc, b) => ({ min: acc.min.map((v, i) => Math.min(v, b.min[i])), max: acc.max.map((v, i) => Math.max(v, b.max[i])) }),
  { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
);

// ── probes ──────────────────────────────────────────────────────────────────
// Part-declared measurements: `probes: { name: (k, p, d) => Solid | Shape2D | JSON }`,
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

// A Shape2D is a plain object carrying a `_shape2d` marker, not a class instance, but
// walking it as generic JSON would still leak its storage fields (`_regions`, `_hash`)
// and turn its methods into `{error}` entries. Duck-typed on the two reads the summary
// needs, so a foreign shape-like value (same two methods, no marker) is still summarised.
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
    return typeof v === "function" ? { error: "probe returned a function — return a Solid, a Shape2D or plain JSON" } : v;
  }
  if (depth >= MAX_PROBE_VALUE_DEPTH) return { error: `probe value deeper than ${MAX_PROBE_VALUE_DEPTH} levels` };
  if (Array.isArray(v)) return v.map((x) => resolveProbeValue(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, resolveProbeValue(x, depth + 1)]));
}

// Evaluate every declared probe with resolved (p, d). Reads all solid facts
// eagerly, so the caller may free the kernel's objects afterwards. Never
// throws: each probe's failure is its own `{ error }` entry.
function evaluateProbes(kernel, part, params, reads) {
  const { p, d } = resolveParams(part, params, undefined, reads);
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

// ── sheet parts ──────────────────────────────────────────────────────────────
// A sub-part made with sheetPart() (partforge/geometry) is recognised by its
// plain-data `sheet` declaration alone (isSheetPart) — never by identity: in
// partforge-cloud's part worker the part's partforge/geometry and this oracle are
// separate module instances. Its checks are 2-D: its process's facts() reads the
// resolved profile, score and engrave through Shape2D methods. The 3-D parts are
// here — where a finding sits in the assembly, and a custom build's volume drift.

// A column-major mat4 (geometry/pose.js composePose) applied to one point.
const transformPoint = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

// Overhang of one printed sub-part in its PRINT pose. measure builds the display pose,
// and a piece shown assembled (a lid closed over its box) is not how it prints: judging
// its underside there flagged the wrong faces and missed the real ones. The display mesh
// is carried into the export pose by a rigid matrix — no second build — and the bed is
// that pose's own lowest Z; `at` comes back in display coordinates, where every other
// finding of this view sits. An unreadable or identical pose measures as shown.
function printPoseOverhang(mesh, sp, { view, p, d, maxAngle, displayBedZ }) {
  const m = p ? displayToPrintMatrix(sp, { view, p, d }) : null;
  if (!m) return overhang(mesh, { maxAngle, bedZ: displayBedZ });
  const positions = Float32Array.from(mesh.positions);
  transformPositions(positions, m);
  const out = overhang({ positions, indices: mesh.indices }, { maxAngle });
  return out?.at ? { ...out, at: transformPoint(invertRigid(m), out.at) } : out;
}

// One sheet row's facts, within `budget.left` ms of 2-D work, which it spends (see
// measure()). A 2-D location is lifted through the sub-part's DISPLAY pose, as the geometry-free
// probe records it, at mid-thickness; a pose the probe cannot trust (a place() that
// queries geometry) leaves `at` null and keeps the 2-D reading. Null for a process
// id no descriptor answers to (lint's sheet-invalid reports that) is still a sheet —
// measure and verify ask the same question, isSheetPart — with nothing to check it by:
// unknownProcessFacts.
function sheetRowFacts(kernel, part, name, view, { p, d }, budget, volume) {
  const sp = part.parts[name];
  const proc = processFor(sp);
  if (!proc) return unknownProcessFacts(kernel, sp, p, d);
  const resolved = resolveSheet(kernel, sp, p, d);
  const start = budget.now();
  const f = proc.facts(resolved, { deadline: start + budget.left, now: budget.now });
  budget.left -= budget.now() - start;
  const probe = probeSubPartPose(sp, { view, purpose: "display", p, d });
  const m = probe.trusted ? composePose(probe.pose) : null;
  const lift = (uv) => (m && uv ? transformPoint(m, [uv[0], uv[1], f.thickness / 2]) : null);
  const expected = f.area * f.thickness - MARK_DEPTH * (f.marksArea ?? 0);
  return {
    ...f,
    at: { bridge: lift(f.at2d.bridge), gap: lift(f.at2d.gap), marks: lift(f.at2d.marks) },
    solidMatchPct: f.customBuild && f.marksArea != null && expected > 1e-9
      ? (100 * Math.abs(volume - expected)) / expected
      : null,
  };
}

// A sheet whose process no descriptor answers to: what can be read without one (the
// cut layer's size, area and pieces, when the declaration resolves at all), and no
// reading — `evaluated` false.
function unknownProcessFacts(kernel, sp, p, d) {
  const meta = sheetMeta(sp, p, d);
  let flat = [0, 0], area = 0, pieces = 0;
  try {
    const { profile } = resolveSheet(kernel, sp, p, d);
    pieces = profile.toContours().length;
    if (pieces) {
      const { min, max } = profile.boundingBox();
      flat = [max[0] - min[0], max[1] - min[1]];
      area = profile.area();
    }
  } catch { /* a declaration that does not resolve: sizes stay zero */ }
  return {
    process: sp.sheet.process, material: meta?.material ?? null, thickness: meta?.thickness ?? null, group: meta?.group ?? null,
    flat, area, pieces, customBuild: sp.build !== sp.sheet.generatedBuild,
    marksArea: null, bridge: null, bridgeCapped: false, gap: null, gapCapped: false, marksOutside: null, solidMatchPct: null,
    at2d: { bridge: null, gap: null, marks: null }, at: { bridge: null, gap: null, marks: null },
    readErrors: { bridge: null, gap: null, marks: null, marksArea: null },
    evaluated: false,
  };
}

// The size of every PRINTED sub-part in its print (export) pose — what verify fits the
// process profile's bed to in a view holding a sheet part: laser-cut stock never meets
// a print bed, and a printed part is routinely displayed in an assembly pose that is
// not how it prints. Its own cache round, like evaluateProbes: export-pose geometry
// must not evict the view's. One part at a time: an export pose that does not build
// costs that part its size ({ error }, which verify reports), never the report.
function printPoseBboxes(kernel, part, view, built, { p, d }) {
  kernel.beginSubPart?.(`oracle:print:${view}`);
  try {
    const out = {};
    for (const { name } of built) {
      const sp = part.parts[name];
      if (sp?.exportable === false || isSheetPart(sp)) continue;
      try {
        const { min, max } = buildPosed(kernel, part, name, { purpose: "export", view, p, d }).boundingBox();
        out[name] = { size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
      } catch (e) {
        out[name] = { error: String(e?.message || e).slice(0, 200) };
      }
    }
    return out;
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
  // Every param this measurement depends on (spec §4): one sink through every
  // place it resolves params. A caller-supplied view (`opts.built`) is only
  // covered when the caller recorded its build into the same sink (opts.reads);
  // otherwise the result claims no reads and verify reuses it only on identical
  // params.
  const reads = opts.reads ?? newReadSink();
  const readsKnown = !opts.built || !!opts.reads;
  const built = opts.built ?? buildView(kernel, part, view, params, { reads });
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
  // Declared wall bands, per sub-part, for exactly these params (Task 5). Resolved
  // once per measure; a bad declaration throws here, which is a measure error.
  const wallBands = opts.minWall ? partWallBands(part, params, reads) : {};
  // Overhang is measured only for a part that opted in (dfm-profiles.js
  // overhangAngleFor) — everything else reads null. verify hands the angle it
  // resolved in (a `process` override changes it); `null` there is an explicit
  // "not checked", not a fallback. The angle used is stamped on the result as
  // `measuredOverhang`, and verify refuses a seed whose stamp disagrees with the
  // angle it needs — the min-wall superset rule's counterpart, since a reading
  // taken against the wrong threshold is worse than none.
  const overhangAngle = opts.overhang !== undefined ? opts.overhang : partOverhangAngle(part);
  const subBounds = [];
  // Sheet parts: a view holding one sizes each printed sub-part in its print pose
  // (verify fits the bed per part there), and every sheet row gets its 2-D facts under
  // ONE budget for the whole call, charged for 2-D work alone: each sheet's facts() is
  // timed and the next is given what is left, so neither a slow build nor a printed
  // row's min-wall rays between two sheets spend it (the verdict used to depend on
  // declaration order). A view without a sheet part measures exactly as it always has.
  const sheetView = built.some(({ name }) => isSheetPart(part.parts[name]));
  const sheetParams = sheetView ? resolveParams(part, params, undefined, reads) : null;
  // The overhang reading poses each piece for print (printPoseOverhang), which reads the
  // resolved params through place() — recorded into the same sink, since the reading
  // depends on them.
  const poseParams = overhangAngle != null ? (sheetParams ?? resolveParams(part, params, undefined, reads)) : null;
  // The print-pose sizes are read by one check, the process bed (verify passes whether
  // its profile has one; alone, measure asks the part's own profile), and each costs a
  // second build of the part — so they are built only for a bed.
  const measuredPrintBboxes = sheetView && (opts.printBboxes ?? partHasBed(part));
  const printBboxes = measuredPrintBboxes ? printPoseBboxes(kernel, part, view, built, sheetParams) : null;
  // The clock the budget runs on is Date.now, or a test's own (opts.now).
  const sheetBudget = { left: opts.sheetBudgetMs ?? SHEET_CHECK_BUDGET_MS, now: opts.now ?? Date.now };
  const subparts = built.map(({ name, solid, mesh }) => {
    const sheet = isSheetPart(part.parts[name]);
    // Memo key = the inputs this sub-part's facts actually depend on, besides its
    // own geometry hash: whether min-wall ran, at what sample budget and against
    // which declared band, the overhang angle, and whether the sub-part is
    // exportable (it gates overhangArea/overhangAngle/overhangAt via `printed`,
    // below — without it, toggling `exportable` on unchanged geometry would
    // return a stale overhang reading, or a non-exportable ghost would share a
    // real sub-part's entry). Withheld for sheet parts, a declared `reference`
    // sub-part (deviation reads another import), any sub-part when the view
    // holds a sheet part (the budgeted 2-D pass and print-pose sizes are
    // call-scoped, not per-sub-part cacheable), and a solid with no `_hash`
    // (nothing to key reuse on).
    const memoKey = opts.memo && !sheetView && !sheet && !part.parts[name]?.reference && solid?._hash
      ? JSON.stringify({
        mw: !!opts.minWall, s: minWallSamples ?? null, band: wallBands[name] ?? null,
        oh: overhangAngle ?? null, ex: part.parts[name]?.exportable !== false,
      })
      : null;
    if (memoKey) {
      const hit = opts.memo.get(name, solid._hash, memoKey);
      // Re-store on a hit: the memo rotates prev→next per round (changes.js), so
      // a hit read only from `prev` and never re-written would be reused every
      // OTHER round, not every round an unchanged sub-part is measured.
      if (hit) { subBounds.push(hit.bounds); opts.memo.set(name, solid._hash, memoKey, hit); return hit; }
    }
    const b = bounds(mesh.positions);
    subBounds.push(b);
    // Resolved lazily and only when asked for: without min-wall, a single-sub-part
    // view (no meshGaps) must still build no index at all. A sheet part casts none:
    // min wall is a print rule, and its laser checks read the 2-D profile instead.
    const mw = opts.minWall && !sheet
      ? minWall(mesh, { bvh: cachedBVH(mesh, bvhCache), maxSamples: minWallSamples, band: wallBands[name] ?? null })
      : null;
    // One pass over the triangles, no index — cheap enough for every lap. The bed
    // is this sub-part's own lowest Z in its PRINT pose (printPoseOverhang). A
    // sub-part that is never printed (`exportable: false` — a reference ghost, a
    // probe slab, a placeholder) is not judged. A sheet part is laser-cut, never
    // printed: no overhang reading for it either.
    const printed = part.parts[name]?.exportable !== false && !sheet;
    const oh = overhangAngle != null && printed
      ? printPoseOverhang(mesh, part.parts[name], { view, ...poseParams, maxAngle: overhangAngle, displayBedZ: b.min[2] })
      : null;
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
    const facts = {
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
      // The declared wall band's worst member (min-wall.js): null unless this
      // sub-part declared `wall` and the pass ran.
      wall: mw?.band && wallBands[name]
        ? { value: mw.band.value, location: mw.band.location, band: wallBands[name], members: mw.band.members }
        : null,
      // Unsupported downward-facing area in mm² (overhang.js), null when the part
      // is not laid out for a bed: bridges and bore ceilings count, by design.
      overhangArea: oh ? oh.area : null,
      overhangAngle: oh?.worstAngle ?? null,
      overhangAt: oh?.at ?? null,
      // The process's 2-D facts on a sheet part (sheetRowFacts), null on every other.
      sheet: sheet
        ? sheetRowFacts(kernel, part, name, view, sheetParams, sheetBudget, vol)
        : null,
      ...(printBboxes?.[name]?.size ? { printBbox: printBboxes[name].size } : {}),
      ...(printBboxes?.[name]?.error ? { printBboxError: printBboxes[name].error } : {}),
    };
    if (memoKey) opts.memo.set(name, solid._hash, memoKey, facts);
    return facts;
  });

  // Declared probes, evaluated regardless of view (they are part-level facts —
  // per-view probes were exactly the annoyance this replaces) and before
  // assemblyOverlaps/cleanup below frees the kernel's objects. `opts.probes:
  // false` skips them: verify's per-case re-measures pass it because no gate
  // reads probe values, so re-running their booleans per case buys nothing.
  const probes = opts.probes !== false && part.probes && Object.keys(part.probes).length
    ? evaluateProbes(kernel, part, params, reads)
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
  const hashOf = new Map(built.map(({ name, solid }) => [name, solid?._hash ?? null]));
  const gaps = measuredGaps
    ? (built.length > 1
      ? meshGaps(built, {
        bvhCache,
        prior: opts.memo ? (a, b) => (hashOf.get(a) && hashOf.get(b) ? opts.memo.getPair(a, hashOf.get(a), b, hashOf.get(b)) : undefined) : undefined,
        onPair: opts.memo ? (a, b, g) => { if (hashOf.get(a) && hashOf.get(b)) opts.memo.setPair(a, hashOf.get(a), b, hashOf.get(b), g); } : undefined,
      })
      : [])
    : undefined;

  // Rebuilds with the same kernel and cleans up at its end — every solid fact
  // above is already read, so this is safe.
  const canIntersect = built.length > 0 && typeof built[0].solid.intersect === "function";
  const overlaps = canIntersect ? assemblyOverlaps(kernel, part, view, params, { reads }) : [];
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
    // Params this measurement read (undefined = unknown: a caller-built view).
    reads: readsKnown ? expandReads(reads) : undefined,
    // The overhang angle every sub-part's `overhangArea` was measured against,
    // or null when the pass did not run — read by verify's seed gate, never a
    // caller's claim.
    measuredOverhang: overhangAngle ?? null,
    // Companion stamp to measuredMinWall, and read the same way: whether the pass
    // ran, said by the pass itself rather than claimed by whoever holds the result.
    measuredGaps,
    // In a view holding a sheet part: whether the print-pose sizes were built (verify
    // reuses a seed for a bed only when they were). Absent everywhere else.
    ...(sheetView ? { measuredPrintBboxes } : {}),
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

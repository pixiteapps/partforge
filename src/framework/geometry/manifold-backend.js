import { helixTube } from "./helix-tube.js";
import { loftMesh } from "./loft.js";
import { resolveLoftRings, loftRingsKey } from "./loft-rings.js";
import { sweepMesh } from "./sweep.js";
import { roundedBoxRings, roundedBoxArcSamples } from "./rounded-solids.js";
import { tessellateContour, tessellateProfile } from "./profile.js";
import { h } from "./solid-hash.js";
import { ensureOutward, openEdgeCount } from "./mesh-repair.js";
import { manifoldFromMesh, manifoldFromWeldedMesh, ringStackManifold } from "./mesh-build.js";
import { compileImplicit, meshImplicit, implicitHashable, choosePreviewEdge, IMPLICIT_DEFAULTS } from "./implicit/index.js";
import { buildMeshField } from "./implicit/mesh-field.js";
import { createSampleCache } from "./implicit/sample-cache.js";
import { implicitFrames } from "./implicit/frame-report.js";
import { bindVertices, MAX_BIND_FRAMES } from "./implicit/bindings.js";
import { implicitShapeHash } from "./implicit/call-id.js";
import { createCage, isCage, meshSubdiv } from "./subdiv/index.js";
import { topologyKey } from "./subdiv/surface.js";
import { tiesFor, tiesHold } from "./subdiv/ties.js";
import { encodeBindingProps, decodeBindings, BIND_PROPS } from "./mesh-bindings.js";
import { createSolidCache } from "./solid-cache.js";
import { hoistCommonSuffix } from "./transform-hoist.js";
import { addSugar } from "./solid-sugar.js";
import { makeShape2dFactory } from "./shape2d.js";
import { offsetRegions } from "./contour-offset.js";
import { finishKernel } from "./kernel-front.js";
import { makeProfileWarner } from "./profile-warnings.js";
import { meshToStl } from "./mesh-stl.js";
import { creasedNormals } from "./creased-normals.js";
import { loftShadingPolicy, BLEND, ORGANIC, CREASED_SKIN } from "./shading-policy.js";
import { meshFillet, meshChamfer, UnsupportedEdgeError } from "./mesh-fillet.js";
import { affineAt, IDENTITY, invertAffine, mapSurface } from "./blend-surfaces.js";
import { flatFacePlanes, meshOffset, meshRoundAll, prismSection, roundAllSegs } from "./mesh-roundall.js";
import { SEGS, circleSegs, doubleCurvatureSegs } from "./circle-segs.js";
import { checkBooleanResult } from "./boolean-gate.js";
import { KernelCapabilityError } from "./errors.js";
import { heightfieldMesh, hashGridData } from "./heightfield.js";
import { composeAffine, dedupeRuns, mirrorAffine, rotateAffine, scaleAffine, translateAffine } from "./run-lineage.js";

// A boolean whose operand was already broken. See `judged` below.
const invalidOperand = (op, index, status) => new Error(
  `${op}: operand ${index} is not a valid solid (Manifold status ${status}) — an earlier op ` +
  "built nothing, so this boolean has nothing to work with. The usual causes are a primitive " +
  "with a zero dimension (a radius, height or size driven to 0) and a profile that encloses no " +
  "area (collinear, repeated, or self-cancelling points). Check the op that built this operand " +
  "and the parameter values that size it. " +
  "See ERROR-PATTERNS.md#boolean-invalid-operand.");

// A point-list profile whose cross-section came out empty. Thrown at the op,
// before the empty solid can reach a boolean and be misreported there.
const emptyProfile = (op) => new Error(
  `${op}: the profile encloses no area — nothing to build (its points may be collinear, ` +
  "repeated, or cancel each other out). See ERROR-PATTERNS.md#boolean-invalid-operand.");

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
// Trees whose automatic k.implicit preview edge a kernel remembers (each entry is a hash and a number).
const AUTO_PREVIEW_MEMO = 256;
// Solids whose k.implicit mesh field (a BVH and its pseudonormals) a kernel remembers.
const MESH_FIELD_MEMO = 32;
// 'preview' = interactive view (fast); 'print' = STL export (high-res, used only
// by the export path — Manifold meshing is cheap, so we tessellate generously).
// Full-circle segment counts live in circle-segs.js: preview is a flat SEGS.preview,
// print sizes each circle by chord tolerance through circleSegs (floored at the
// preview count, capped at SEGS.print). `segs` below is the tier's cap — the hash
// key and the count handed to consumers that size themselves (mesh-fillet, loft).
const TUBE = { preview: { stationsPerTurn: 38, ringSegs: 24 }, print: { stationsPerTurn: 160, ringSegs: 40 } };

// true axis-angle rotation as a column-major 4x4 (manifold Mat4), translation 0
function axisAngleMat4(axis, deg) {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const R00 = c + x*x*C,   R01 = x*y*C - z*s, R02 = x*z*C + y*s;
  const R10 = y*x*C + z*s, R11 = c + y*y*C,   R12 = y*z*C - x*s;
  const R20 = z*x*C - y*s, R21 = z*y*C + x*s, R22 = c + z*z*C;
  // column-major: columns are images of the basis vectors; 4th column = translation (0)
  return [R00, R10, R20, 0,  R01, R11, R21, 0,  R02, R12, R22, 0,  0, 0, 0, 1];
}

const BYTES_PER_TRI = 160, BYTES_PER_VERT = 24;

export function createManifoldKernel(wasm, { quality = "preview" } = {}) {
  const { Manifold, CrossSection } = wasm;
  const segs = SEGS[quality], tube = TUBE[quality];
  // Per-radius count for every site that facets a circle it knows the radius of; the
  // samplers behind prism/extrude/Shape2D take it as a function (profile.js).
  const segsAt = (r) => circleSegs(r, quality);
  // The doubly-curved family's own per-radius count (sphere, a lathe's profile arcs,
  // a rounded box's corners) — circle-segs.js explains why they are sized apart.
  const dcAt = (r) => doubleCurvatureSegs(r, quality);

  // Manifold/CrossSection are WASM objects with no garbage collection — every
  // primitive and boolean op allocates a new one. Track them all and free them
  // per job via cleanup(); otherwise repeated generates exhaust the WASM heap
  // (manifests as "Out of bounds memory access").
  const tracked = [];
  const T = (obj) => { tracked.push(obj); return obj; };
  // n-ary union in ONE batch op. This must never be a pairwise reduce: a hundred-tool
  // cutAll (a text rim's fillet) reduced sequentially runs a hundred booleans on an
  // ever-growing intermediate — measured 12 s and a 4 GB peak on a lettering part —
  // while Manifold's own batch operator evaluates the same union as a balanced tree.
  // A one-solid "union" returns the operand's own Manifold untouched (see union below).
  const unionRaw = (ms) => (ms.length === 1 ? ms[0] : T(Manifold.union(ms)));
  // Boolean result gate (boolean-gate.js): every author-facing boolean's result is
  // judged by volume against its operands before it enters the cache, and an
  // impossible result throws instead of shipping. Mesh CSG is exact arithmetic,
  // so this backend is expected never to trip it — it is here because the gate
  // is one kernel-contract rule, not an OCCT special case, and a refusal on this
  // backend would itself be a kernel bug worth seeing. Measured at ~0.4% on a
  // hundred-cut chain: `volume()` forces the lazy CSG node, but chained booleans
  // were never batched in this binding, so nothing is lost to the read. Volumes
  // are memoized per Manifold object (a result judged here is an operand a step
  // later). The probes run only on the dropped-operand / emptied-body
  // signatures: an enclosure test off bounding boxes first, and an intersect
  // whose result is freed as soon as its one number is read — NOT tracked, so
  // an n-ary union of buried features does not hold n intermediates to cleanup.
  const volumes = new WeakMap();
  // Two-stage delivery (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md §5).
  // While the generate job arms it (_setProvisionalUnions), a preview union with a
  // k.implicit result among its operands is built as Manifold's LAZY union node with its
  // judgment below DEFERRED: pendingJudge maps the node to that judgment, and settle() runs
  // it at the first read of the node's geometry (meshOut, indexedMeshOut, volumeOf, and
  // every wrap method that reads or builds on it). So the job can mesh the union's
  // operands first — the provisional stage — and the union is only evaluated when it is
  // read. A refusing judgment is put back, so it throws again at every later read; the
  // node is the same Manifold either way, so the union's mesh is byte-identical to an
  // unarmed build's. Unarmed, or at print, nothing is ever deferred.
  let provisionalUnions = false;
  const pendingJudge = new WeakMap();   // deferred union node -> its judgment
  const implicitMs = new WeakSet();     // the Manifolds k.implicit builds
  const deferredMs = new WeakSet();     // the deferred union nodes (an operand that counts too)
  let lastDeferred = null;              // the bracket's last deferred union: { m, pieces }
  const settle = (mm) => {
    const judge = mm && pendingJudge.get(mm);
    if (!judge) return;
    pendingJudge.delete(mm);            // its own volumeOf(result) must not re-enter
    try { judge(); } catch (e) { pendingJudge.set(mm, judge); throw e; }
  };
  // A solid reaches its node through _m, or through its canonical base when a rigid step
  // (translate/rotate) followed the union.
  const settleSolid = (s) => { settle(s?._m); settle(s?._canon?.m); };
  const volumeOf = (mm) => {
    settle(mm);
    let v = volumes.get(mm);
    if (v === undefined) { v = mm.volume(); volumes.set(mm, v); }
    return v;
  };
  const BOX_SLACK = 1e-3; // mm — an enclosure test, not a measurement
  const judged = (op, operandMs, resultM) => {
    // An operand that is already in an error state (Manifold's status, e.g.
    // InvalidConstruction from extruding an empty cross-section) makes the
    // boolean return an empty error-state result. Judged by volume, that reads
    // as "a union smaller than its largest operand" or "a cut that emptied
    // its body", and the coaching sends the author hunting for tangent contacts
    // that are not there. It is the operand's failure, so say that instead.
    // A deferred union among the operands is judged first, so its own refusal is
    // the one reported.
    for (const mm of operandMs) settle(mm);
    const bad = operandMs.findIndex((mm) => mm.status() !== "NoError");
    if (bad >= 0) throw invalidOperand(op, bad, operandMs[bad].status());
    const box = (mm) => mm.boundingBox();
    const err = checkBooleanResult(op, operandMs.map(volumeOf), volumeOf(resultM), {
      overlap: (i, j) => {
        const x = operandMs[i].intersect(operandMs[j]);
        try { return x.volume(); } finally { x.delete?.(); }
      },
      encloses: (i, j) => {
        const a = box(operandMs[i]), b = box(operandMs[j]);
        return [0, 1, 2].every((k) => b.min[k] >= a.min[k] - BOX_SLACK && b.max[k] <= a.max[k] + BOX_SLACK);
      },
    });
    if (err) throw err;
    return resultM;
  };
  const judgedUnion = (ms) => judged("union", ms, unionRaw(ms));
  // kernel.union's evaluation over its operand SOLIDS: deferred (above) when armed at
  // preview and an operand is a k.implicit result or an earlier deferred union, else
  // judged at once as always.
  //
  // Two consequences of deferring, both deliberate: a refusing union that nothing ever
  // READS (built, then dropped by the part's own build) passes an armed generate where
  // an unarmed build would have thrown — every read of it still throws; and a node whose
  // judgment refuses is in the solid cache with that judgment still pending, so a later
  // build that hits the entry throws at its first read, exactly as the first build did.
  const unionOfSolids = (solids) => {
    const ms = solids.map((s) => s._m);
    const deferrable = provisionalUnions && quality === "preview" && ms.length >= 2
      && solids.some((s) => implicitMs.has(s._canon?.m) || deferredMs.has(s._canon?.m));
    if (!deferrable) { for (const s of solids) settleSolid(s); return judgedUnion(ms); }
    const node = unionRaw(ms);
    pendingJudge.set(node, () => { for (const s of solids) settleSolid(s); judged("union", ms, node); });
    deferredMs.add(node);
    lastDeferred = { m: node, pieces: solids };
    return node;
  };

  // A retained solid's heap, estimated from its counts (solid-cache.js MEMORY BUDGET):
  // Manifold keeps per triangle three half-edges, a face normal, a triangle reference and
  // its share of the collider, and per vertex a position and a normal.
  // CrossSections (memoized 2-D profiles) are small: a few dozen bytes per vertex.
  // Measured against the heap a 105-plate forge's cache held (feedback #212).
  const cache = createSolidCache({
    sizeOf: (pin) => {
      if (typeof pin?.numTri === "function") return pin.numTri() * BYTES_PER_TRI + pin.numVert() * BYTES_PER_VERT;
      if (typeof pin?.numVert === "function") return pin.numVert() * 32;
      return 0;
    },
  });
  // Feature-skip warnings (the OCCT backend's safeOp policy, adopted here): a
  // fillet/chamfer whose mesh machinery is defeated by the geometry returns its
  // INPUT solid unchanged and records one message here instead of failing the
  // whole build. jobs.js drains this per sub-part (takeBuildWarnings) and ships
  // it out on the meshes message, so a caller — the cloud agent above all — is
  // TOLD the feature was skipped rather than left believing it landed.
  const buildWarnings = [];
  // cache key -> warning message for ops that skipped. The identity result is
  // deliberately NOT cached (a later build should re-attempt the feature after
  // upstream geometry changes — same key means same failure, so re-warning is
  // cheap), but a repeated call in the SAME session must still re-emit the
  // warning: without this map, a no-op re-apply would rebuild from warm caches
  // upstream, hit the recorded skip nowhere, silently re-fail and re-warn — fine
  // — but a memoized wrapper above us could also swallow the retry. Keeping the
  // message per key makes "skipped before, skipped again" deterministic and free.
  const skippedOps = new Map();
  // The one recorder. Shared, backend-neutral degrades (the extrude rim bevel in
  // rim-bevel.js, roundedBox's rim clamp in op-options.js, Shape2D's corner-op
  // clamps in contour-ops.js) reach it through the kernel's `_recordWarning`, so
  // every degrade in the build lands in one drainable list rather than only in
  // the console.
  const recordWarning = (msg) => { buildWarnings.push(msg); console.warn(`partforge: ${msg}`); };
  // k.implicit's engine warnings, keyed by the cached solid they belong to (re-recorded on a hit).
  const implicitWarnings = new WeakMap();
  // k.implicit solid -> the originalIDs its runs carry (meshOut's binding repair finds a
  // call's triangles by them).
  const implicitIds = new WeakMap();
  // k.subdiv's warnings (tolerance not met, a body through itself at preview), keyed by
  // the cached solid they belong to (re-recorded on a hit, as k.implicit's are).
  const subdivWarnings = new WeakMap();
  // A preview k.subdiv's limit mesh with each triangle's cage face, beside the cached
  // solid: what provenance.js matches a clicked triangle back to its cage face with.
  const subdivSources = new WeakMap();
  // A preview k.subdiv body with no creases, by the originalID its one run carries (and,
  // after a label(), the fresh id that run is re-stamped to): its rest limit mesh, the
  // cage's topology key and the level built. What toMesh({ ties: true }) ties the
  // delivered vertices to (subdiv/ties.js). Entries live as long as the cache entry.
  const subdivSkins = new Map();
  // k.implicit's automatic preview edge per tree hash (a pure function of the tree, so
  // never stale); cleared whole when it reaches AUTO_PREVIEW_MEMO trees.
  const autoPreviewEdges = new Map();
  // k.implicit's `solid` leaf fields, by solid `_hash` (a solid's hash names its geometry,
  // so an entry is never stale). The least recently used entry goes at MESH_FIELD_MEMO.
  const meshFields = new Map();
  const meshFieldOf = (solid) => {
    let f = meshFields.get(solid._hash);
    if (f !== undefined) { meshFields.delete(solid._hash); meshFields.set(solid._hash, f); return f; }
    f = buildMeshField(solid.toMesh());
    if (meshFields.size >= MESH_FIELD_MEMO) meshFields.delete(meshFields.keys().next().value);
    meshFields.set(solid._hash, f);
    return f;
  };
  // k.implicit's leaf samples across builds (implicit/sample-cache.js): a preview build
  // anchors its grid to the world lattice and reuses the samples a pose change did not
  // reach — the same bytes as a cold build. Bounded (SAMPLE_CACHE_BYTES); never used at print.
  const sampleCache = createSampleCache();
  // The preview k.implicit CALLS of the open sub-part bracket, in call order (the pose
  // bindings, mesh-bindings.js): `{ id, frames, shape }`, a call's slot being its index.
  // Reset when the outermost bracket opens and closes (brackets nest, as the solid
  // cache's do); outside a bracket nothing is recorded, so a toMesh there carries no
  // bindings and a call keys as slot 0. So a generate with `cache: false` (no bracket)
  // posts no bindings, and the oracle's buildView — one bracket per VIEW — runs slots on
  // across sub-parts (its framed implicits key apart from the display build's; their
  // bindings are never read there).
  let implicitCalls = [];
  let bracketDepth = 0;
  // Profile-validity warnings (profile-warnings.js): one warner per kernel so a
  // self-crossing profile built six times records ONE line; reset per drain.
  const profileWarner = makeProfileWarner(recordWarning);
  const skipFeature = (key, op, magnitude, err) => {
    const msg = `${op} ${magnitude} failed (${String(err?.message || err).slice(0, 200)}) — feature skipped, edges left sharp`;
    skippedOps.set(key, msg);
    recordWarning(msg);
  };
  const featureLabels = new Map(); // originalID -> label string (grows per label(); tiny)
  const oidPolicies = new Map();   // originalID -> shading policy (grows per faceted/hinted loft; tiny)
  // originalID -> analytic blend-surface descriptor in that original's own frame
  // (blend-surfaces.js; registered by mesh-fillet's tools through _markBlendSurface).
  // Keyed on geometry, not on use: a cached tool reused elsewhere IS that surface, so
  // the entry is true wherever the id shows up. Grows per fillet tool, like oidPolicies.
  const blendSurfaces = new Map();
  // name -> { m, digest, hash } | { error, digest } — imported geometry the framework
  // registers pre-build (ensureImports, Task 8). Kernel-lifetime, NOT tracked/T()'d:
  // these masters must survive cleanup() and be read again on every subsequent build.
  const imports = new Map();
  // name -> { digest, width, height, data } — depth-map grids the framework registers
  // pre-build via `_registerImage` (ensureImages, Task 4). Kernel-lifetime like
  // `imports` above: plain data, not WASM, so there is nothing to T()/dispose.
  const images = new Map();
  // Boundary ops route through cache.lookup; on a miss `make` runs the WASM op,
  // tracks the result, and returns the triple the cache needs to pin/dispose it.
  // Delete an embind handle once. Every WASM object a build makes is T()-tracked
  // for cleanup(), and the cached ones are ALSO owned by the solid cache, which
  // disposes them when a later round evicts them. Those two owners only stay
  // apart because cleanup() normally runs at the end of every build round and
  // empties `tracked` — a build that THROWS on a path without a finally-cleanup
  // (the oracle's measure(), a host's own build loop) leaves that round's new
  // cached solids on `tracked`; the next round evicts them, the cache deletes
  // them, and the cleanup after that deletes them again: "Manifold instance
  // already deleted", on every build for the rest of the kernel's life. Two
  // failing builds in a row was the reproduction (2026-09-18: plate → boss →
  // bad cut → hole → bad cut → anything). embind knows whether a handle is
  // gone, so both owners ask before deleting instead of trusting the other.
  const del = (o) => { if (!o?.isDeleted?.()) o?.delete?.(); };
  // Run lineage (run-lineage.js): per Manifold, the runs its mesh carries as
  // [{ id: originalID, mat: runTransform | null }], answered STRUCTURALLY — a
  // transform composes its operand's runs, a boolean concatenates its operands' —
  // so asking never forces Manifold to evaluate a lazy CSG tree. Keyed on the
  // Manifold rather than the wrapper so every re-wrap of one object (clone, a
  // skipped fillet, hoist/replay, a cache hit) shares the answer. A value is a
  // thunk until first asked, then the memoized array. With nothing recorded, a
  // fresh original (originalID() >= 0, identity transform) is its own single
  // run; anything else (a restamp that rebuilt from a mesh, a mixed solid built
  // outside these paths) reads the mesh ONCE — the documented fallback.
  const lineage = new WeakMap();
  const idMaps = new WeakMap(); // restamping ops: old originalID -> new
  const noteRuns = (mm, runs) => { if (!lineage.has(mm)) lineage.set(mm, runs); return mm; };
  const meshRuns = (mm) => {
    const g = mm.getMesh();
    try {
      const roid = g.runOriginalID, rt = g.runTransform;
      const runs = [];
      for (let r = 0; r < roid.length; r++)
        runs.push({ id: roid[r], mat: rt?.length >= (r + 1) * 12 ? affineAt(rt, r) : null });
      return dedupeRuns(runs);
    } finally {
      g.delete?.();
    }
  };
  const runsOf = (mm) => {
    let v = lineage.get(mm);
    if (Array.isArray(v)) return v;
    if (typeof v === "function") v = v();
    else { const id = mm.originalID(); v = id !== -1 ? [{ id, mat: null }] : meshRuns(mm); }
    lineage.set(mm, v);
    return v;
  };
  // `mm`'s runs carried by the affine `A` (applied after each run's own transform).
  const runsThrough = (mm, A) => () => runsOf(mm).map((r) => ({ id: r.id, mat: composeAffine(A, r.mat) }));
  // A boolean's runs: every operand's, deduplicated by run key.
  const runsOfAll = (solids) => () => dedupeRuns(solids.flatMap((s2) => s2._runs()));

  // A cached solid outlives its round's cleanup(), and its operands may not (an
  // uncached cylinder, a translate intermediate), so its lineage is resolved here,
  // while they are all alive. Structural lineage costs no mesh read; only a solid
  // with no recorded lineage and originalID() -1 reads its mesh, once.
  const cached = (hash, computeM) => cache.lookup(hash, () => {
    const m = computeM();                 // already T()-tracked by the op
    runsOf(m);
    return { value: wrap(m, hash), pin: m, dispose: () => del(m) };
  });

  // Booleans commute with any invertible affine map, so a transform EVERY operand
  // ends with can be lifted out of the boolean and applied to its result instead.
  // That is what collapses N identically-built copies into one evaluation: with the
  // shared transform gone, the operand hashes are identical for every copy, so the
  // boolean itself hits the cache. Returns null when nothing is shared, leaving the
  // caller on its ordinary path.
  const hoistBoolean = (opName, solids, evaluate) => {
    const { hoisted, residuals } = hoistCommonSuffix(solids.map((s2) => s2._canon.chain));
    if (!hoisted.length) return null;
    const ops = solids.map((s2, i) => replay(wrap(s2._canon.m, s2._canon.hash), residuals[i]));
    const canonical = cached(h(opName, ops.map((s2) => s2._hash)), () => noteRuns(evaluate(ops), runsOfAll(ops)));
    return replay(canonical, hoisted);
  };

  // Contour-IR region list -> flat point rings at `nSeg` (outer + holes, even/odd
  // fill sorts them out). The one place the IR meets CrossSection.ofPolygons.
  const regionPolys = (regions, nSeg) => regions.flatMap((rg) =>
    [tessellateContour(rg.outer, nSeg), ...rg.holes.map((hl) => tessellateContour(hl, nSeg))]);

  // 2-D boolean value: the SHARED Shape2D (shape2d.js). Storage is the curve-native
  // contour IR and every op — including `offset`, now the shared native engine — runs
  // on it in pure JS; no CrossSection is built until a shape is handed to a kernel op.
  // `extrude`/`revolve` are thunks because `kernel` below is defined after this.
  const shape2d = makeShape2dFactory({
    segs: segsAt, // the readbacks (toRegions/simple) tessellate at the same per-radius LOD as the kernel ops
    extrude: (o) => kernel.extrude(o),
    revolve: (o) => kernel.revolve(o),
    recordWarning,
    warnProfile: profileWarner.warn,
  });
  // Lazy CrossSection materialization, memoized through the solid cache by content
  // hash + LOD: the same shape extruded twice (or extruded and revolved) tessellates
  // once, and the cache's pin/dispose keeps the WASM object alive exactly as long as
  // the entry (cleanup() skips pinned objects).
  const csFor = (shape) => cache.lookup(h("cs2d", shape._hash, segs), () => {
    const cs = T(CrossSection.ofPolygons(regionPolys(shape._regions, segsAt), "EvenOdd"));
    return { value: cs, pin: cs, dispose: () => del(cs) };
  });
  // The same shape as a LATHE profile: its arcs sampled at the double-curvature count
  // (every sample becomes a full ring of the sweep — the quadratic cost circle-segs.js
  // describes), memoized apart from the extrude-facing tessellation above under its
  // own key. Keyed on the tier, not a count: the count varies per arc radius.
  const csForLathe = (shape) => cache.lookup(h("cs2d-lathe", shape._hash, quality), () => {
    const cs = T(CrossSection.ofPolygons(regionPolys(shape._regions, dcAt), "EvenOdd"));
    return { value: cs, pin: cs, dispose: () => del(cs) };
  });

  // decodeBindings' repair hooks for one MeshGL: a run whose originalID belongs to a bound
  // k.implicit call of this bracket gets its unbound (boolean-cut) vertices bound afresh by
  // that call's own bindVertices, after undoing the run's transform (positions are the
  // posed mesh's; the call bound in its own build frame). A label() or other re-stamp
  // that gives the run a fresh originalID loses the repair (its seam corners stay unbound).
  function bindingRepair(g) {
    if (!implicitCalls.some((c) => c.ids)) return {};
    const slotOf = new Map();
    implicitCalls.forEach((c, s) => { for (const id of c.ids ?? []) slotOf.set(id, s); });
    const roid = g.runOriginalID, rt = g.runTransform;
    return {
      runSlot: (r) => slotOf.get(roid[r]) ?? -1,
      rebind: (slot, r, xyz) => {
        const c = implicitCalls[slot];
        const M = rt && rt.length >= (r + 1) * 12 ? invertAffine(affineAt(rt, r)) : IDENTITY;
        if (!M) return null;
        const p = new Float64Array(xyz.length);
        for (let i = 0; i < xyz.length; i += 3) {
          const x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
          p[i] = M[0] * x + M[3] * y + M[6] * z + M[9];
          p[i + 1] = M[1] * x + M[4] * y + M[7] * z + M[10];
          p[i + 2] = M[2] * x + M[5] * y + M[8] * z + M[11];
        }
        return bindVertices(c.compiled, p, c.edge);
      },
    };
  }

  // Copy the mesh out into JS-owned arrays (so it survives cleanup) and free the
  // transient mesh handle.
  let activeProv = null; // provenance.js recorder, between beginProvenance/endProvenance
  function meshOut(m, asStl, opts) {
    settle(m);
    const g = m.getMesh();
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, { policies: oidPolicies, featureLabels, surfaces: blendSurfaces });
    if (!asStl) {
      const bindings = decodeBindings(g, implicitCalls, bindingRepair(g));
      if (bindings) r.bindings = bindings;
      const ties = opts?.ties ? skinTies(g, r.positions) : null;
      if (ties) r.ties = ties;
    }
    // Per-triangle param provenance, only while a build has provenance active.
    const o = !asStl && activeProv ? activeProv.originsFor(g) : null;
    if (o) { r.originIds = o.originIds; r.origins = o.origins; }
    g.delete?.();
    return r;
  }

  // The delivered (non-indexed, triVerts-order) mesh's ties to one k.subdiv body's limit
  // mesh: { key, level, tri, w } (subdiv/ties.js), or null. Null unless every skin run in
  // the mesh is the SAME preview, crease-free k.subdiv body with no transform on it (a
  // moved body would be placed in the wrong frame), and every vertex is tied — a unioned
  // piece's own vertices are not, so it sends none. Last, every vertex placed from its tie
  // on the rest limit mesh must land where it was delivered, inside its triangle (every
  // weight in [0, 1], or outside by float32 rounding at most: tiesHold): a wrong tie is
  // never sent.
  function skinTies(g, positions) {
    if (subdivSkins.size === 0) return null;
    const roid = g.runOriginalID, ri = g.runIndex, rt = g.runTransform, fid = g.faceID;
    const nTri = (g.triVerts.length / 3) | 0;
    let skin = null;
    for (let r = 0; r < roid.length; r++) {
      const rec = subdivSkins.get(roid[r]);
      if (!rec) continue;
      if ((skin && skin !== rec) || !isIdentityAt(rt, r, roid.length)) return null;
      skin = rec;
    }
    if (!skin || !fid || fid.length !== nTri || positions.length !== nTri * 9) return null;
    const faceTri = new Int32Array(nTri).fill(-1);
    for (let r = 0; r < roid.length; r++) {
      if (subdivSkins.get(roid[r]) !== skin) continue;
      for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) faceTri[t] = fid[t];
    }
    const t = tiesFor({ positions, faceTri, limitPositions: skin.positions, limitIndices: skin.indices });
    if (t.untied !== 0) return null;
    if (!tiesHold(t, positions, skin.positions, skin.indices)) return null;
    return { key: skin.key, level: skin.level, tri: t.tri, w: t.w };
  }
  // Fails closed: a missing or short transform is not identity. The one exception is a
  // mesh of ONE run with no transform array at all: Manifold gives a fresh original (an
  // import no boolean has touched yet, such as a bare k.subdiv) an empty runTransform, and
  // that run is in its own frame.
  const isIdentityAt = (rt, r, runs) => {
    if ((!rt || rt.length === 0) && runs === 1) return true;
    if (!rt || rt.length < (r + 1) * 12) return false;
    const M = affineAt(rt, r);
    for (let i = 0; i < 12; i++) if (Math.abs(M[i] - IDENTITY[i]) > 1e-7) return false;
    return true;
  };

  // Raw indexed mesh (positions x,y,z per vertex + triangle indices) for 3MF.
  function indexedMeshOut(m) {
    settle(m);
    const g = m.getMesh();
    const np = g.numProp, vp = g.vertProperties;
    const nVert = (vp.length / np) | 0;
    let positions;
    if (np === 3) {
      positions = Float32Array.from(vp);
    } else {
      positions = new Float32Array(nVert * 3);
      for (let i = 0; i < nVert; i++) { positions[i * 3] = vp[i * np]; positions[i * 3 + 1] = vp[i * np + 1]; positions[i * 3 + 2] = vp[i * np + 2]; }
    }
    const indices = Uint32Array.from(g.triVerts);
    g.delete?.();
    return { positions, indices };
  }

  // Mesh fillet/chamfer (mesh-fillet.js): the tool solids are built through the
  // kernel's own cached loft/revolve/boolean ops, so the whole op memoizes at
  // this boundary — and the result is simplify()ed to drop the zero-area sliver
  // triangles booleans legitimately leave behind (they are invisible but their
  // degenerate normals poison the crease pass into drawing phantom edge lines).
  // Unsupported edge classes (helical edges, varying dihedral, …) surface as
  // KernelCapabilityError so the framework reroutes that sub-part to OCCT.
  const SIMPLIFY_EPS = 1e-4; // 0.1 µm — must exceed the boolean's sliver widths (~2e-5)
  // Debris sweep: where blend tools graze each other or a flank near-tangentially, the
  // boolean can strand a CLOSED femto-component (measured ~1e-8 mm³, 4 triangles) that
  // simplify() cannot remove — it collapses edges, never whole components — and that
  // flips the result's genus/decompose count. Anything below DEBRIS_VOL is two orders
  // under the smallest feature the tessellation itself can express, and three under
  // anything printable, so dropping it can never erase real geometry.
  const DEBRIS_VOL = 1e-6; // mm³
  const dropDebris = (m) => {
    // Iterated, not single-pass: compose() re-welds, and a sliver riding a kept
    // component only as a vertex-weld can come apart as a FRESH femto-component
    // in the composed result (measured on the melt fixture's grazing neck arcs:
    // four needles dropped, two re-minted by the compose). Loop until a pass
    // drops nothing; volumes shrink every round, so three passes is plenty.
    for (let pass = 0; pass < 3; pass++) {
      const parts = m.decompose();
      if (parts.length <= 1) { for (const p of parts) T(p); return m; }
      const kept = [];
      for (const p of parts) { T(p); if (p.volume() >= DEBRIS_VOL) kept.push(p); }
      if (kept.length === parts.length) return m;
      m = T(Manifold.compose(kept));
    }
    return m;
  };
  // Blend surfaces KEEP their originalIDs, and every id the op introduced is
  // registered with the BLEND policy — that is what lets creased-normals draw the
  // band's start/end (a tangent blend↔base seam draws regardless of bend) while
  // blend↔blend handovers along one band stay invisible. This replaced a blanket
  // asOriginal(): folding the result into one fresh original made simplify able to
  // collapse boundary slivers, but it also erased the one distinction the boundary
  // lines need. The trade is stated honestly: simplify() cannot collapse across the
  // surviving run boundaries, so seam-adjacent slivers persist as triangles — they
  // are sub-MIN_EDGE thin, so the line pass gates them, and closed sliver DEBRIS is
  // swept above; the visible cost is a modestly larger mesh, bounded by
  // mesh-fillet-perf.test.js. Shading is unchanged (BLEND shades like SMOOTH), and
  // label() on a blend result re-stamps every run 1:1, so the distinction survives it.
  // Fresh ids for the roundAll decouple's blend-aware re-stamp: ONE base id
  // for every non-blend run, and one fresh id PER blend surface — each keeps its BLEND
  // policy and its analytic descriptor (runTransform rides through the MeshGL
  // round-trip, so the descriptor's original frame stays valid). Folding the band
  // into a single blend id, as this used to, lost every descriptor with it: a labeled
  // fillet shaded with facet normals again.
  //
  // "Blend" here is any surface that must keep an id of its own: a fillet band (the
  // boundaryLines policy) or a surface carrying an analytic descriptor at all —
  // roundAll's flat-face planes ride on a SMOOTH surface, and folding that into the
  // base id would drop them and bring the flat-face shading gradient back on every
  // labeled roundAll. Each keeps the policy it had (none, for the roundAll surface).
  const keepsOwnId = (oid) => !!oidPolicies.get(oid)?.boundaryLines || blendSurfaces.has(oid);
  const reserveBlendRestamp = (oids) => {
    const blends = [...oids].filter(keepsOwnId);
    const baseId = Manifold.reserveIDs(1 + blends.length);
    const blendIdFor = new Map(blends.map((oid, i) => [oid, baseId + 1 + i]));
    for (const [oid, id2] of blendIdFor) {
      const pol = oidPolicies.get(oid);
      if (pol !== undefined) oidPolicies.set(id2, pol);
      const surf = blendSurfaces.get(oid);
      if (surf) blendSurfaces.set(id2, surf);
    }
    return { baseId, blendIdFor, blendIds: [...blendIdFor.values()] };
  };
  const runOids = (mm) => { const g = mm.getMesh(); const s = new Set(g.runOriginalID); g.delete?.(); return s; };
  const meshCadOp = (op, baseM, run) => {
    try {
      const raw = run()._m;
      const baseOids = runOids(baseM);
      // the result's runs: the base's plus the blend tools', read off the mesh this
      // already materializes (a debris sweep below only ever drops runs)
      const rawRuns = meshRuns(raw);
      for (const { id: oid } of rawRuns) if (!baseOids.has(oid)) oidPolicies.set(oid, BLEND);
      // debris sweep AFTER simplify: the boolean's own femto-components are joined by
      // ones simplify() itself pinches off while collapsing seam slivers (measured:
      // 4-triangle atto-scale bubbles, one with negative volume, after a rim fillet
      // over vertical-fillet bands) — sweeping first missed those
      return noteRuns(dropDebris(T(raw.simplify(SIMPLIFY_EPS))), rawRuns);
    } catch (e) {
      if (e instanceof UnsupportedEdgeError) throw new KernelCapabilityError(`${op}: ${e.message}`);
      throw e;
    }
  };

  // roundAll prism fast path. Ball close-then-open via native Minkowski is
  // seconds-per-thousand-triangles (a text-outline backing measured 30+ s), but on
  // a Z-prism the SAME morphology decomposes: the 2-D close-open of the
  // cross-section (Clipper2 offsets +r, -2r, +r) supplies the wall melting and
  // hole sealing, and a selector-free fillet of the re-extruded section at r
  // supplies every rounded surface — vertical edges, both rims, and the corner
  // treatments. Returns a raw (tracked) manifold, or null to
  // keep the reference morphology — the fast path may only ever SUBSTITUTE for
  // it: any doubt (not a prism, plate too thin, everything melted, a fillet
  // refusal) falls back rather than widening or narrowing what roundAll accepts,
  // and roundAll must never surface NEEDS_OCCT (it is its own reference
  // implementation), which is why the whole attempt is fenced by a bare catch.
  const prismRoundAllFast = (m, mHash, r) => {
    let sect = null;
    try {
      sect = prismSection(wasm, m);
      if (!sect) return null;
      const { cs, z0, h: height } = sect;
      // the erosion consumes the whole plate below 2r, and just above it the two
      // rim bands graze each other — both belong to the reference morphology
      if (!(height > 2 * r * 1.05)) return null;
      // Join types are per-STEP, because a join only acts on the side an offset
      // DIVERGES on. The two dilates diverge at SALIENT corners and use MITER,
      // deliberately: the true morphology mints salient corners of radius
      // exactly r, and a rim fillet of radius r over an r-radius salient corner
      // pinches its top tangent contour to a point — the planar sweep refuses,
      // structurally. Miter keeps them SHARP instead and the selector-free
      // fillet below performs their rounding (cutters at r — the same solid the
      // round join would have produced — plus the corner treatments). The erode
      // diverges at REFLEX corners and uses ROUND: the ball morphology rounds a
      // reflex corner into a radius-r concave arc (2r at the erode, halved by
      // the re-dilate), and a concave arc offsets INWARD to 2r, so it cannot
      // pinch the rim sweep — the rim rides it as an ordinary arc-in-planar
      // chain. Keeping reflex corners sharp instead (all-Miter, the original
      // design) handed the fillet a sharp vertical filler PLUS a sharp rim
      // corner at once, and the filler — unioned after the cutters — re-covered
      // the rim tools' corner cut, reintroducing the uncut-wedge point artifact
      // the reflex pivot exists to remove. Melt and seal thresholds stay exact
      // on straight stretches; salient-corner silhouettes differ from the ball
      // morphology by the rim fillet's own corner tolerance (~0.25·r) — the
      // documented corner trade — while reflex corners now match it exactly.
      //
      // Arc facets must stay well under the fillet's sharp-edge threshold
      // (detectSharpEdges' 20° default) or the rounded wall would re-detect as a
      // run of sharp vertical edges: floor the round join at 36 segments/360°
      // (10° per facet) even when the sagitta rule alone would allow coarser.
      const arcSegs = Math.max(roundAllSegs(2 * r, quality), 36);
      let cur = null;
      try {
        for (const delta of [r, -2 * r, r]) {
          const next = (cur ?? cs).offset(delta, delta > 0 ? "Miter" : "Round", 2, arcSegs);
          const cleaned = next.simplify(1e-6);
          next.delete?.();
          cur?.delete?.();
          cur = cleaned;
        }
        if (!(cur.area() > 0)) return null; // everything melted — reference path owns the empty result
        let base = T(Manifold.extrude(cur, height));
        if (z0 !== 0) base = T(base.translate([0, 0, z0]));
        const wrapped = wrap(base, h("roundAllPrismBase", mHash, r, quality));
        // selector-free: every sharp edge of the mitered prism gets its radius here.
        // The THROWING form deliberately: this path's answer to a failed fillet is
        // the `catch` below, which returns null and hands the job to the reference
        // Minkowski roundAll. The degrading public fillet would instead hand back
        // the un-rounded prism, and this function would emit it as a successful
        // roundAll — silently wrong geometry instead of a correct slow result.
        const filleted = wrapped._filletRaw(r);
        // Decouple from the fillet cache's pin: cached() will pin the object this
        // returns under the roundAll hash, and one WASM object must never sit
        // under two cache entries (double-dispose on eviction). The decouple is
        // blend-AWARE: a blanket asOriginal()
        // folded blend and base into one fresh surface, erasing the distinction
        // the band-boundary lines need — a roundAll'd prism rendered with no
        // feature lines at all, unlike the identical geometry from fillet().
        // Re-stamp onto fresh reserved ids instead — one base id (unregistered →
        // SMOOTH, the extruded section has no policy of its own) and one per blend
        // surface (reserveBlendRestamp) — so the result draws exactly the lines, and
        // shades with exactly the normals, the fillet did.
        const g0 = filleted._m.getMesh();
        try {
          const isBlend = (oid) => !!oidPolicies.get(oid)?.boundaryLines;
          const oids0 = new Set(g0.runOriginalID);
          if (![...oids0].some(isBlend)) {
            const o = T(filleted._m.asOriginal());
            idMaps.set(o, new Map([...oids0].map((oid) => [oid, o.originalID()])));
            return o;
          }
          const { baseId, blendIdFor } = reserveBlendRestamp(oids0);
          const idMap = new Map([...oids0].map((oid) => [oid, blendIdFor.get(oid) ?? baseId]));
          const rt = g0.runTransform;
          const runs = dedupeRuns(Array.from(g0.runOriginalID, (oid, r) =>
            ({ id: idMap.get(oid), mat: rt?.length >= (r + 1) * 12 ? affineAt(rt, r) : null })));
          g0.runOriginalID = Uint32Array.from(g0.runOriginalID, (o) => idMap.get(o));
          // The constructor re-welds, and that can pinch a latent sliver off a
          // component as fresh femto-debris (the same rebirth dropDebris's own
          // compose() loop guards against) — sweep the reconstruction too.
          const o = noteRuns(dropDebris(T(new Manifold(g0))), runs);
          idMaps.set(o, idMap);
          return o;
        } finally {
          g0.delete?.();
        }
      } finally {
        cur?.delete?.();
      }
    } catch {
      return null;
    } finally {
      sect?.cs?.delete?.();
    }
  };

  // The reference roundAll's flat faces (mesh-roundall.js flatFacePlanes): the
  // input's flat faces, which the chain returns exactly to their planes, become a
  // "planes" descriptor on the result's surface so creased-normals shades them —
  // and the band's seams beside them — with the plane's own normal. The tolerance
  // sits well under the first ring of band vertices off each face (the same ring
  // meshRoundAll's simplify tolerance protects), so only the face and its seam
  // vertices are on a plane. Keyed on geometry like every descriptor (see
  // blendSurfaces above), so it is never removed with the cache entry.
  //
  // offset() reuses it with `moveTo`: a single dilate/erode step moves each flat
  // face along its normal instead of returning it to its plane, so the planes are
  // moved to where the step put them before they are registered. `r` and `segs`
  // are the ball the step used (the tolerance rule is the same).
  const markFlatFaces = (input, out, r, segs = roundAllSegs(2 * r, quality), moveTo = null) => {
    const gi = input.getMesh();
    let planes;
    try {
      planes = flatFacePlanes(gi, { policyFor: (oid) => oidPolicies.get(oid) });
    } finally {
      gi.delete?.();
    }
    if (moveTo) planes = planes.map(moveTo);
    if (!planes.length) return out;
    const tol = Math.min(1e-3, 0.25 * r * (1 - Math.cos((2 * Math.PI) / segs)));
    const go = out.getMesh();
    try {
      const roid = go.runOriginalID, rt = go.runTransform;
      for (let i = 0; i < roid.length; i++) {
        // a fresh original carries no runTransform at all — identity, as creased-normals reads it
        const inv = rt && rt.length >= (i + 1) * 12 ? invertAffine(affineAt(rt, i)) : IDENTITY;
        if (inv) blendSurfaces.set(roid[i], mapSurface({ kind: "planes", planes, tol }, inv));
      }
    } finally {
      go.delete?.();
    }
    return out;
  };

  // Replay a recorded transform chain onto a solid. Each record maps back to the op
  // that produced it, so the replayed solid rebuilds the same chain on its own canon.
  const replay = (solid, chain) => chain.reduce(
    (s2, r) => (r.op === "translate" ? s2.translate(r.v) : s2.rotate(r.deg, r.center, r.axis)), solid);

  // `canon` is this solid expressed as a base solid plus the trailing transform chain
  // applied to it (oldest first). Only ops that provably COMMUTE with a rigid
  // transform extend the chain — translate, rotate, and label; everything else starts
  // a fresh canonical base. fillet/chamfer are deliberately excluded even though they
  // look eligible: their edge selectors can be world-space, so filleting the
  // untranslated base would pick different edges — wrong geometry, not a missed hit.
  //
  // `self` names the wrapper being built so the degrading public fillet/chamfer
  // can delegate to their throwing `_`-prefixed twins above without re-deriving
  // the cache key or the capability checks. Declared as a binding the closures
  // capture: every reference runs after addSugar has returned.
  //
  // `runs` (a thunk or an array) is this solid's run lineage, when the op knows it
  // structurally; `idMap` (old originalID -> new) marks a restamping op's result.
  // Both are recorded against `m` (see `lineage` above), so re-wraps share them.
  // A rigid transform moves runs without renaming them, so its result inherits
  // its operand's idMap: label's replay below hands the provenance recorder the
  // TRANSFORMED labelled solid, and only the idMap tells it which old id each
  // fresh id came from (without it, a label after a translate kept no records).
  const wrap = (m, hash, canon = { m, hash, chain: [] }, { runs, idMap } = {}) => {
    if (runs) noteRuns(m, runs);
    if (idMap) idMaps.set(m, idMap);
    // Every method that reads this solid's geometry or builds a new base on it judges a
    // deferred union under it first (settle, above); translate/rotate/clone carry the
    // node in their canon instead.
    const S = () => { settle(m); if (canon.m !== m) settle(canon.m); };
    const self = addSugar({
    _m: m,
    _hash: hash,
    _canon: canon,
    _runs: () => runsOf(m),
    ...(idMaps.has(m) ? { _idMap: idMaps.get(m) } : {}),
    cut: (t) => { S(); settleSolid(t); return cached(h("cut", hash, t._hash), () => noteRuns(judged("cut", [m, t._m], T(m.subtract(t._m))), runsOfAll([self, t]))); },
    // THROWING forms. These are the composition primitives — internal callers
    // that have their own recovery (prismRoundAllFast, which answers a failed
    // fillet by falling back to the reference Minkowski roundAll) must use
    // these, never the degrading public ops below: a skip there would emit an
    // UN-rounded prism as a successful roundAll, which is silently wrong
    // geometry rather than a reported missing feature.
    _filletRaw: (r, selector) => {
      if (typeof selector === "function") throw new KernelCapabilityError("fillet: function selectors need the OCCT backend");
      if (r === 0) return wrap(m, hash); // contract: zero magnitude is the identity
      S();
      return cached(h("fillet", hash, r, selector ?? null, segs), () =>
        meshCadOp("fillet", m, () => meshFillet(kernel, wrap(m, hash), { r, edges: selector, segs, segsAt })));
    },
    _chamferRaw: (d, selector) => {
      if (typeof selector === "function") throw new KernelCapabilityError("chamfer: function selectors need the OCCT backend");
      if (d === 0) return wrap(m, hash);
      S();
      return cached(h("chamfer", hash, d, selector ?? null, segs), () =>
        meshCadOp("chamfer", m, () => meshChamfer(kernel, wrap(m, hash), { d, edges: selector, segs, segsAt })));
    },

    // The AUTHOR-FACING ops degrade on failure instead of failing the build (the
    // OCCT backend's safeOp policy — see occt-repair.js): a defeated op returns
    // the INPUT solid and records a feature-skip warning. Only NEEDS_OCCT
    // capability errors still propagate — they are the split-backend reroute
    // signal, not a geometry failure, and swallowing one would strand the
    // sub-part on the wrong backend. The skip result is not cached: same key →
    // same failure → same cheap re-warn, while an upstream geometry change mints
    // a new key and genuinely re-attempts the feature.
    fillet: (r, selector) => {
      S(); // a refused union must throw here, not degrade into a skipped fillet
      const key = h("fillet", hash, r, selector ?? null, segs);
      const skipped = skippedOps.get(key);
      if (skipped !== undefined) { buildWarnings.push(skipped); return wrap(m, hash); }
      try {
        return self._filletRaw(r, selector);
      } catch (e) {
        if (e?.code === "NEEDS_OCCT") throw e;
        skipFeature(key, "fillet", r, e);
        return wrap(m, hash);
      }
    },
    chamfer: (d, selector) => {
      S();
      const key = h("chamfer", hash, d, selector ?? null, segs);
      const skipped = skippedOps.get(key);
      if (skipped !== undefined) { buildWarnings.push(skipped); return wrap(m, hash); }
      try {
        return self._chamferRaw(d, selector);
      } catch (e) {
        if (e?.code === "NEEDS_OCCT") throw e;
        skipFeature(key, "chamfer", d, e);
        return wrap(m, hash);
      }
    },
    roundAll: (r) => {
      if (r === 0) return wrap(m, hash); // contract: zero magnitude is the identity
      S();
      // `quality` in the key is redundant but harmless — the cache lives on a
      // per-quality kernel, so it can never collide across tiers (the OCCT twin
      // key omits it for the same reason); it just spells out that the ball
      // tessellation, and so the result, is tier-dependent.
      return cached(h("roundAll", hash, r, quality), () =>
        prismRoundAllFast(m, hash, r) ?? markFlatFaces(m, T(meshRoundAll(wasm, m, r, quality)), r));
    },
    // Ball offset (mesh-roundall.js meshOffset): one dilate or erode, never
    // routed, never NEEDS_OCCT. An erode deeper than the solid's half-thickness
    // consumes it — the empty result is the honest answer, not a failure.
    offset: (d) => {
      if (!Number.isFinite(d)) throw new Error(`offset: d must be a finite number (got ${d})`);
      if (d === 0) return wrap(m, hash); // contract: zero magnitude is the identity
      S();
      return cached(h("offset", hash, d, quality), () => {
        const { out, support, segs: ballSegs } = meshOffset(wasm, m, d, quality);
        const sign = Math.sign(d); // a dilate moves a face out by h(n), an erode in by h(n)
        return markFlatFaces(m, T(out), Math.abs(d), ballSegs, (p) => ({ n: p.n, d: p.d + sign * support(p.n) }));
      });
    },
    // batch difference: first minus the union of the rest, evaluated as one boolean
    // tree — no materialized intermediate union (the unionRaw memory note applies)
    cutAll: (tools) => {
      S(); for (const t of tools) settleSolid(t);
      return cached(h("cutAll", hash, tools.map((t) => t._hash)), () => {
        const ms = [m, ...tools.map((t) => t._m)];
        return noteRuns(judged("cutAll", ms, T(Manifold.difference(ms))), runsOfAll([self, ...tools]));
      });
    },
    intersect: (t) => { S(); settleSolid(t); return cached(h("intersect", hash, t._hash), () =>
      noteRuns(judged("intersect", [m, t._m], T(m.intersect(t._m))), runsOfAll([self, t]))); },
    union: (t) => { S(); settleSolid(t); return cached(h("union", [hash, t._hash]), () =>
      noteRuns(judged("union", [m, t._m], unionRaw([m, t._m])), runsOfAll([self, t]))); },
    clone: () => wrap(m, hash),
    // Name this solid's surface for hover/pick feature attribution. Fresh reserved
    // originalIDs survive transforms and booleans, so every surviving triangle of
    // this surface can be traced back to the label. The registry entries live exactly as long as the cache pins the solid — eviction
    // disposes both, so the registry can't grow unboundedly across regenerates.
    label: (name) => {
      S();
      // Labeling only re-stamps surface ids, so it commutes with the trailing
      // transform. This is load-bearing rather than an optimization: the common
      // authoring idiom labels each piece AFTER positioning it, which would give every
      // copy its own canonical base and stop the hoist below from ever firing.
      if (canon.chain.length) {
        // The replayed result is a fresh wrapper over a transformed Manifold: hand
        // it the base label's id map, or provenance would see runs with new ids and
        // no way back to the records made under the old ones.
        const base = wrap(canon.m, canon.hash).label(name);
        const out = replay(base, canon.chain);
        if (base._idMap && out !== base) { idMaps.set(out._m, base._idMap); out._idMap = base._idMap; }
        return out;
      }
      const lh = h("label", hash, name);
      return cache.lookup(lh, () => {
        // Re-stamp every distinct originalID 1:1 onto fresh reserved ids. Folding
        // them into one id (asOriginal(), or one base id beside the blend ids) would
        // erase per-face provenance: the sector creases and dividing lines of a
        // sectored loft, the band-boundary lines of a blend, the seam between a loft
        // and the tool that hollowed it, and the face a later pick names. Instead
        // each new id inherits its old id's shading policy and analytic surface
        // (an id with no policy keeps none and shades SMOOTH by default), and every
        // new id maps to the one label string — creased-normals merges ids with the
        // same label into one feature entry. Reserved ids are fresh, so reusing a
        // cached solid under another label cannot collide.
        const g0 = m.getMesh();
        let o, idMap, runs;
        try {
          const olds = [...new Set(g0.runOriginalID)];
          const base2 = Manifold.reserveIDs(olds.length);
          idMap = new Map(olds.map((o2, i2) => [o2, base2 + i2]));
          const rt = g0.runTransform;
          runs = dedupeRuns(Array.from(g0.runOriginalID, (oid, r) =>
            ({ id: idMap.get(oid), mat: rt?.length >= (r + 1) * 12 ? affineAt(rt, r) : null })));
          g0.runOriginalID = Uint32Array.from(g0.runOriginalID, (o2) => idMap.get(o2));
          // The constructor re-welds, and that can pinch a latent sliver off as
          // fresh femto-debris (the fillet restamp above sweeps for the same reason).
          o = noteRuns(dropDebris(T(new Manifold(g0))), runs);
        } finally {
          g0.delete?.();
        }
        for (const [oldId, newId] of idMap) {
          featureLabels.set(newId, name);
          const pol = oidPolicies.get(oldId);
          if (pol !== undefined) oidPolicies.set(newId, pol);
          const surf = blendSurfaces.get(oldId);
          if (surf) blendSurfaces.set(newId, surf);
          const skin = subdivSkins.get(oldId);
          if (skin) subdivSkins.set(newId, skin);
        }
        const newIds = [...idMap.values()];
        return { value: wrap(o, lh, undefined, { runs, idMap }), pin: o, dispose: () => {
          for (const id2 of newIds) { featureLabels.delete(id2); oidPolicies.delete(id2); blendSurfaces.delete(id2); subdivSkins.delete(id2); }
          o.delete?.();
        } };
      });
    },
    boundingBox: () => {
      S();
      const b = m.boundingBox();           // { min: Vec3, max: Vec3 } — addSugar derives center/size
      return { min: [...b.min], max: [...b.max] };
    },
    volume: () => { S(); return m.volume(); },
    genus: () => { S(); return m.genus(); },
    isEmpty: () => { S(); return m.isEmpty(); },
    translate: (v) => wrap(T(m.translate(v)), h("translate", hash, v),
      { m: canon.m, hash: canon.hash, chain: [...canon.chain, { op: "translate", v }] },
      { runs: runsThrough(m, translateAffine(v)), idMap: idMaps.get(m) }),
    rotate: (deg, center, axis) => {
      const nz = (axis[0] !== 0) + (axis[1] !== 0) + (axis[2] !== 0);
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = nz <= 1
        ? T(a.rotate([axis[0] * deg, axis[1] * deg, axis[2] * deg]))   // basis axis — euler is exact; unchanged
        : T(a.transform(axisAngleMat4(axis, deg)));                    // general axis-angle
      // A basis-axis euler rotate turns by the component itself (axis [0,0,2] turns
      // 2·deg): rotateAffine normalizes the axis, so hand it the scaled angle.
      const turn = nz <= 1 ? deg * Math.hypot(axis[0], axis[1], axis[2]) : deg;
      return wrap(T(b.translate(center)), h("rotate", hash, deg, center, axis),
        { m: canon.m, hash: canon.hash, chain: [...canon.chain, { op: "rotate", deg, center, axis }] },
        { runs: runsThrough(m, rotateAffine(turn, center, axis)), idMap: idMaps.get(m) });
    },
    mirror: (plane) => { S(); return wrap(T(m.mirror(PLANE_NORMAL[plane])), h("mirror", hash, plane), undefined,
      { runs: runsThrough(m, mirrorAffine(PLANE_NORMAL[plane])), idMap: idMaps.get(m) }); },
    scale: (factor, center) => { // factor validated (and center defaulted) by addSugar
      S();
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.scale([factor, factor, factor]));
      return wrap(T(b.translate(center)), h("scale", hash, factor, center), undefined,
        { runs: runsThrough(m, scaleAffine(factor, center)), idMap: idMaps.get(m) });
    },
    // `ties: true` adds a k.subdiv body's ties (skinTies) when it has them.
    toMesh: (opts) => { S(); return meshOut(m, false, opts); },
    toSTL: () => { S(); return Promise.resolve(meshOut(m, true)); },
    toIndexedMesh: () => { S(); return indexedMeshOut(m); },
    });
    return self;
  };

  const kernel = finishKernel({
    // The primitives are cache nodes, cheap as they are: a cached op downstream (a
    // boolean, a label) hands back the solid its first run made, whose runs carry
    // that run's originalIDs. A primitive re-minted per build would get a fresh id
    // each time and every provenance record made before the cached op would be
    // orphaned from the second build on. Hash-consed, equal args are one solid
    // with one id, for as long as anything built from it is retained.
    cylinder: (rb, rt, h2, { center = false } = {}) => {
      const n = segsAt(Math.max(rb, rt)); // a cone is sized by its wider end
      return cached(h("cylinder", rb, rt, h2, center, n), () => T(Manifold.cylinder(h2, rb, rt, n, center)));
    },
    // Compound op: hashed ATOMICALLY from its own args, so it is a single cache
    // node — its internal cylinders/cut are never retained. The template for
    // future compounds: build internals with T(), return the final tracked solid.
    boredCylinder: ({ od, h: height, bore }) => cached(h("boredCylinder", od, height, bore, segsAt(od / 2), segsAt(bore / 2)), () => {
      const body = T(Manifold.cylinder(height, od / 2, od / 2, segsAt(od / 2), false));
      const tool0 = T(Manifold.cylinder(height + 4, bore / 2, bore / 2, segsAt(bore / 2), false));
      const tool = T(tool0.translate([0, 0, -2])); // raw ops: track each result
      return noteRuns(T(body.subtract(tool)),
        [{ id: body.originalID(), mat: null }, { id: tool0.originalID(), mat: translateAffine([0, 0, -2]) }]);
    }),
    // Rounded box: ONE hand-meshed ring stack (no booleans) whose cross-
    // sections follow the normative formula (rounded-solids.js / the design
    // spec). Reuses loftMesh's stitch/cap/winding machinery. Atomic cache
    // node hashed from its own args, like boredCylinder.
    roundedBox: ({ size, center, round }) => cached(
      h("roundedBox", size, center, round.side, round.top, round.bottom, roundedBoxArcSamples(segsAt(Math.max(round.side, round.top, round.bottom)), dcAt(Math.max(round.side, round.top, round.bottom)))),
      () => {
        // One count serves every corner and rim arc, so it is sized for the largest.
        const rMax = Math.max(round.side, round.top, round.bottom);
        const solid = T(loftMesh(wasm, roundedBoxRings(size, round, segsAt(rMax), roundedBoxArcSamples(segsAt(rMax), dcAt(rMax)))));
        if (!center) return solid;
        const lift = [0, 0, -size[2] / 2];
        return noteRuns(T(solid.translate(lift)), runsThrough(solid, translateAffine(lift)));
      }),
    // Sized by the double-curvature rule (circle-segs.js: a sphere spends the per-circle
    // count squared), on both tiers — the hash carries the count, so a sphere built at
    // one tier never masquerades as the other's in the cache.
    sphere: (r) => cached(h("sphere", r, dcAt(r)), () => T(Manifold.sphere(r, dcAt(r)))),
    box: (min, max) => cached(h("box", min, max), () => {
      const cube = T(Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
      return noteRuns(T(cube.translate(min)), runsThrough(cube, translateAffine(min)));
    }),
    prism: (pts, height, { twist = 0, scaleTop = 1 } = {}) =>
      cached(h("prism", pts, height, twist, scaleTop, segs), () => {
        // Even/odd like `extrude` below and like the OCCT prism, so the outline's
        // winding does not matter. Under Manifold's default Positive rule a
        // CLOCKWISE outline filled nothing: the extrude came back
        // InvalidConstruction and the next boolean reported an "impossible
        // result" (118 production builds in two weeks, every one a 0 mm³ result).
        const cs = T(CrossSection.ofPolygons([tessellateContour(pts, segsAt)], "EvenOdd"));
        if (cs.isEmpty()) throw emptyProfile("prism");
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
        // Manifold's extrude scaleTop is a Vec2 — a scalar is NOT broadcast (it scales
        // X and drives Y to 0, squishing the top to a line). Broadcast for a uniform taper.
        return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
      }),
    // Height-map relief. The grid → triangle conversion is a pure leaf shared with
    // the OCCT backend (heightfield.js), so both kernels build from identical
    // triangle data. `manifoldFromMesh`'s output is NOT self-tracked (see its own
    // header comment — "caller tracks `out`") so, unlike `import`'s master, this
    // build wraps it in T() itself: a heightfield solid is an ordinary per-build
    // result, not a kernel-lifetime master.
    heightfield: (src, opts = {}) => {
      const grid = typeof src === "string" ? images.get(src) : src;
      if (!grid) throw new Error(`heightfield: unknown image "${src}" — declare it in the part's \`images\` field`);
      const build = () => {
        const { positions, indices, warnings } = heightfieldMesh(grid, opts);
        // Only runs on a cache MISS for a registered image (every call for an
        // inline grid, which always takes the bypass below). A repeat build of
        // the same registered image at the same options is a cache HIT and never
        // re-enters this closure, so a pitch-clamp warning is NOT re-emitted on
        // a warm rebuild — intentional dedup (same call, same warning, once),
        // not a missed re-warn.
        for (const w of warnings) recordWarning(w);
        return T(manifoldFromMesh(wasm, positions, indices));
      };
      // Only a registered image carries a content digest to key the cache on. An
      // inline {width,height,data} grid has no identity of its own — keying it on a
      // literal string like "inline" would let two DIFFERENT inline grids at the
      // same options collide on the same cache key, and the second call would
      // silently get back the FIRST call's solid. Skip the cache for those; the
      // inline path is the test/low-level path and isn't performance-sensitive.
      // (The returned solid still gets a real content-fingerprint hash below, so a
      // downstream union/cut composing two different inline heightfields doesn't
      // inherit the same collision risk one level up.)
      if (typeof src !== "string") {
        return wrap(build(), h("heightfield-inline", grid.width, grid.height, hashGridData(grid.data),
          opts.w, opts.d, opts.base, opts.maxZ, opts.pitch, opts.invert, opts.range, opts.origin));
      }
      return cached(
        h("heightfield", grid.digest, opts.w, opts.d, opts.base, opts.maxZ,
          opts.pitch, opts.invert, opts.range, opts.origin),
        build,
      );
    },
    // The reference compare view (oracle/compare.js): the part `a` and its reference
    // `b` in, three solids out that share no volume — common, missing (in `b` only)
    // and excess (in `a` only). A difference piece whose mean thickness (2V/A) is
    // under `tolerance` is a facet skin, not a feature: it is dropped, and so stays
    // part of `common` = (a ∪ b) − missing − excess. Refused before any boolean when
    // the two together pass the triangle ceiling, or when either is empty. Never
    // cached, and every WASM object is T()-tracked, so the caller's cleanup() frees
    // the intermediates (the returned solids live until that cleanup too). The
    // default ceiling is COMPARE_MAX_TRIANGLES, written as a literal because the
    // kernel must not import ./oracle/* (the kit never loads it; kit-layering.test.js).
    _compareSolids: (a, b, { tolerance = 0, maxTriangles = 300000 } = {}) => {
      settleSolid(a); settleSolid(b);
      if (a._m.numTri() + b._m.numTri() > maxTriangles) return { skipped: "too-large" };
      if (a._m.isEmpty() || b._m.isEmpty()) return { skipped: "not-closed" };
      const regions = [];
      const thick = (mm, change) => {
        const kept = [];
        let total = 0;
        for (const piece of mm.decompose()) {
          T(piece);
          const v = piece.volume(), area = piece.surfaceArea();
          if (!(v > 1e-6 && area > 0 && (2 * v) / area >= tolerance)) continue;
          kept.push(piece);
          total += v;
          const { min, max } = piece.boundingBox();
          regions.push({
            change,
            mm3: v,
            at: [0, 1, 2].map((i) => (min[i] + max[i]) / 2),
            size: [0, 1, 2].map((i) => max[i] - min[i]),
          });
        }
        return { m: kept.length ? T(Manifold.compose(kept)) : null, volume: total };
      };
      const missing = thick(T(b._m.subtract(a._m)), "missing");
      const excess = thick(T(a._m.subtract(b._m)), "excess");
      let common = T(a._m.add(b._m));
      if (missing.m) common = T(common.subtract(missing.m));
      if (excess.m) common = T(common.subtract(excess.m));
      const out = (m, tag) => (m ? wrap(m, h("compare", tag, a._hash, b._hash, tolerance)) : null);
      regions.sort((x, y) => y.mm3 - x.mm3);
      return {
        common: out(common.isEmpty() ? null : common, "common"),
        missing: out(missing.m, "missing"),
        excess: out(excess.m, "excess"),
        missingVolume: missing.volume,
        excessVolume: excess.volume,
        regions: regions.slice(0, 8),
      };
    },
    // The change tracker's boolean diff (oracle/changes.js): two plain meshes in,
    // added (new − old) and removed (old − new) material out, split into connected
    // pieces. Never cached — it runs outside any beginSubPart bracket — and every
    // WASM object is T()-tracked, so the caller's cleanup() frees all of it.
    _meshDiff: (oldMesh, newMesh, { maxTriangles = 300000, minVolume = 0 } = {}) => {
      const tris = (mesh) => (mesh.indices?.length ?? 0) / 3;
      if (tris(oldMesh) + tris(newMesh) > maxTriangles) return { ok: false, reason: "too-large" };
      let a, b;
      try {
        a = T(manifoldFromMesh(wasm, oldMesh.positions, oldMesh.indices));
        b = T(manifoldFromMesh(wasm, newMesh.positions, newMesh.indices));
      } catch {
        return { ok: false, reason: "not-watertight" };
      }
      const regions = (mm) => {
        const pieces = mm.decompose().map((p) => T(p));
        return pieces
          .map((p) => {
            const { min, max } = p.boundingBox();
            return {
              mm3: p.volume(),
              at: [0, 1, 2].map((i) => (min[i] + max[i]) / 2),
              size: [0, 1, 2].map((i) => max[i] - min[i]),
            };
          })
          .filter((r) => r.mm3 >= minVolume)
          .sort((x, y) => y.mm3 - x.mm3);
      };
      const added = T(b.subtract(a));
      const removed = T(a.subtract(b));
      return {
        ok: true,
        addedMm3: added.volume(),
        removedMm3: removed.volume(),
        added: regions(added),
        removed: regions(removed),
      };
    },
    // Polygon-with-holes extrude in one op: even/odd fill turns the extra contours into
    // holes regardless of their winding (outer + holes, no per-hole boolean cut).
    // A Shape2D `profile` (curve-native, possibly multi-region) materializes through
    // csFor — one memoized tessellation per shape+LOD — and folds into the cache key
    // by `_hash` like any other solid operand.
    // `_twistDivisions` is screwSweep's (kernel-front.js): the twist split at the
    // thread's own step instead of the flat 5°. Not an author option — it reaches
    // here only through the positional form the options validator never sees.
    extrude: (profile, height, { twist = 0, scaleTop = 1, _twistDivisions } = {}) => {
      const shape = profile && profile._shape2d ? profile : null;
      const divKey = _twistDivisions === undefined ? [] : [_twistDivisions];
      return cached(h("extrude", shape ? shape._hash : profile, height, twist, scaleTop, segs, ...divKey), () => {
        const cs = shape ? csFor(shape) : (() => {
          const { outer, holes } = tessellateProfile(profile, segsAt);
          return T(CrossSection.ofPolygons([outer, ...holes], "EvenOdd"));
        })();
        if (cs.isEmpty()) throw emptyProfile("extrude");
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = _twistDivisions ?? Math.max(1, Math.ceil(Math.abs(twist) / 5));
        return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
      });
    },
    // Ring loft: hand-meshed via the shared ring-mesh helpers (helix-tube recipe).
    // Cached atomically; the hash folds every ring's points/z/rotate/scale and the
    // opts (including `shading`, so toggling the hint is a fresh cache node).
    // Sectored lofts (curve/resample rings with sharp features or silhouette kinks)
    // come back already stamped with reserved per-run original IDs, whose policies
    // loftMesh reports through the out-param — register them all and never
    // asOriginal() (it would fold the runs into one surface and erase every
    // provenance crease). Unsectored lofts keep the legacy single-surface path:
    // asOriginal() + one inferred policy. Either way the registrations live
    // exactly as long as the cache pins the solid.
    loft: (rings, opts = {}) => {
      const key = h("loft", loftRingsKey(rings), opts);
      return cache.lookup(key, () => {
        const rl = resolveLoftRings(rings);        // resolve once: mesh + shading share it
        const runPol = new Map();
        const raw = T(loftMesh(wasm, rl, opts, runPol));
        if (runPol.size > 0) {
          for (const [oid, pol] of runPol) oidPolicies.set(oid, pol);
          return { value: wrap(raw, key), pin: raw, dispose: () => {
            for (const oid of runPol.keys()) oidPolicies.delete(oid);
            raw.delete?.();
          } };
        }
        const m = T(raw.asOriginal());
        const id = m.originalID();
        oidPolicies.set(id, loftShadingPolicy(rl, opts));
        return { value: wrap(m, key), pin: m, dispose: () => { oidPolicies.delete(id); m.delete?.(); } };
      });
    },
    // Signed-distance tree → solid (implicit/index.js). The engine meshes at the
    // tier's grid (`preview` for preview, `resolution` for print) — the preview
    // tier also decimates in cleanup (PREVIEW_CLEANUP), print does not — and hands
    // Manifold one welded mesh; the result shades ORGANIC (one smooth skin: no
    // same-surface feature lines, normals smoothed through detail grooves).
    // Cached on the spec plus every bound image's digest, per quality tier; the key
    // holds only this tier's grid (defaulted), so editing the other tier's grid is
    // a hit. A spec without `preview` previews at the grid choosePreviewEdge picks from
    // the compiled tree (implicit/preview-edge.js: pure, no clock), remembered per tree
    // so a cache hit does not re-run its probe. The engine's warnings (thin feature,
    // clipped) live beside the cached value and are recorded again on every hit, so
    // each build that uses the solid reports them. A preview build hands the engine the
    // kernel's sample cache (a world-anchored grid, byte-identical warm or cold); print never.
    //
    // A preview call inside a sub-part bracket also records itself (implicitCalls: its call
    // id and frame table) and, when its spec has frames, binds every vertex to ≤ 2 of them
    // (implicit/bindings.js) as four vertex properties coded by its SLOT — its index among
    // the bracket's calls — which is why such a solid's key holds the slot. A frameless
    // call binds nothing: no props, and the key it always had. Print never binds.
    implicit: (spec) => {
      const compiled = compileImplicit(spec, { images, meshFieldOf });
      const isPreview = quality !== "print";
      let slot = 0, call = null;
      if (isPreview && bracketDepth > 0) {
        const shape = implicitShapeHash(spec);
        let n = 0;
        for (const c of implicitCalls) if (c.shape === shape) n++;
        slot = implicitCalls.length;
        implicitCalls.push((call = { id: `${shape}#${n}`, frames: compiled.frameNames ?? [], shape }));
      }
      const binds = isPreview && (compiled.frameNames?.length ?? 0) > 0 && compiled.frameNames.length <= MAX_BIND_FRAMES;
      const { preview, resolution, ...rest } = spec;
      const autoPreview = () => {
        const treeKey = h("implicitPreviewEdge", implicitHashable(rest, compiled));
        let e = autoPreviewEdges.get(treeKey);
        if (e === undefined) {
          if (autoPreviewEdges.size >= AUTO_PREVIEW_MEMO) autoPreviewEdges.clear();
          autoPreviewEdges.set(treeKey, (e = choosePreviewEdge(compiled)));
        }
        return e;
      };
      const edge = quality === "print" ? (resolution ?? IMPLICIT_DEFAULTS.resolution) : (preview ?? autoPreview());
      const keySpec = quality === "print" ? { ...rest, resolution: edge } : { ...rest, preview: edge };
      const key = binds ? h("implicit", implicitHashable(keySpec, compiled), quality, slot)
        : h("implicit", implicitHashable(keySpec, compiled), quality);
      const solid = cache.lookup(key, () => {
        const out = meshImplicit(compiled, edge, { tier: quality, cache: quality === "print" ? undefined : sampleCache });
        if (out.indices.length === 0) {
          for (const w of out.warnings) recordWarning(w);
          throw new Error(`implicit: the shape is empty at a ${edge} mm grid — nothing is inside it (check subtract order and sizes), or it is thinner than the grid`);
        }
        // A contact root (a triOwner) is one original ID per piece, all one shading group
        // (shading-policy.js SIBLING_SEAM_ANGLE): the crease shades hard, the attachment-zone
        // seams between siblings stay smooth. Anything else is one ORGANIC skin.
        const pieces = out.triOwner ? compiled.ownerK : 1;
        const first = wasm.Manifold.reserveIDs(pieces), ids = Array.from({ length: pieces }, (_, i) => first + i);
        const extra = binds ? { per: BIND_PROPS, data: encodeBindingProps(bindVertices(compiled, out.positions, edge), slot) } : null;
        const m = T(out.triOwner ? manifoldFromWeldedMesh(wasm, out.positions, out.indices, undefined, out.triOwner, ids, extra)
          : manifoldFromWeldedMesh(wasm, out.positions, out.indices, first, null, null, extra));
        const policy = out.triOwner ? Object.freeze({ ...ORGANIC, group: first }) : ORGANIC;
        for (const id of ids) oidPolicies.set(id, policy);
        implicitMs.add(m); // a union with this operand may be delivered in two stages
        const value = wrap(m, key);
        implicitWarnings.set(value, out.warnings);
        implicitIds.set(value, ids);
        return { value, pin: m, dispose: () => { for (const id of ids) oidPolicies.delete(id); m.delete?.(); } };
      });
      for (const w of implicitWarnings.get(solid) ?? []) recordWarning(w);
      // What meshOut's seam repair needs to re-bind this call's cut vertices; kept for the
      // bracket's lifetime (implicitCalls is dropped when it closes).
      if (call && binds) Object.assign(call, { compiled, edge, ids: implicitIds.get(solid) ?? [] });
      return solid;
    },
    // Where a k.implicit spec's frames and labelled nodes end up (implicit/frame-report.js).
    // Pure and mesh-free, so it is not cached.
    implicitFrames: (spec) => implicitFrames(spec, { images }),
    // A subdivision cage (subdiv/cage.js): plain data the build edits in place. Pure, not cached.
    cage: (opts) => createCage(opts),
    // Cage → smooth solid (subdiv/): Catmull-Clark at the level the tier's tolerance needs
    // (SUBDIV_TOLERANCE), one welded mesh shading ORGANIC. The cage is read once, at the
    // call (a later edit to it changes no solid already built). Cached per tier on the
    // snapshot; meshSubdiv's warnings live beside the cached value and are recorded again
    // on every hit. No pose bindings and no two-stage union delivery: it stays out of
    // implicitMs and implicitCalls.
    subdiv: (cage) => {
      if (!isCage(cage)) throw new Error("subdiv: expected a cage from k.cage(...)");
      const snapshot = cage.snapshot();
      const tier = quality === "print" ? "print" : "preview";
      const key = h("subdiv", snapshot, tier);
      const solid = cache.lookup(key, () => {
        const out = meshSubdiv(snapshot, tier);
        // One surface, or one per part when creases split the skin (shading-policy.js
        // CREASED_SKIN: a crease is a hard seam with a line, any other seam between two
        // parts is a same-surface edge).
        const regions = out.triRegion ? out.regions : 1;
        const id = wasm.Manifold.reserveIDs(regions), ids = Array.from({ length: regions }, (_, i) => id + i);
        // A crease-free preview body is its own skin: each limit triangle is imported as
        // its own face (faceID = its index), which is what ties a delivered vertex to it.
        const skin = !out.triRegion && tier !== "print";
        const faceID = skin ? Uint32Array.from({ length: out.indices.length / 3 }, (_, t) => t) : null;
        const m = T(out.triRegion ? manifoldFromWeldedMesh(wasm, out.positions, out.indices, undefined, out.triRegion, ids)
          : manifoldFromWeldedMesh(wasm, out.positions, out.indices, id, null, null, null, faceID));
        if (skin) subdivSkins.set(id, { positions: out.positions, indices: out.indices, key: topologyKey(snapshot), level: out.level });
        ids.forEach((oid, part) => {
          if (!out.triRegion) { oidPolicies.set(oid, ORGANIC); return; }
          const hard = new Set();
          for (const [a, b] of out.creasePairs) { if (a === part) hard.add(b); if (b === part) hard.add(a); }
          oidPolicies.set(oid, Object.freeze({ ...CREASED_SKIN, skin: id, part, hard }));
        });
        const value = wrap(m, key);
        subdivWarnings.set(value, out.warnings);
        if (tier !== "print") subdivSources.set(value, { positions: out.positions, indices: out.indices, triFace: out.triFace, ids: snapshot.ids });
        return { value, pin: m, dispose: () => { for (const i of ids) { oidPolicies.delete(i); subdivSkins.delete(i); } m.delete?.(); } };
      });
      for (const w of subdivWarnings.get(solid) ?? []) recordWarning(w);
      return solid;
    },
    // Sweep a fixed 2-D profile along a 3-D polyline: hand-meshed from the shared station
    // list (sweep.js), so it agrees with OCCT's ruled loft of the same stations by
    // construction. Cached atomically; the hash folds profile pts, path pts, and opts
    // (closed/cornerRadius) so a shape change is a fresh node and an identical rebuild hits.
    sweep: (profile, path, opts = {}) => cached(h("sweep", profile, path, opts), () => T(sweepMesh(wasm, profile, path, opts))),
    helixSweptTube: (o) => cached(h("helixSweptTube", o, tube), () => T(helixTube(wasm, { ...o, ...tube }))),
    // opts.segs may only COARSEN below the kernel's quality (min), never exceed it:
    // callers use it where a small feature's sagitta bound needs fewer facets than
    // the per-circle quality would spend (mesh-fillet's free-standing corner arcs).
    // Density around the axis: by default sized for the profile's outermost radius —
    // the largest circle the revolve sweeps — through the tier's per-radius rule. An
    // explicit `segs` is the caller's own sizing (mesh-fillet's blend tools compute
    // theirs from a 1 µm sagitta bound and rely on getting exactly that count — the
    // dephase and horn-containment arithmetic assume it), bounded only by the tier's
    // cap: it may still never EXCEED kernel quality, but it is not re-bounded by the
    // part-scale rule meant for circles nobody sized by hand.
    // A partial sweep spends the circle count in proportion to its angle: Manifold takes
    // `density` as the slice count for the sweep it is given, so handing it the full-circle
    // count put 116 slices into a 36° lug (932 triangles where 100 carry the same facet
    // angle). Floored at 3, below which Manifold substitutes its own default.
    revolve: (pts, { degrees = 360, segs: segsOverride } = {}) => {
      const turn = Math.abs(degrees);   // a negative sweep is the same angle the other way
      const sweep = (n) => (turn >= 360 ? n : Math.max(3, Math.ceil((n * turn) / 360)));
      const densityFor = (maxR) => segsOverride != null ? Math.min(segs, segsOverride) : sweep(segsAt(maxR));
      if (pts && pts._shape2d) {
        // Keyed on the override, not the resolved density, so a cache hit never
        // materializes the CrossSection just to measure its bounds.
        return cached(h("revolve", pts._hash, degrees, segsOverride ?? null, quality), () => {
          const cs = csForLathe(pts); // profile arcs at the double-curvature count; the sweep below stays on the circle rule
          const b = cs.bounds();
          return T(cs.revolve(densityFor(Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]))), degrees));
        });
      }
      const maxR = Array.isArray(pts) ? pts.reduce((m, p) => Math.max(m, Math.abs(p?.[0] ?? 0)), 0) : 0;
      const density = densityFor(maxR);
      return cached(h("revolve", pts, degrees, density), () => T(Manifold.revolve([pts], density, degrees)));
    },
    // A one-solid union is an identity — no new WASM / cache entry (avoids double-free):
    // unionRaw's reduce returns the operand's own Manifold untouched, so caching it
    // would pin one WASM object under two entries and eviction would dispose it twice.
    union: (solids) => solids.length === 1
      ? solids[0]
      : hoistBoolean("union", solids, (ops) => unionOfSolids(ops))
        ?? cached(h("union", solids.map((s) => s._hash)), () => noteRuns(unionOfSolids(solids), runsOfAll(solids))),
    // Two-stage delivery (unionOfSolids above): the generate job arms the deferral for its
    // own duration; nothing else ever does.
    // Off-contract (underscore): framework plumbing between this backend and jobs.js.
    _setProvisionalUnions: (on) => { provisionalUnions = !!on; },
    // The operands of the bracket's last deferred union, when `solid` IS that union up to
    // rigid steps (its canonical base is the node): each with those steps replayed, so
    // their meshes lie where the union's will. Handed out once; null otherwise.
    _takeProvisionalPieces: (solid) => {
      const last = lastDeferred;
      lastDeferred = null;
      if (!last || solid?._canon?.m !== last.m || !pendingJudge.has(last.m)) return null;
      return last.pieces.map((p) => replay(p, solid._canon.chain));
    },
    // Imported geometry, registered pre-build by the framework via `_registerImport`
    // (ensureImports, Task 8). The master Manifold is kernel-lifetime (untracked —
    // see `imports` above); wrap() is free, so every call is cheap.
    import: (name) => {
      const e = imports.get(name);
      if (!e) throw new Error(`import: unknown import "${name}" — declare it in the part's \`imports\` field`);
      if (e.error) throw e.error; // lazy: unusable-format entries fail at use, not at registration
      return wrap(e.m, e.hash);
    },
    // Side-channel for mesh-fillet's general-chain tools (underscore = off-contract):
    // a solid from a stack of equal-size 3-D rings (mesh-build.js ringStackManifold).
    _ringStackSolid: (rings, opts = {}) =>
      cached(h("ringStack", rings, { closed: !!opts.closed }), () => T(ringStackManifold(wasm, rings, { closed: !!opts.closed }))),
    // Side-channel for mesh-fillet (underscore = off-contract): `surf` describes the
    // tool's blend wall in its current frame. Stored per surface id in the id's
    // ORIGINAL frame (inverse runTransform), so any later pose or boolean — which
    // carry runTransform along — still evaluates it exactly.
    _markBlendSurface: (tool, surf) => {
      const g = tool._m.getMesh();
      try {
        const roid = g.runOriginalID, rt = g.runTransform;
        for (let r = 0; r < roid.length; r++) {
          const inv = invertAffine(affineAt(rt, r));
          if (inv) blendSurfaces.set(roid[r], mapSurface(surf, inv));
        }
      } finally {
        g.delete?.();
      }
      return tool;
    },
    // Side-channel (underscore = off-contract, probe-invisible). Registration is
    // TOTAL — it never throws for an unusable format; an `{error}` entry is stored
    // verbatim and thrown by `import(name)` above at call time (spec: "Registration
    // is total; errors are lazy"). Re-registering the same name+digest is a no-op
    // EXCEPT an error entry is always upgradable (the post-crossover retry depends
    // on this — see `_importDigest`).
    _registerImport: ({ name, digest, positions, indices, error }) => {
      const prev = imports.get(name);
      if (!prev?.error && prev?.digest === digest) return; // error entries are always upgradable
      if (error) { imports.set(name, { error, digest }); return; }
      ensureOutward(positions, indices);
      let m;
      try {
        m = manifoldFromMesh(wasm, positions, indices);
        if (m.isEmpty()) throw new Error("empty result");
      } catch (err) {
        const open = openEdgeCount(positions, indices);
        throw new Error(`import "${name}": mesh is not a solid after repair (${open} open edges) — repair it in a mesh tool or re-export watertight (${err?.message || err})`);
      }
      prev?.m?.delete?.(); // prev may be an error entry with no manifold
      imports.set(name, { m, digest, hash: h("import", name, digest) });
    },
    // Registration memo: undefined for an error entry, so a later registration with
    // the same digest can upgrade it rather than being treated as a no-op repeat.
    _importDigest: (name) => { const e = imports.get(name); return e?.error ? undefined : e?.digest; },
    // Depth-map grids, registered pre-build by the framework via `_registerImage`
    // (ensureImages, Task 4). Unlike imports there is no per-format error entry:
    // every backend can consume a normalized grid, so registration never fails.
    _registerImage: ({ name, digest, width, height, data }) => {
      images.set(name, { digest, width, height, data });
    },
    _imageDigest: (name) => images.get(name)?.digest,
    _subdivSource: (solid) => subdivSources.get(solid),   // provenance.js: a k.subdiv solid's limit mesh and cage faces
    _shadingPolicy: (oid) => oidPolicies.get(oid),   // tests: the policy an original ID shades with
    // Drop every registered name NOT in `keep` (a Set) — the images-map twin of
    // fonts' kernel._fonts prune in jobs.js. `images` is keyed on the part's
    // declared name (e.g. "relief"), not on content, so without this a name
    // the user cleared — or a different part that reuses the same key across a
    // worker-rebind — would silently keep resolving to a prior build's grid.
    // A method rather than exposing `images` itself: jobs.js only ever needs
    // "keep exactly this set", never raw Map access.
    _pruneImages: (keep) => {
      for (const name of [...images.keys()]) if (!keep.has(name)) images.delete(name);
    },
    _acceptsMesh: true,
    _sampleCache: sampleCache,   // tests and the bench: k.implicit's preview sample cache
    shape2d,
    // Backend-internal region adapter: the shared native engine (contour-offset.js)
    // that Shape2D.offset itself runs on — published here for callers that want the
    // region-in/region-out form directly. `_`-prefixed — not part of the public kernel
    // surface.
    _offsetRegions: offsetRegions,
    beginSubPart: (name) => {
      if (bracketDepth++ === 0) implicitCalls = [];
      cache.begin(name);
    },
    endSubPart: () => {
      lastDeferred = null;
      cache.end();
      if (bracketDepth > 0 && --bracketDepth > 0) return;
      implicitCalls = [];
    },
    // Param provenance (provenance.js): while active, toMesh adds originIds/origins.
    beginProvenance: (prov) => { activeProv = prov; },
    endProvenance: () => { activeProv = null; },
    sweepCache: () => cache.sweep(),
    dropCache: () => { cache.clear(); sampleCache.clear(); },
    setCacheBudget: (bytes) => cache.setBudget(bytes),
    trimCache: () => cache.trim(),
    cacheBytes: () => cache.retainedBytes(),
    cacheStats: () => cache.stats(),
    resetCacheStats: () => cache.resetStats(),
    // Drain the feature-skip warnings recorded since the last drain (see
    // buildWarnings above). jobs.js calls this per sub-part so a warning is
    // attributed to the sub-part whose build recorded it.
    takeBuildWarnings: () => { profileWarner.reset(); return buildWarnings.splice(0); },
    // Internal (underscore = not the contract surface): the recorder shared,
    // backend-neutral helpers report their own degrades through.
    _recordWarning: recordWarning,
    // Internal: the profile-validity warner the kernel front's `warn` slot calls.
    _warnProfile: profileWarner.warn,
    // Free every WASM object created since the last cleanup EXCEPT solids the cache
    // still pins (they must survive for the next build to resume from them).
    cleanup: () => { for (const o of tracked) if (!cache.isPinned(o)) del(o); tracked.length = 0; },
  });
  return kernel;
}

function stlFromMesh(g) {
  const vp = g.vertProperties, np = g.numProp;
  const nVert = (vp.length / np) | 0;
  let positions;
  if (np === 3) {
    positions = vp; // already x,y,z per vertex
  } else {
    positions = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) { positions[i*3] = vp[i*np]; positions[i*3+1] = vp[i*np+1]; positions[i*3+2] = vp[i*np+2]; }
  }
  return meshToStl(positions, g.triVerts);
}

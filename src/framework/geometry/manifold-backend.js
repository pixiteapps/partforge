import { helixTube } from "./helix-tube.js";
import { loftMesh } from "./loft.js";
import { resolveLoftRings, loftRingsKey } from "./loft-rings.js";
import { sweepMesh } from "./sweep.js";
import { roundedBoxRings, roundedBoxArcSamples } from "./rounded-solids.js";
import { tessellateContour, tessellateProfile } from "./profile.js";
import { h } from "./solid-hash.js";
import { ensureOutward, openEdgeCount } from "./mesh-repair.js";
import { manifoldFromMesh } from "./mesh-build.js";
import { createSolidCache } from "./solid-cache.js";
import { hoistCommonSuffix } from "./transform-hoist.js";
import { addSugar } from "./solid-sugar.js";
import { makeShape2dFactory } from "./shape2d.js";
import { offsetRegions } from "./contour-offset.js";
import { finishKernel } from "./kernel-front.js";
import { makeProfileWarner } from "./profile-warnings.js";
import { meshToStl } from "./mesh-stl.js";
import { creasedNormals } from "./creased-normals.js";
import { loftShadingPolicy, SMOOTH, BLEND } from "./shading-policy.js";
import { meshFillet, meshChamfer, UnsupportedEdgeError } from "./mesh-fillet.js";
import { meshRoundAll, prismSection, roundAllSegs } from "./mesh-roundall.js";
import { SEGS, circleSegs, doubleCurvatureSegs } from "./circle-segs.js";
import { checkBooleanResult } from "./boolean-gate.js";
import { KernelCapabilityError } from "./errors.js";
import { heightfieldMesh, hashGridData } from "./heightfield.js";

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
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
  const volumeOf = (mm) => {
    let v = volumes.get(mm);
    if (v === undefined) { v = mm.volume(); volumes.set(mm, v); }
    return v;
  };
  const BOX_SLACK = 1e-3; // mm — an enclosure test, not a measurement
  const judged = (op, operandMs, resultM) => {
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

  const cache = createSolidCache();
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
  const cached = (hash, computeM) => cache.lookup(hash, () => {
    const m = computeM();                 // already T()-tracked by the op
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
    const canonical = cached(h(opName, ops.map((s2) => s2._hash)), () => evaluate(ops));
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

  // Copy the mesh out into JS-owned arrays (so it survives cleanup) and free the
  // transient mesh handle.
  function meshOut(m, asStl) {
    const g = m.getMesh();
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, { policies: oidPolicies, featureLabels });
    g.delete?.();
    return r;
  }

  // Raw indexed mesh (positions x,y,z per vertex + triangle indices) for 3MF.
  function indexedMeshOut(m) {
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
  // label() on a blend result already handles a mixed-original mesh (the majority
  // vote below).
  const runOids = (mm) => { const g = mm.getMesh(); const s = new Set(g.runOriginalID); g.delete?.(); return s; };
  const meshCadOp = (op, baseM, run) => {
    try {
      const raw = run()._m;
      const baseOids = runOids(baseM);
      for (const oid of runOids(raw)) if (!baseOids.has(oid)) oidPolicies.set(oid, BLEND);
      // debris sweep AFTER simplify: the boolean's own femto-components are joined by
      // ones simplify() itself pinches off while collapsing seam slivers (measured:
      // 4-triangle atto-scale bubbles, one with negative volume, after a rim fillet
      // over vertical-fillet bands) — sweeping first missed those
      return dropDebris(T(raw.simplify(SIMPLIFY_EPS)));
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
        // blend-AWARE, the same re-stamp label() performs: a blanket asOriginal()
        // folded blend and base into one fresh surface, erasing the distinction
        // the band-boundary lines need — a roundAll'd prism rendered with no
        // feature lines at all, unlike the identical geometry from fillet().
        // Re-stamp as two reserved ids instead (base stays unregistered → SMOOTH,
        // the extruded section has no policy of its own) so the result draws
        // exactly the lines the fillet drew.
        const g0 = filleted._m.getMesh();
        try {
          const isBlend = (oid) => !!oidPolicies.get(oid)?.boundaryLines;
          if (![...new Set(g0.runOriginalID)].some(isBlend)) return T(filleted._m.asOriginal());
          const baseId = Manifold.reserveIDs(2), blendId = baseId + 1;
          g0.runOriginalID = Uint32Array.from(g0.runOriginalID, (o) => (isBlend(o) ? blendId : baseId));
          oidPolicies.set(blendId, BLEND);
          // The constructor re-welds, and that can pinch a latent sliver off a
          // component as fresh femto-debris (the same rebirth dropDebris's own
          // compose() loop guards against) — sweep the reconstruction too.
          return dropDebris(T(new Manifold(g0)));
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
  const wrap = (m, hash, canon = { m, hash, chain: [] }) => {
    const self = addSugar({
    _m: m,
    _hash: hash,
    _canon: canon,
    cut: (t) => cached(h("cut", hash, t._hash), () => judged("cut", [m, t._m], T(m.subtract(t._m)))),
    // THROWING forms. These are the composition primitives — internal callers
    // that have their own recovery (prismRoundAllFast, which answers a failed
    // fillet by falling back to the reference Minkowski roundAll) must use
    // these, never the degrading public ops below: a skip there would emit an
    // UN-rounded prism as a successful roundAll, which is silently wrong
    // geometry rather than a reported missing feature.
    _filletRaw: (r, selector) => {
      if (typeof selector === "function") throw new KernelCapabilityError("fillet: function selectors need the OCCT backend");
      if (r === 0) return wrap(m, hash); // contract: zero magnitude is the identity
      return cached(h("fillet", hash, r, selector ?? null, segs), () =>
        meshCadOp("fillet", m, () => meshFillet(kernel, wrap(m, hash), { r, edges: selector, segs, segsAt })));
    },
    _chamferRaw: (d, selector) => {
      if (typeof selector === "function") throw new KernelCapabilityError("chamfer: function selectors need the OCCT backend");
      if (d === 0) return wrap(m, hash);
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
      // `quality` in the key is redundant but harmless — the cache lives on a
      // per-quality kernel, so it can never collide across tiers (the OCCT twin
      // key omits it for the same reason); it just spells out that the ball
      // tessellation, and so the result, is tier-dependent.
      return cached(h("roundAll", hash, r, quality), () =>
        prismRoundAllFast(m, hash, r) ?? T(meshRoundAll(wasm, m, r, quality)));
    },
    // batch difference: first minus the union of the rest, evaluated as one boolean
    // tree — no materialized intermediate union (the unionRaw memory note applies)
    cutAll: (tools) => cached(h("cutAll", hash, tools.map((t) => t._hash)), () => {
      const ms = [m, ...tools.map((t) => t._m)];
      return judged("cutAll", ms, T(Manifold.difference(ms)));
    }),
    intersect: (t) => cached(h("intersect", hash, t._hash), () => judged("intersect", [m, t._m], T(m.intersect(t._m)))),
    union: (t) => cached(h("union", [hash, t._hash]), () => judged("union", [m, t._m], unionRaw([m, t._m]))),
    clone: () => wrap(m, hash),
    // Name this solid's surface for hover/pick feature attribution. asOriginal()
    // stamps a fresh originalID that survives transforms and booleans, so every
    // surviving triangle of this surface can be traced back to the label. The
    // registry entry lives exactly as long as the cache pins the solid — eviction
    // disposes both, so the registry can't grow unboundedly across regenerates.
    label: (name) => {
      // Labeling only re-stamps surface ids, so it commutes with the trailing
      // transform. This is load-bearing rather than an optimization: the common
      // authoring idiom labels each piece AFTER positioning it, which would give every
      // copy its own canonical base and stop the hoist below from ever firing.
      if (canon.chain.length) return replay(wrap(canon.m, canon.hash).label(name), canon.chain);
      const lh = h("label", hash, name);
      return cache.lookup(lh, () => {
        // Blend-aware re-stamp. If this mesh carries blend surfaces (the boundaryLines
        // policy), one asOriginal() would fold band and base into a single surface and
        // erase the band-boundary overlay on exactly the solids parts label — every
        // real part labels its top-level solids. Re-stamp as TWO reserved ids instead,
        // base and blend: the label covers both (same string → one feature entry), the
        // distinction survives labeling and every later boolean, and reserved ids are
        // fresh so cached-solid reuse under another label cannot collide — the same
        // guarantee asOriginal() gives the plain path below.
        const g0 = m.getMesh();
        const isBlend = (oid) => !!oidPolicies.get(oid)?.boundaryLines;
        const oids0 = new Set(g0.runOriginalID);
        // Sector-aware re-stamp: a provenance-sectored loft (the `sector` policy
        // marker) must keep every run's identity — folding them (either the plain
        // asOriginal below or the blend path's two-group stamp) would erase the
        // sector creases and dividing lines the runs exist to draw. Re-stamp every
        // distinct id 1:1 onto fresh reserved ids: each keeps its policy (blend
        // runs riding along keep BLEND), all map to the one label string, and the
        // fresh ids give the same reuse-under-another-label guarantee as
        // asOriginal(). Unregistered ids (plain boolean tools) stay unregistered —
        // they shade SMOOTH by default exactly as before.
        if ([...oids0].some((oid) => !!oidPolicies.get(oid)?.sector)) {
          const olds = [...oids0];
          const base2 = Manifold.reserveIDs(olds.length);
          const mapId = new Map(olds.map((o2, i2) => [o2, base2 + i2]));
          g0.runOriginalID = Uint32Array.from(g0.runOriginalID, (o2) => mapId.get(o2));
          const o = T(new Manifold(g0));
          g0.delete?.();
          const setIds = [];
          for (const [oldId, newId] of mapId) {
            featureLabels.set(newId, name);
            const pol = oidPolicies.get(oldId);
            if (pol !== undefined) oidPolicies.set(newId, pol);
            setIds.push(newId);
          }
          return { value: wrap(o, lh), pin: o, dispose: () => {
            for (const id2 of setIds) { featureLabels.delete(id2); oidPolicies.delete(id2); }
            o.delete?.();
          } };
        }
        if ([...oids0].some(isBlend)) {
          const baseId = Manifold.reserveIDs(2), blendId = baseId + 1;
          // base-group policy: the same triangle-weighted majority vote as the plain
          // path, but over the NON-blend runs only — blend runs would elect BLEND for
          // the base group and flag BOTH sides of every boundary seam, which is
          // exactly the no-line state this path exists to avoid.
          const ri = g0.runIndex, roid = g0.runOriginalID;
          const weightByKey = new Map();
          let bestWeight = -1, basePol;
          for (let r = 0; r < roid.length; r++) {
            if (isBlend(roid[r])) continue;
            const pol = oidPolicies.get(roid[r]) ?? SMOOTH;
            const key = `${pol.creaseAngle}/${pol.sameSurfaceLines}/${!!pol.boundaryLines}`;
            const weight = (weightByKey.get(key) || 0) + (ri[r + 1] / 3 - ri[r] / 3);
            weightByKey.set(key, weight);
            const better = weight > bestWeight || (weight === bestWeight && !pol.sameSurfaceLines && basePol?.sameSurfaceLines);
            if (better) { bestWeight = weight; basePol = pol; }
          }
          g0.runOriginalID = Uint32Array.from(roid, (o2) => (isBlend(o2) ? blendId : baseId));
          const o = T(new Manifold(g0));
          g0.delete?.();
          featureLabels.set(baseId, name);
          featureLabels.set(blendId, name);
          oidPolicies.set(blendId, BLEND);
          if (basePol !== undefined) oidPolicies.set(baseId, basePol);
          return { value: wrap(o, lh), pin: o, dispose: () => {
            featureLabels.delete(baseId); featureLabels.delete(blendId);
            oidPolicies.delete(baseId); oidPolicies.delete(blendId);
            o.delete?.();
          } };
        }
        g0.delete?.();
        const prevId = typeof m.originalID === "function" ? m.originalID() : -1;
        const o = T(m.asOriginal());
        const id = o.originalID();
        featureLabels.set(id, name);
        // labeling re-stamps the originalID — carry the surface's shading policy along.
        // A boolean upstream of this label() (e.g. a faceted loft().intersect(tool),
        // as the vase does to hollow itself) leaves the solid spanning more than one
        // original surface, so originalID() reports -1 ("mixed") rather than a single
        // id — the direct lookup below misses even though the loft's policy is right
        // there. Fall back to the mesh's own run table and recover it via a
        // triangle-count-weighted majority vote across all surfaces feeding this
        // mesh (a plain tool like a box has no registered policy of its own, but
        // still votes SMOOTH — see below).
        let inherited = prevId !== -1 ? oidPolicies.get(prevId) : undefined;
        // Skip the mesh scan entirely when no surface anywhere has a registered
        // policy (e.g. planter's labeled prism compound) — getMesh() forces a
        // full mesh materialization and parts with no lofts must not pay for it.
        if (inherited === undefined && prevId === -1 && oidPolicies.size > 0) {
          const g = m.getMesh();
          // Triangle-count-weighted majority: walk the run table with runIndex
          // (each run r spans triangles ri[r]/3..ri[r+1]/3 — same arithmetic
          // creased-normals.js uses) and tally triangle counts per registered
          // policy, keyed by VALUE (creaseAngle/sameSurfaceLines), not object
          // reference — a majority-by-object-identity check would silently
          // break if policies were ever constructed per-op instead of shared
          // singletons. A run whose original surface has NO registered policy
          // (a plain boolean tool, e.g. a box) still gets a vote: at render
          // time an unregistered surface shades SMOOTH (buildGeometry's
          // default), so counting it as an abstention would let the vote
          // disagree with what's actually drawn — it contributes its triangle
          // weight to SMOOTH instead. The policy spanning the most triangles
          // wins; an exact tie favors the FACETED-like policy
          // (sameSurfaceLines: false) — deterministic, and biased toward
          // honest-print rendering over silently smoothing facets away.
          const ri = g.runIndex, roid = g.runOriginalID;
          const weightByKey = new Map();  // policy key -> triangle count
          let bestWeight = -1, bestPol;
          for (let r = 0; r < roid.length; r++) {
            const pol = oidPolicies.get(roid[r]) ?? SMOOTH;
            const key = `${pol.creaseAngle}/${pol.sameSurfaceLines}/${!!pol.boundaryLines}`;
            const weight = (weightByKey.get(key) || 0) + (ri[r + 1] / 3 - ri[r] / 3);
            weightByKey.set(key, weight);
            const better = weight > bestWeight || (weight === bestWeight && !pol.sameSurfaceLines && bestPol?.sameSurfaceLines);
            if (better) { bestWeight = weight; bestPol = pol; }
          }
          g.delete?.();
          inherited = bestPol;
        }
        if (inherited !== undefined) oidPolicies.set(id, inherited);
        return { value: wrap(o, lh), pin: o, dispose: () => { featureLabels.delete(id); oidPolicies.delete(id); o.delete?.(); } };
      });
    },
    boundingBox: () => {
      const b = m.boundingBox();           // { min: Vec3, max: Vec3 } — addSugar derives center/size
      return { min: [...b.min], max: [...b.max] };
    },
    volume: () => m.volume(),
    genus: () => m.genus(),
    isEmpty: () => m.isEmpty(),
    translate: (v) => wrap(T(m.translate(v)), h("translate", hash, v),
      { m: canon.m, hash: canon.hash, chain: [...canon.chain, { op: "translate", v }] }),
    rotate: (deg, center, axis) => {
      const nz = (axis[0] !== 0) + (axis[1] !== 0) + (axis[2] !== 0);
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = nz <= 1
        ? T(a.rotate([axis[0] * deg, axis[1] * deg, axis[2] * deg]))   // basis axis — euler is exact; unchanged
        : T(a.transform(axisAngleMat4(axis, deg)));                    // general axis-angle
      return wrap(T(b.translate(center)), h("rotate", hash, deg, center, axis),
        { m: canon.m, hash: canon.hash, chain: [...canon.chain, { op: "rotate", deg, center, axis }] });
    },
    mirror: (plane) => wrap(T(m.mirror(PLANE_NORMAL[plane])), h("mirror", hash, plane)),
    scale: (factor, center) => { // factor validated (and center defaulted) by addSugar
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.scale([factor, factor, factor]));
      return wrap(T(b.translate(center)), h("scale", hash, factor, center));
    },
    toMesh: () => meshOut(m, false),
    toSTL: () => Promise.resolve(meshOut(m, true)),
    toIndexedMesh: () => indexedMeshOut(m),
    });
    return self;
  };

  const kernel = finishKernel({
    cylinder: (rb, rt, h2, { center = false } = {}) => {
      const n = segsAt(Math.max(rb, rt)); // a cone is sized by its wider end
      return wrap(T(Manifold.cylinder(h2, rb, rt, n, center)), h("cylinder", rb, rt, h2, center, n));
    },
    // Compound op: hashed ATOMICALLY from its own args, so it is a single cache
    // node — its internal cylinders/cut are never retained. The template for
    // future compounds: build internals with T(), return the final tracked solid.
    boredCylinder: ({ od, h: height, bore }) => cached(h("boredCylinder", od, height, bore, segsAt(od / 2), segsAt(bore / 2)), () => {
      const body = T(Manifold.cylinder(height, od / 2, od / 2, segsAt(od / 2), false));
      const tool0 = T(Manifold.cylinder(height + 4, bore / 2, bore / 2, segsAt(bore / 2), false));
      const tool = T(tool0.translate([0, 0, -2])); // raw ops: track each result
      return T(body.subtract(tool));
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
        return center ? T(solid.translate([0, 0, -size[2] / 2])) : solid;
      }),
    // Sized by the double-curvature rule (circle-segs.js: a sphere spends the per-circle
    // count squared), on both tiers — the hash carries the count, so a sphere built at
    // one tier never masquerades as the other's in the cache.
    sphere: (r) => wrap(T(Manifold.sphere(r, dcAt(r))), h("sphere", r, dcAt(r))),
    box: (min, max) => {
      const cube = T(Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
      return wrap(T(cube.translate(min)), h("box", min, max));
    },
    prism: (pts, height, { twist = 0, scaleTop = 1 } = {}) =>
      cached(h("prism", pts, height, twist, scaleTop, segs), () => {
        const cs = T(CrossSection.ofPolygons([tessellateContour(pts, segsAt)]));
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
    // Polygon-with-holes extrude in one op: even/odd fill turns the extra contours into
    // holes regardless of their winding (outer + holes, no per-hole boolean cut).
    // A Shape2D `profile` (curve-native, possibly multi-region) materializes through
    // csFor — one memoized tessellation per shape+LOD — and folds into the cache key
    // by `_hash` like any other solid operand.
    extrude: (profile, height, { twist = 0, scaleTop = 1 } = {}) => {
      const shape = profile && profile._shape2d ? profile : null;
      return cached(h("extrude", shape ? shape._hash : profile, height, twist, scaleTop, segs), () => {
        const cs = shape ? csFor(shape) : (() => {
          const { outer, holes } = tessellateProfile(profile, segsAt);
          return T(CrossSection.ofPolygons([outer, ...holes], "EvenOdd"));
        })();
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
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
    revolve: (pts, { degrees = 360, segs: segsOverride } = {}) => {
      const densityFor = (maxR) => segsOverride != null ? Math.min(segs, segsOverride) : segsAt(maxR);
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
      : hoistBoolean("union", solids, (ops) => judgedUnion(ops.map((s) => s._m)))
        ?? cached(h("union", solids.map((s) => s._hash)), () => judgedUnion(solids.map((s) => s._m))),
    // Imported geometry, registered pre-build by the framework via `_registerImport`
    // (ensureImports, Task 8). The master Manifold is kernel-lifetime (untracked —
    // see `imports` above); wrap() is free, so every call is cheap.
    import: (name) => {
      const e = imports.get(name);
      if (!e) throw new Error(`import: unknown import "${name}" — declare it in the part's \`imports\` field`);
      if (e.error) throw e.error; // lazy: unusable-format entries fail at use, not at registration
      return wrap(e.m, e.hash);
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
    shape2d,
    // Backend-internal region adapter: the shared native engine (contour-offset.js)
    // that Shape2D.offset itself runs on — published here for callers that want the
    // region-in/region-out form directly. `_`-prefixed — not part of the public kernel
    // surface.
    _offsetRegions: offsetRegions,
    beginSubPart: (name) => cache.begin(name),
    endSubPart: () => cache.end(),
    sweepCache: () => cache.sweep(),
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

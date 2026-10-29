// Pure in-scene dimension placement (spec v2 §Placement + amendments).
// Everything works in the PARTS frame — the meshes' shared parent group
// (delivered geometry composed with pose matrices) — so the resulting drawing
// rides the pivot rotation and per-view recentring untouched. No DOM, no GL,
// no rendering objects: three's math classes only, so this runs under plain
// vitest.
//
// Placement does the expensive DISCOVERY only: anchor points (extreme-vertex
// scans, surface raycasts, plane snapping), side selection, dedupe and stagger
// lanes. Every display distance — standoff, surface gap, arrowheads, the
// overshoot past the dim line, leader length, text size — is screen-constant,
// so the final geometry depends on zoom and is assembled per frame by
// dim3-scene from the parametric records emitted here. That keeps zoom fully
// rebuild-free.
//
// Split in two so the orchestrator can score cheaply every frame and rebuild
// rarely: evaluateChoices() is dot-products + hysteresis over the previous
// choices; placeDims() does the discovery only when a choice flipped or the
// scene changed.
//
// Drawing contract (consumed by dim3-scene):
//   { itemId, tier, pinned,
//     dims:    [{ pA, pB, baseA, baseB, ext, dir, lane, standoffScale,
//                 label: { text, value, x, y } }],
//     diams:   [{ rimA, rimB, du, dv, label }],
//     leaders: [{ rim, dir, perp, label }] }
// All vectors are number[3] in the parts frame. A linear dim's line endpoints
// at display time are base± + ext·offset (offset chosen on-screen); pA/pB are
// the discovered surface-contact anchors its extension lines run from. A diam
// is the fixed line across a circle (rim to rim); a leader points at `rim`
// along `dir`.
import * as THREE from "three";


// --- discovery constants ------------------------------------------------------
// standoffNominal: the mm offset ASSUMED while discovering surface contacts
// (raycast origins) and extreme-vertex tie-break targets. Display standoff is
// screen-constant and lives in dim3-scene; discovery only needs a plausible
// out-of-the-part reference, and the contact points it finds barely depend on
// it.
export const standoffNominal = (modelSize) => Math.max(6, modelSize * 0.10);

// Display units. Values are ALWAYS mm internally (kernel units; label.value
// stays mm so control matching keeps working) — only the rendered text
// converts. Inches show 3 decimals: 0.001 in ≈ 0.0254 mm, in the same
// precision neighbourhood as the 0.01 mm display quantum.
export const UNITS = {
  mm: { format: (v) => v.toFixed(2), suffix: " mm" },
  in: { format: (v) => (v / 25.4).toFixed(3), suffix: " in" },
};
export const HYSTERESIS = 1.15;  // challenger must beat the holder by 15%
export const FLIP_DEADBAND_DEG = 25; // cylinder ⌀ direction re-aim threshold

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// --- duplicate-dimension suppression ------------------------------------------
// Two items measuring the same thing draw identical dims on top of each other:
// a hovered sub-part over the overall bounds (single-part apps), a hover over
// its own pin. The signature identifies "the same measurement" independent of
// item id/tier. Within one placeDims call the LATER item wins (pins carry the
// param pill the overall lacks); across the orchestrator's base/hover split,
// the hover pass hands the base items' sigs in as `suppress`.
export function specSig(spec) {
  return JSON.stringify({ kind: spec.kind, values: spec.values, anchors: spec.anchors });
}

// --- stagger lanes ------------------------------------------------------------
// Dims extending the same outward direction stack at increasing standoff
// (drafting-style stacked dimension lines), so co-located labels stagger
// instead of overlapping. Lanes are per-placeDims-call and deterministic in
// item order (overall, pins, hover). The lane's on-screen spacing lives in
// dim3-scene.
function laneFor(lanes, ext) {
  const key = `${ext.x.toFixed(2)},${ext.y.toFixed(2)},${ext.z.toFixed(2)}`;
  const lane = lanes.get(key) ?? 0;
  lanes.set(key, lane + 1);
  return lane;
}

// Lane occupancy of already-placed drawings, in laneFor's key space — the
// orchestrator seeds the hover pass with the cached base pass's counts so a
// hovered dim takes the SAME lane it will occupy once pinned (pins append
// after the base items in the same order), instead of starting at lane 0 and
// jumping on click.
export function laneCounts(drawings) {
  const lanes = new Map();
  for (const d of drawings) {
    for (const dim of d.dims ?? []) {
      const key = `${dim.ext[0].toFixed(2)},${dim.ext[1].toFixed(2)},${dim.ext[2].toFixed(2)}`;
      lanes.set(key, Math.max(lanes.get(key) ?? 0, (dim.lane ?? 0) + 1));
    }
  }
  return lanes;
}

// --- candidate sides for a box-extent dim ------------------------------------
// Measuring along `axis`, the dim can extend outward along ± each of the other
// two axes; the plane normal is the remaining axis. Keys are stable across
// frames so hysteresis can hold a choice.
function boxCandidates(axis) {
  const others = [0, 1, 2].filter((i) => i !== axis);
  const out = [];
  for (const extAxis of others) {
    const nAxis = others.find((i) => i !== extAxis);
    for (const sign of [1, -1]) out.push({ key: `e${extAxis}s${sign}`, extAxis, sign, nAxis });
  }
  return out;
}

function scoreCandidate(ext, n, toCam) {
  // Readability first: the dim's plane should FACE the camera — a face-on
  // drawing is what a viewer can read. "Extend toward the viewer" only breaks
  // ties between equally-oblique planes (and biases the near side there): the
  // two terms are antagonistic — an ext pointing AT the camera means the
  // plane containing it is near edge-on — so an ext-dominant weighting (the
  // original 0.6/0.4) actively picked tilted, foreshortened planes that
  // fought the viewer during orbit.
  return Math.abs(n.dot(toCam)) + 0.15 * Math.max(0, ext.dot(toCam));
}

// --- candidate sides for a two-click span or a straight edge -----------------
// Both are measured in a frame (a span carries its own `axes`, the frame its
// two clicks squared to; an edge is drawn in the parts frame, which is the
// frame placeDims works in). Each candidate is an ext direction ⊥ the measured
// direction `d`, built from a frame axis k: ±normalize(k − d·(k·d)). The dim
// plane then holds d and k; when d ⊥ k the ext IS the frame axis.
const frameAxesOf = (spec) => (spec.anchors.axes ?? AXES.map((a) => a.toArray())).map((k) => v3(k).normalize());

function squareCandidates(d, axes, keep) {
  const out = [];
  axes.forEach((k, i) => {
    if (!keep(Math.abs(k.dot(d)), i)) return;
    const e = k.clone().addScaledVector(d, -k.dot(d)).normalize();
    out.push({ key: `k${i}s1`, ext: e });
    out.push({ key: `k${i}s-1`, ext: e.clone().negate() });
  });
  return out;
}

// span: { d, cands }. Not straight, measured along a frame axis: the box
// candidates in the span's own axes (± the other two). Not straight but along
// a face normal off the frame (a gap between tilted parallel faces), or
// straight: the square candidates. `d` keeps the axis' sign as given — a gap's
// axis is the first face's normal, which can point away from b.
function spanCandidates(spec) {
  const axes = frameAxesOf(spec);
  const a = v3(spec.anchors.a), b = v3(spec.anchors.b);
  if (!spec.anchors.straight && spec.anchors.axis) {
    const axis = v3(spec.anchors.axis).normalize();
    let i = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(axes[j].dot(axis)) > Math.abs(axes[i].dot(axis))) i = j;
    const c = axes[i].dot(axis);
    if (Math.abs(c) > 1 - 1e-6) {
      return {
        d: axes[i].clone().multiplyScalar(Math.sign(c)),
        cands: boxCandidates(i).map((x) => ({ key: x.key, ext: axes[x.extAxis].clone().multiplyScalar(x.sign) })),
      };
    }
    return { d: axis, cands: squareCandidates(axis, axes, (k) => k < 0.99) };
  }
  const d = b.clone().sub(a).normalize();
  return { d, cands: squareCandidates(d, axes, (k) => k < 0.99) };
}

// edge: ± the in-plane perpendicular of its owning face (placePlane's rule)
// when the spec names one, else built from the frame axis least aligned with
// the edge (every axis tied for least, so an axis-aligned edge offers both
// perpendicular axes and the camera picks).
function edgeCandidates(spec) {
  const a = v3(spec.anchors.a), b = v3(spec.anchors.b);
  const d = b.clone().sub(a).normalize();
  if (spec.anchors.normal) {
    const perp = new THREE.Vector3().crossVectors(v3(spec.anchors.normal).normalize(), d);
    if (perp.lengthSq() > 1e-12) {
      perp.normalize();
      return { d, cands: [{ key: "p+", ext: perp }, { key: "p-", ext: perp.clone().negate() }] };
    }
  }
  const axes = frameAxesOf(spec);
  const least = Math.min(...axes.map((k) => Math.abs(k.dot(d))));
  return { d, cands: squareCandidates(d, axes, (k) => k <= least + 1e-6) };
}

const scoreSquare = (d, cands, toCam) => cands.map((c) => ({
  key: c.key,
  score: scoreCandidate(c.ext, new THREE.Vector3().crossVectors(d, c.ext).normalize(), toCam),
}));

// Hold the previous choice unless a challenger beats it by HYSTERESIS — and
// by an absolute margin too: near-degenerate views score every candidate close
// to zero, where a multiplicative margin is meaningless and tiny camera moves
// would flip-flop the choice (and force rebuilds) for no visible benefit.
function chooseWithHysteresis(scored, prevKey) {
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const prev = prevKey != null ? scored.find((s) => s.key === prevKey) : null;
  if (prev && best.key !== prev.key
      && (best.score < prev.score * HYSTERESIS || best.score - prev.score < 0.02)) return prev;
  return best;
}

// --- per-frame-cheap choice scoring ------------------------------------------
export function evaluateChoices(items, { camPos, center, prev = {} }) {
  const cam = v3(camPos);
  const toCam = cam.clone().sub(v3(center)).normalize();
  const choices = {};
  for (const item of items) {
    const spec = item.spec;
    if (spec.kind === "bbox") {
      for (const axis of [0, 1, 2]) {
        // zero-span axes place no dim (placeBox skips them) — emitting a
        // choice anyway would let its degenerate near-zero scores flip on
        // tiny camera moves and force pointless rebuilds
        if (spec.anchors.max[axis] - spec.anchors.min[axis] < 1e-6) continue;
        const ck = `${item.id}|ax${axis}`;
        const scored = boxCandidates(axis).map((c) => ({
          ...c,
          score: scoreCandidate(AXES[c.extAxis].clone().multiplyScalar(c.sign), AXES[c.nAxis], toCam),
        }));
        choices[ck] = { key: chooseWithHysteresis(scored, prev[ck]?.key).key };
      }
    } else if (spec.kind === "plane") {
      const n = v3(spec.anchors.normal).normalize();
      for (const dimKey of ["width", "height"]) {
        const { a, b } = spec.anchors[dimKey];
        const dir = v3(b).sub(v3(a)).normalize();
        const perp = new THREE.Vector3().crossVectors(n, dir).normalize();
        const ck = `${item.id}|${dimKey}`;
        const scored = [
          { key: "p+", sign: 1, score: scoreCandidate(perp, n, toCam) },
          { key: "p-", sign: -1, score: scoreCandidate(perp.clone().negate(), n, toCam) },
        ];
        choices[ck] = { key: chooseWithHysteresis(scored, prev[ck]?.key).key };
      }
    } else if (spec.kind === "span" || spec.kind === "edge") {
      const { d, cands } = spec.kind === "span" ? spanCandidates(spec) : edgeCandidates(spec);
      if (!cands.length || !(d.lengthSq() > 0.5)) continue;
      const ck = `${item.id}|${spec.kind}`;
      choices[ck] = { key: chooseWithHysteresis(scoreSquare(d, cands, toCam), prev[ck]?.key).key };
    } else if (spec.kind === "cylinder") {
      // ⌀/R direction: radial component of the view direction, re-aimed only
      // past the deadband so the drawing doesn't chase every orbit degree.
      const axis = v3(spec.anchors.axis).normalize();
      const toCamHere = cam.clone().sub(v3(spec.anchors.center)).normalize();
      let du = toCamHere.clone().addScaledVector(axis, -toCamHere.dot(axis));
      if (du.lengthSq() < 1e-6) du = v3(spec.anchors.rimDir ?? [1, 0, 0]);
      du.normalize();
      const ck = `${item.id}|du`;
      const prevDu = prev[ck]?.du ? v3(prev[ck].du) : null;
      const hold = prevDu && du.angleTo(prevDu) < (FLIP_DEADBAND_DEG * Math.PI) / 180;
      choices[ck] = { du: (hold ? prevDu : du).toArray() };
      // depth dim side: candidates around the axis — the tangential pair
      // (±dv) puts the dim's plane FACE-ON to the camera, hanging off the
      // cylinder's visible silhouette; the radial pair (±du) is near edge-on
      // and only wins in degenerate down-the-axis views. Same readability
      // rule as the box candidates.
      const dck = `${item.id}|depth`;
      const duHeld = hold ? prevDu : du;
      const dv = new THREE.Vector3().crossVectors(axis, duHeld).normalize();
      const scored = [
        { key: "t+", ext: dv },
        { key: "t-", ext: dv.clone().negate() },
        { key: "d+", ext: duHeld },
        { key: "d-", ext: duHeld.clone().negate() },
      ].map((c) => ({
        key: c.key,
        score: scoreCandidate(c.ext, new THREE.Vector3().crossVectors(axis, c.ext).normalize(), toCamHere),
      }));
      choices[dck] = { key: chooseWithHysteresis(scored, prev[dck]?.key).key, du: duHeld.toArray() };
    }
  }
  return choices;
}

export function choicesEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y) return false;
    if (x.key !== y.key) return false;
    if (!!x.du !== !!y.du) return false;
    if (x.du && (x.du[0] !== y.du[0] || x.du[1] !== y.du[1] || x.du[2] !== y.du[2])) return false;
  }
  return true;
}

// --- extreme vertex scan ------------------------------------------------------
// The vertex realizing the extreme along `axis` over the posed meshes; ties
// within tolerance (a flat base is all "the minimum") break toward `near`, so
// the anchor lands on the side of the part the dimension is drawn on.
//
// placeBox asks for all six ±axis directions, and the naive shape of this —
// one pass to find the extreme, a second to tie-break, per call — walked every
// vertex twelve times over. On a soup carrying three points per triangle that
// is the dominant cost of a placement, so the walk happens ONCE per (geometry,
// pose) and every later call is answered from `extremeCache`: the six extreme
// VALUES, plus, per direction, the posed vertices tied with that direction's
// own extreme. `near` varies per call (it is the side the dim hangs off), so
// the tie-break itself still runs — over the handful of tied points instead of
// the whole soup.
//
// Per-mesh candidates are exact for the multi-mesh scan they feed: a vertex
// within TIE_TOL of the GLOBAL extreme is necessarily within TIE_TOL of its own
// mesh's extreme too (the mesh extreme sits between them), so nothing that
// could win is missing from the union — and the loop below re-filters against
// the global value regardless.
//
// A candidate is stored as its INDEX into the soup, not as a posed point: four
// bytes instead of twenty-four, and the tie-break still runs the same f64
// transform the un-cached version did, so the anchor it picks is bit-identical.
// The size question that buys is a real one — most parts sit on a flat face, so
// one direction's tie set can be a whole face of the mesh — and on the parts
// this was measured against the whole cache lands around 0.1% of the soup.
const TIE_TOL = 1e-3;
// The extremes and the tie sets are both POSED, so a record is only valid for
// the pose it was built from. A mesh's `matrix` is mutated in place by the
// viewer's pose fast path (setSubPose), so identity says nothing about it — the
// sixteen elements do.
const extremeCache = new WeakMap(); // positions -> { pose, lo, hi, cand: Uint32Array[6] }
const _sv = new THREE.Vector3();

const dirIndex = (axis, sign) => axis * 2 + (sign > 0 ? 0 : 1);

const samePose = (a, b) => {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
};

function meshExtremes(positions, matrix) {
  const hit = extremeCache.get(positions);
  if (hit && samePose(hit.pose, matrix.elements)) return hit;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    _sv.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
    for (let a = 0; a < 3; a++) {
      const v = _sv.getComponent(a);
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  const cand = [[], [], [], [], [], []];
  if (Number.isFinite(lo[0])) {
    for (let i = 0; i < positions.length; i += 3) {
      _sv.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      for (let a = 0; a < 3; a++) {
        const v = _sv.getComponent(a);
        if (Math.abs(v - hi[a]) <= TIE_TOL) cand[a * 2].push(i);
        if (Math.abs(v - lo[a]) <= TIE_TOL) cand[a * 2 + 1].push(i);
      }
    }
  }
  const rec = { pose: matrix.elements.slice(), lo, hi, cand: cand.map((c) => Uint32Array.from(c)) };
  extremeCache.set(positions, rec);
  return rec;
}

export function extremeVertex(meshData, axis, sign, near) {
  const dir = dirIndex(axis, sign);
  let bestVal = sign > 0 ? -Infinity : Infinity;
  const scan = [];
  for (const { positions, matrix } of meshData) {
    const rec = meshExtremes(positions, matrix);
    const v = sign > 0 ? rec.hi[axis] : rec.lo[axis];
    if (!Number.isFinite(v)) continue; // empty mesh
    scan.push({ positions, matrix, cand: rec.cand[dir] });
    if (sign > 0 ? v > bestVal : v < bestVal) bestVal = v;
  }
  if (!Number.isFinite(bestVal)) return null;
  let best = null, bestD = Infinity;
  for (const { positions, matrix, cand } of scan) {
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      _sv.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      if (Math.abs(_sv.getComponent(axis) - bestVal) > TIE_TOL) continue;
      const d = _sv.distanceToSquared(near);
      if (d < bestD) { bestD = d; best = _sv.clone(); }
    }
  }
  return best;
}

// --- one parametric linear dimension -----------------------------------------
// pA/pB: surface anchor points. nomA/nomB: NOMINAL dim-line endpoints used for
// discovery only. baseA/baseB: dim-line endpoints at ZERO standoff — the scene
// slides them out along `ext` by the screen-derived offset. When `surfaceHit`
// is given, each extension line starts at the first in-plane surface hit
// walking from the nominal endpoint back toward the part (ray nudged 0.05 mm
// inside the extreme plane so a grazing ray on the extreme face registers);
// otherwise (feature dims — anchors already ON the surface) it starts at the
// anchor. Either way the final anchor is projected onto its base point's ext
// line, so every record is square: pA − baseA and pB − baseB lie along `ext`.
// `ext` must be a unit vector perpendicular to baseB − baseA.
function linearDim(out, {
  pA, pB, baseA, baseB, nomA, nomB, ext, lane, standoffScale = 1,
  text, value, surfaceHit, planeAxis, planeC,
}) {
  const dir = baseB.clone().sub(baseA).normalize();
  const anchors = [pA, pB];
  [[pA, nomA, 1], [pB, nomB, -1]].forEach(([p, nom, inwardSign], i) => {
    if (!surfaceHit) return;
    const nudged = nom.clone().addScaledVector(dir, 0.05 * inwardSign);
    const toward = p.clone().sub(nom).normalize();
    const hit = surfaceHit(nudged, toward);
    if (hit) {
      const start = hit.clone();
      if (planeAxis != null) start.setComponent(planeAxis, planeC); // stay exactly coplanar
      anchors[i] = start;
    }
  });
  // Square drawing: each anchor slides onto the line through its base point
  // along `ext`. A surface hit (or a tie-broken extreme vertex) can then only
  // move an anchor ALONG its extension line, never tilt it — the 0.05 mm
  // inward nudge above used to leave pA − baseA with a component along the
  // dim line, and zoomed in the two extension lines leaned toward each other.
  [baseA, baseB].forEach((base, i) => {
    const p = anchors[i];
    anchors[i] = base.clone().addScaledVector(ext, p.clone().sub(base).dot(ext));
  });
  out.dims.push({
    pA: anchors[0].toArray(), pB: anchors[1].toArray(),
    baseA: baseA.toArray(), baseB: baseB.toArray(),
    ext: ext.toArray(), dir: dir.toArray(),
    lane, standoffScale,
    label: { text, value: value ?? null, x: dir.toArray(), y: ext.clone().negate().toArray() },
  });
}

// --- per-kind placement -------------------------------------------------------
function placeBox(out, item, spec, choices, { meshData, surfaceHit, modelSize, lanes, unit }, refSide) {
  const min = spec.anchors.min, max = spec.anchors.max;
  const nomOff = standoffNominal(modelSize);
  const scan = meshData; // caller pre-filtered by item.meshes
  const valueByAxis = [spec.values.w, spec.values.d, spec.values.h];
  const seenValues = new Set();
  for (const axis of [0, 1, 2]) {
    const span = max[axis] - min[axis];
    if (span < 1e-6) continue;
    // duplicate-value suppression within the item: a round or square part has
    // equal extents — one dim carries the shared value
    const text = `${unit.format(valueByAxis[axis])}${unit.suffix}`;
    if (seenValues.has(text)) continue;
    seenValues.add(text);
    const cand = boxCandidates(axis).find((c) => c.key === choices[`${item.id}|ax${axis}`]?.key)
      ?? boxCandidates(axis)[0];
    const { extAxis, sign, nAxis } = cand;
    const ext = AXES[extAxis].clone().multiplyScalar(sign);
    // dim-line base points: measured coordinate at min/max, ext coordinate on
    // the near face (zero standoff); the plane coordinate (nAxis) is snapped
    // below. Nominal points add the discovery standoff for raycast origins and
    // tie-break targets.
    const extBase = sign > 0 ? max[extAxis] : min[extAxis];
    const mk = (m, off) => {
      const p = new THREE.Vector3();
      p.setComponent(axis, m);
      p.setComponent(extAxis, extBase + sign * off);
      p.setComponent(nAxis, refSide(nAxis, min, max));
      return p;
    };
    const nomA = mk(min[axis], nomOff), nomB = mk(max[axis], nomOff);
    // true extreme anchors (tie-break toward the nominal dim line), then plane
    // snap: slide the plane along nAxis to whichever anchor sits nearer the
    // mid-plane reference; the other anchor projects into the plane.
    const ref = refSide(nAxis, min, max);
    let pA = extremeVertex(scan, axis, -1, nomA) ?? new THREE.Vector3().setComponent(axis, min[axis]);
    let pB = extremeVertex(scan, axis, +1, nomB) ?? new THREE.Vector3().setComponent(axis, max[axis]);
    const cA = pA.getComponent(nAxis), cB = pB.getComponent(nAxis);
    const c = Math.abs(cA - ref) <= Math.abs(cB - ref) ? cA : cB;
    const baseA = mk(min[axis], 0), baseB = mk(max[axis], 0);
    for (const p of [pA, pB, nomA, nomB, baseA, baseB]) p.setComponent(nAxis, c);
    linearDim(out, {
      pA, pB, baseA, baseB, nomA, nomB, ext,
      lane: laneFor(lanes, ext),
      text, value: valueByAxis[axis],
      surfaceHit, planeAxis: nAxis, planeC: c,
    });
  }
}

function placePlane(out, item, spec, choices, { lanes, unit }) {
  const n = v3(spec.anchors.normal).normalize();
  const dims = [
    ["width", spec.values.width],
    ["height", spec.values.height],
  ];
  for (const [dimKey, value] of dims) {
    if (value < 1e-6) continue;
    const a = v3(spec.anchors[dimKey].a), b = v3(spec.anchors[dimKey].b);
    const dir = b.clone().sub(a).normalize();
    const perp = new THREE.Vector3().crossVectors(n, dir).normalize();
    const sign = choices[`${item.id}|${dimKey}`]?.key === "p-" ? -1 : 1;
    const ext = perp.multiplyScalar(sign);
    linearDim(out, {
      pA: a, pB: b, baseA: a.clone(), baseB: b.clone(), nomA: a, nomB: b, ext,
      lane: laneFor(lanes, ext), standoffScale: 0.55, // feature dims hug their feature
      text: `${unit.format(value)}${unit.suffix}`, value, surfaceHit: null,
    });
  }
}

function placeCylinder(out, item, spec, choices, { lanes, unit }) {
  const axis = v3(spec.anchors.axis).normalize();
  const top = v3(spec.anchors.top);
  const bottom = v3(spec.anchors.bottom);
  const r = spec.values.diameter / 2;
  const du = v3(choices[`${item.id}|du`]?.du ?? spec.anchors.rimDir ?? [1, 0, 0]).normalize();
  const dv = new THREE.Vector3().crossVectors(axis, du).normalize();

  if (spec.values.partial) {
    // R leader from the covered-arc midpoint, radial, in the top plane
    const rd = v3(spec.anchors.rimDir ?? du.toArray()).normalize();
    const rim = top.clone().addScaledVector(rd, r);
    out.leaders.push({
      rim: rim.toArray(), dir: rd.toArray(),
      perp: new THREE.Vector3().crossVectors(axis, rd).normalize().toArray(),
      label: {
        text: `R${unit.format(r)}`, value: r,
        x: new THREE.Vector3().crossVectors(axis, rd).normalize().toArray(),
        y: rd.clone().negate().toArray(),
      },
    });
  } else {
    // full circle: diameter line across the top circle along dv — the
    // projected ellipse's WIDE axis (du, the camera radial, is its
    // foreshortened one) — arrows outward at both rim points, ⌀ text
    // continuing off the end of the line
    const rimA = top.clone().addScaledVector(dv, r);
    const rimB = top.clone().addScaledVector(dv, -r);
    out.diams.push({
      // scene contract: `du` is the label-offset direction off rimA (here the
      // line's own direction, so the text runs off the end of the diameter);
      // `dv` is the arrows' in-plane spread direction
      rimA: rimA.toArray(), rimB: rimB.toArray(), du: dv.toArray(), dv: du.toArray(),
      label: {
        text: `⌀${unit.format(spec.values.diameter)}`, value: spec.values.diameter,
        x: dv.toArray(), y: du.clone().negate().toArray(),
      },
    });
  }

  // depth: linear dim along the axis, hung off the silhouette at the chosen side
  if (spec.values.depth > 1e-6) {
    const extKey = choices[`${item.id}|depth`]?.key ?? "t+";
    const ext = ({
      "t+": dv.clone(), "t-": dv.clone().negate(),
      "d+": du.clone(), "d-": du.clone().negate(),
    })[extKey] ?? dv.clone();
    const pA = bottom.clone().addScaledVector(ext, r);
    const pB = top.clone().addScaledVector(ext, r);
    linearDim(out, {
      pA, pB, baseA: pA.clone(), baseB: pB.clone(), nomA: pA, nomB: pB, ext,
      lane: laneFor(lanes, ext), standoffScale: 0.55,
      text: `${unit.format(spec.values.depth)}${unit.suffix}`, value: spec.values.depth, surfaceHit: null,
    });
  }
}

// Two clicks: one dim along the span's measuring direction. Base points sit in
// the first point's plane — b is projected along that plane's normal
// n = d × ext, as placeBox's plane snap does — and the line is offset along
// ext to clear the farther of the two points.
function placeSpan(out, item, spec, choices, { lanes, unit }) {
  const { d, cands } = spanCandidates(spec);
  if (!cands.length || !(d.lengthSq() > 0.5)) return;
  const c = cands.find((x) => x.key === choices[`${item.id}|span`]?.key) ?? cands[0];
  const ext = c.ext.clone();
  const a = v3(spec.anchors.a), b = v3(spec.anchors.b);
  const n = new THREE.Vector3().crossVectors(d, ext).normalize();
  const bp = b.clone().addScaledVector(n, -b.clone().sub(a).dot(n));
  const t = bp.clone().sub(a).dot(d); // signed: the axis may point away from b
  if (Math.abs(t) < 1e-9) return;
  const o = Math.max(0, bp.clone().sub(a).dot(ext));
  const baseA = a.clone().addScaledVector(ext, o);
  const baseB = baseA.clone().addScaledVector(d, t);
  linearDim(out, {
    pA: a, pB: bp, baseA, baseB, nomA: a, nomB: bp, ext,
    lane: laneFor(lanes, ext), standoffScale: 0.55,
    text: `${unit.format(spec.values.distance)}${unit.suffix}`, value: spec.values.distance, surfaceHit: null,
  });
}

// One click on a straight edge: one dim from end to end, hugging the edge.
function placeEdge(out, item, spec, choices, { lanes, unit }) {
  if (!(spec.values.length > 1e-6)) return;
  const { d, cands } = edgeCandidates(spec);
  if (!cands.length || !(d.lengthSq() > 0.5)) return;
  const c = cands.find((x) => x.key === choices[`${item.id}|edge`]?.key) ?? cands[0];
  const ext = c.ext.clone();
  const a = v3(spec.anchors.a), b = v3(spec.anchors.b);
  linearDim(out, {
    pA: a, pB: b, baseA: a.clone(), baseB: b.clone(), nomA: a, nomB: b, ext,
    lane: laneFor(lanes, ext), standoffScale: 0.55,
    text: `${unit.format(spec.values.length)}${unit.suffix}`, value: spec.values.length, surfaceHit: null,
  });
}

// --- entry point --------------------------------------------------------------
export function placeDims(items, { meshData = [], surfaceHit = null, bounds, suppress = null, lanes: laneSeed = null, units = "mm" }, choices) {
  const size = bounds
    ? Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
    : 10;
  // duplicate-measurement suppression: see specSig. Later item wins in-call;
  // `suppress` carries sigs already drawn by another call (the base pass).
  const sigs = items.map((i) => (i.spec ? specSig(i.spec) : null));
  const skip = new Set();
  for (let i = 0; i < items.length; i++) {
    if (!sigs[i]) { skip.add(i); continue; }
    if (suppress?.has(sigs[i])) { skip.add(i); continue; }
    for (let j = i + 1; j < items.length; j++) {
      if (sigs[i] === sigs[j]) { skip.add(i); break; }
    }
  }
  // plane-snap reference: for bbox dims the plane snaps to whichever true
  // extreme anchor sits nearer the model's mid-plane along nAxis (see refSide
  // below) rather than to a camera side — deterministic and adequate: the
  // spec only requires "the side of the model the dim is drawn toward".
  const lanes = new Map(laneSeed ?? undefined);
  const unit = UNITS[units] ?? UNITS.mm;
  const drawings = [];
  items.forEach((item, idx) => {
    const spec = item.spec;
    if (!spec || skip.has(idx)) return;
    const out = { itemId: item.id, tier: item.tier, pinned: !!item.pinned, dims: [], diams: [], leaders: [] };
    const scan = item.meshes ? item.meshes.map((i) => meshData[i]).filter(Boolean) : meshData;
    if (spec.kind === "bbox") {
      const refSide = (nAxis, min, max) => {
        // draw-side reference along the plane normal: mid-plane — the snap then
        // picks whichever anchor is nearer the model's middle along n, keeping
        // the drawing close to where the extent actually occurs.
        return (min[nAxis] + max[nAxis]) / 2;
      };
      placeBox(out, item, spec, choices, { meshData: scan, surfaceHit, modelSize: size, lanes, unit }, refSide);
    } else if (spec.kind === "plane") {
      placePlane(out, item, spec, choices, { lanes, unit });
    } else if (spec.kind === "cylinder") {
      placeCylinder(out, item, spec, choices, { lanes, unit });
    } else if (spec.kind === "span") {
      placeSpan(out, item, spec, choices, { lanes, unit });
    } else if (spec.kind === "edge") {
      placeEdge(out, item, spec, choices, { lanes, unit });
    }
    if (out.dims.length || out.diams.length || out.leaders.length) drawings.push(out);
  });
  return drawings;
}

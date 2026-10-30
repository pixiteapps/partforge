// Pure readings for measure mode: what one click reads (firstReading) and what
// a second click measures (spanSpec). No three.js — plain arrays, like
// feature-dims.js and snaps.js. Values are mm, rounded with feature-dims' q2.
//
//   edge { kind, values: {length},   anchors: {a, b} }
//   span { kind, values: {distance}, anchors: {a, b, axis, axes, straight} }
//
// `axis` on a span is the measuring direction: a frame axis (dominant
// component), the shared face normal (a gap of at least MIN_SPAN_MM), or
// unit(b − a) when straight. spanSpecs is what two clicks show: the gap alone
// between parallel faces, else the straight-line distance plus each frame-axis
// component (one number when the clicks differ along one axis only).

import { COS_3DEG, q2 } from "./feature-dims.js";

const MIN_SPAN_MM = 0.005;
export const PARTS_AXES = Object.freeze([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

// One click. Returns the existing spec for a plane reading, the cylinder spec
// anchored at the click for a cylinder reading (⌀ or R, plus the depth when
// the wall face itself was clicked),
// a new `edge` spec for a straight edge, or null when the target is only a
// start point (corner, midpoint, point, curved edge, bbox or unnamed feature).
// `hitPoint`, the raw surface point under the pointer, says which side of a
// cylinder was clicked when the snap itself sits on the axis (a rim snaps to
// its centre).
export function firstReading(target, spec, { hitPoint } = {}) {
  if (!target || !spec) return null;
  const { kind } = target;
  if (spec.kind === "cylinder" && (kind === "circle" || kind === "face" || kind === "edge")) {
    // The wall face is the whole feature: ⌀ (R when partial) and its depth. A
    // rim or edge is just the circle: ⌀ alone. A copy either way, so the
    // cached feature spec is never touched.
    const values = kind === "face"
      ? { diameter: spec.values.diameter, depth: spec.values.depth, partial: spec.values.partial }
      : { diameter: spec.values.diameter, partial: spec.values.partial };
    return {
      ...spec,
      values,
      anchors: { ...spec.anchors, ...clickAnchors(target.point, hitPoint, spec.anchors) },
    };
  }
  if (spec.kind === "plane" && kind === "face") return spec;
  if (kind === "edge" && target.chain?.straight) {
    const pts = target.chain.points;
    return {
      kind: "edge",
      values: { length: q2(target.chain.length) },
      anchors: { a: pts[0], b: pts[pts.length - 1] },
    };
  }
  return null;
}

// Where a cylinder reading is drawn: `at`, the axis point level with the click
// (held to the wall's own length), and `clickDir`, the unit radial direction
// toward the click (the raw hit when given, else the snap) — absent when both
// lie on the axis. The
// placer draws there, so a reading appears at the spot that was clicked, not
// at whichever end of the feature its axis happens to point to.
const zero = (v) => v + 0; // no -0 in an anchor
function clickAnchors(point, hitPoint, { center, axis, top, bottom }) {
  const a = unit(axis);
  if (!point || !center || !a) return {};
  const along = (p) => dot(sub(p, center), a);
  const ends = [top, bottom].filter(Boolean).map(along);
  const t = along(point);
  const h = ends.length ? Math.min(Math.max(t, Math.min(...ends)), Math.max(...ends)) : t;
  const at = [center[0] + a[0] * h, center[1] + a[1] * h, center[2] + a[2] * h];
  const out = { at: at.map((v) => zero(q2(v))) };
  // square to the axis from each point's own level, before any clamp
  for (const p of [hitPoint, point]) {
    if (!p) continue;
    const s = along(p);
    const radial = sub(sub(p, center), [a[0] * s, a[1] * s, a[2] * s]);
    const r = len(radial);
    if (r > 1e-6) { out.clickDir = radial.map((v) => zero(v / r)); break; }
  }
  return out;
}

// The gap between two parallel named faces, measured along the first one's
// normal, or null. Only when there is a gap: two clicks on one face, or on
// coplanar faces, read the distance between the points instead.
function faceGap(d, faceNormals) {
  const [nA, nB] = faceNormals ?? [null, null];
  const n = nA && nB ? unit(nA) : null;
  const m = nA && nB ? unit(nB) : null;
  if (!n || !m || Math.abs(dot(n, m)) < COS_3DEG) return null;
  const distance = Math.abs(dot(d, n));
  return distance >= MIN_SPAN_MM ? { axis: n, distance } : null;
}

// Two clicks. a, b are parts-frame points; axes the three unit frame vectors;
// faceNormals [nA|null, nB|null] the parts-frame normals of named plane faces.
export function spanSpec(a, b, { axes = PARTS_AXES, straight = false, faceNormals = [null, null] } = {}) {
  const d = sub(b, a);
  let axis, distance;
  const gap = faceGap(d, faceNormals);
  if (gap) {
    ({ axis, distance } = gap);
  } else if (straight) {
    distance = len(d);
    axis = unit(d);
  } else {
    let best = -1;
    for (const ax of axes) {
      const c = Math.abs(dot(d, ax));
      if (c > best) { best = c; axis = ax; }
    }
    distance = best;
  }
  if (!(distance >= MIN_SPAN_MM) || !axis) return null;
  return {
    kind: "span",
    values: { distance: q2(distance) },
    // copies: `axis` may be one of PARTS_AXES' inner arrays, and a caller
    // mutating a spec must not corrupt every later span
    anchors: { a, b, axis: [...axis], axes: axes.map((v) => [...v]), straight: !!straight },
  };
}

// A component shorter than this share of the straight-line distance is snap
// slop, not an offset anyone measured: 0.01 mm across a 20 mm diagonal would
// otherwise draw a dimension of its own.
const COMPONENT_MIN_SHARE = 0.002;

// Everything two clicks show, in a fixed order: the axis components in frame
// order, then the straight-line distance. Between two parallel named faces
// with a gap, only the gap — that is a thickness, and its offsets along the
// faces are noise. Empty when the points coincide.
export function spanSpecs(a, b, { axes = PARTS_AXES, faceNormals = [null, null] } = {}) {
  const d = sub(b, a);
  if (faceGap(d, faceNormals)) return [spanSpec(a, b, { axes, faceNormals })];
  const straight = spanSpec(a, b, { axes, straight: true });
  if (!straight) return [];
  const floor = Math.max(MIN_SPAN_MM, COMPONENT_MIN_SHARE * len(d));
  const parts = [];
  for (const ax of axes) {
    const c = Math.abs(dot(d, ax));
    if (c < floor) continue;
    parts.push({
      kind: "span",
      values: { distance: q2(c) },
      anchors: { a, b, axis: [...ax], axes: axes.map((v) => [...v]), straight: false },
    });
  }
  return parts.length > 1 ? [...parts, straight] : parts.length ? parts : [straight];
}

// The frame a two-click span squares to. Same sub-part: that mesh's rotation
// columns (matrixOf returns a Matrix4-like {elements} or a column-major
// 16-array; scale is normalised away). Otherwise, or with no matrix: parts axes.
export function frameAxesFor(subPartA, subPartB, matrixOf) {
  if (subPartA == null || subPartA !== subPartB || !matrixOf) return PARTS_AXES.map((v) => [...v]);
  const m = matrixOf(subPartA);
  const e = m?.elements ?? m;
  if (!e || e.length < 11) return PARTS_AXES.map((v) => [...v]);
  const cols = [unit([e[0], e[1], e[2]]), unit([e[4], e[5], e[6]]), unit([e[8], e[9], e[10]])];
  if (cols.some((c) => !c)) return PARTS_AXES.map((v) => [...v]);
  return cols;
}

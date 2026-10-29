// Pure readings for measure mode: what one click reads (firstReading) and what
// a second click measures (spanSpec). No three.js — plain arrays, like
// feature-dims.js and snaps.js. Values are mm, rounded with feature-dims' q2.
//
//   edge { kind, values: {length},   anchors: {a, b} }
//   span { kind, values: {distance}, anchors: {a, b, axis, axes, straight} }
//
// `axis` on a span is the measuring direction: a frame axis (dominant
// component), the shared face normal (a gap), or unit(b − a) when straight.

import { COS_3DEG, q2 } from "./feature-dims.js";

const MIN_SPAN_MM = 0.005;
export const PARTS_AXES = Object.freeze([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

// One click. Returns the existing spec object for a cylinder or plane reading,
// a new `edge` spec for a straight edge, or null when the target is only a
// start point (corner, midpoint, point, curved edge, bbox or unnamed feature).
export function firstReading(target, spec) {
  if (!target || !spec) return null;
  const { kind } = target;
  if (spec.kind === "cylinder" && (kind === "circle" || kind === "face" || kind === "edge")) return spec;
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

// Two clicks. a, b are parts-frame points; axes the three unit frame vectors;
// faceNormals [nA|null, nB|null] the parts-frame normals of named plane faces.
export function spanSpec(a, b, { axes = PARTS_AXES, straight = false, faceNormals = [null, null] } = {}) {
  const d = sub(b, a);
  let axis, distance;
  const [nA, nB] = faceNormals ?? [null, null];
  const n = nA && nB ? unit(nA) : null;
  const m = nA && nB ? unit(nB) : null;
  if (n && m && Math.abs(dot(n, m)) >= COS_3DEG) {
    axis = n;
    distance = Math.abs(dot(d, n));
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
    anchors: { a, b, axis, axes, straight: !!straight },
  };
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

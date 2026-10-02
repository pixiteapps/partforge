// Where a styled capture puts its camera, for BOTH renderers: the viewer's
// captures (its throwaway thumbnail scene and its live-scene agent renders)
// and the CPU renderer call this one function, so they frame every view
// identically. World space is the viewer's Y-up frame
// (the pivot's rotation.x = -PI/2 maps model (x, y, z) -> world (x, z, -y)).
// Pure — no three.js.
import { cameraPoseForView } from "./view-angles.js";
import { RENDER_STYLES } from "./renderStyles.js";

const DEFAULT_RADIUS = 10; // the viewer's own `|| 10` fallback for an empty box
const RECENTER_PASSES = 3; // fitPoseToPoints' recentre/re-solve rounds (see there)

export function modelToWorld(arr) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i + 2 < arr.length; i += 3) {
    out[i] = arr[i]; out[i + 1] = arr[i + 2]; out[i + 2] = -arr[i + 1];
  }
  return out;
}

export function boundsOf(arrays) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const a of arrays) {
    for (let i = 0; i + 2 < (a?.length ?? 0); i += 3) {
      any = true;
      for (let k = 0; k < 3; k++) { if (a[i + k] < min[k]) min[k] = a[i + k]; if (a[i + k] > max[k]) max[k] = a[i + k]; }
    }
  }
  return any ? { min, max } : null;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// The camera basis a fit works in: d (target -> camera), right and trueUp,
// from the canonical view's direction and up vector.
function fitBasis(view, center) {
  const base = cameraPoseForView(view, { center, radius: 1 });
  const d = norm(sub(base.position, center)); // centre -> camera
  const f = [-d[0], -d[1], -d[2]];
  let right = cross(f, base.up);
  if (Math.hypot(...right) < 1e-9) right = cross(f, [0, 0, 1]);
  right = norm(right);
  return { d, right, up: cross(right, f), baseUp: base.up };
}

// Fit a view to the geometry itself rather than to its bounding box: a box's
// corners stand well outside a long, thin or L-shaped part, which then sits
// small and off-centre. `points` are flat WORLD (Y-up) xyz triples; null when
// there is nothing to frame (no points, or one point repeated).
//
// The view keeps its canonical direction and up. For a point at offset r from
// the target, at camera distance D along d, it is inside `fill` of the frame
// when
//   |r·right| <= (D - r·d)·tanH·aspect·fill  and  |r·up| <= (D - r·d)·tanH·fill
// so the nearest such D is the max over points of the two rearranged bounds.
// Pass 1 aims at the bbox centre. The projected extent is then generally
// lopsided (perspective, and a shape that is not symmetric about its box
// centre), so the target slides sideways by the projected NDC bbox centre —
// converted back to world units at distance D — and D is re-solved around the
// shifted target. One recentre is not quite enough for a part with real depth
// along the view (a 60 mm bar seen at iso was still ~0.04 NDC off after it,
// because the re-solved D changes the perspective the recentre measured), so
// the recentre/re-solve runs RECENTER_PASSES times: ~0.002 on that bar. The
// last step is always a re-solve, so every point stays inside `fill` whatever
// the recentring achieved. (Looking straight down a long bar puts its near end
// almost at the eye, where no amount of sliding centres it; it stays in frame.)
export function fitPoseToPoints(view, points, { fov, aspect = 1, fill }) {
  const box = boundsOf([points]);
  if (!box || box.min.every((v, i) => v === box.max[i])) return null;
  const center = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
  const { d, right, up, baseUp } = fitBasis(view, center);
  const tanH = Math.tan((fov * Math.PI) / 360);
  const t = tanH * fill;
  const n = points.length - (points.length % 3);

  // Per point: [depth, x, y] = r·d, r·right, r·up for r = p − target. Scalar
  // and allocation-free — this runs over every vertex of the part, per view.
  const project = (target, fn) => {
    for (let i = 0; i < n; i += 3) {
      const rx = points[i] - target[0], ry = points[i + 1] - target[1], rz = points[i + 2] - target[2];
      fn(rx * d[0] + ry * d[1] + rz * d[2], rx * right[0] + ry * right[1] + rz * right[2], rx * up[0] + ry * up[1] + rz * up[2]);
    }
  };
  const distance = (target) => {
    let D = 0;
    project(target, (depth, x, y) => {
      D = Math.max(D, depth + Math.abs(x) / (t * aspect), depth + Math.abs(y) / t);
    });
    return D;
  };

  let target = center;
  let D = distance(target);
  for (let pass = 0; pass < RECENTER_PASSES; pass++) {
    // Recentre: the NDC bbox of every point seen from target + d·D. A point at
    // the eye plane (only a line along the view axis puts one there) has no
    // projection and is left out rather than poisoning the bbox with Infinity.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    project(target, (depth, x, y) => {
      const z = D - depth;
      if (!(z > 1e-12)) return;
      const nx = x / (z * tanH * aspect), ny = y / (z * tanH);
      if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
    });
    if (!(minX <= maxX)) break;
    const sx = ((minX + maxX) / 2) * D * tanH * aspect, sy = ((minY + maxY) / 2) * D * tanH;
    target = [0, 1, 2].map((i) => target[i] + right[i] * sx + up[i] * sy);
    D = distance(target);
  }
  return { position: [0, 1, 2].map((i) => target[i] + d[i] * D), up: baseUp, target };
}

// `points` (flat world xyz, optional) lets a "fit" style frame the geometry
// itself (fitPoseToPoints); without them it fits the box's eight corners.
export function stylePose(style, view, box, { aspect = 1, points } = {}) {
  const fov = style.camera.fov;
  const min = box?.min ?? [0, 0, 0], max = box?.max ?? [0, 0, 0];
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const size = sub(max, min);
  const diag = Math.hypot(size[0], size[1], size[2]);
  // Enclosing radius for the depth planes; a shadow plane reaches 2·blur·diag
  // past the footprint (contact-shadow.js pads by that much).
  const pad = style.shadow ? 2 * style.shadow.blur * diag : 0;
  const sceneBounds = { center, radius: (diag / 2 || DEFAULT_RADIUS) + pad };

  if (style.camera.framing === "canonical" || diag === 0) {
    const radius = Math.max(size[0], size[1], size[2]) / 2 || DEFAULT_RADIUS;
    return { pose: cameraPoseForView(view, { center, radius }), fov, sceneBounds };
  }

  const fitted = points?.length >= 3 && fitPoseToPoints(view, points, { fov, aspect, fill: style.camera.fill });
  if (fitted) return { pose: fitted, fov, sceneBounds };

  // Fallback fit, with no points to hand: the same bound over the box's eight
  // corners, aimed at the box centre (see fitPoseToPoints for the inequality).
  const { d, right, up, baseUp } = fitBasis(view, center);
  const t = Math.tan((fov * Math.PI) / 360) * style.camera.fill;
  let D = 0;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const r = sub([x, y, z], center);
    const depth = dot(r, d);
    D = Math.max(D, depth + Math.abs(dot(r, right)) / (t * aspect), depth + Math.abs(dot(r, up)) / t);
  }
  const position = [center[0] + d[0] * D, center[1] + d[1] * D, center[2] + d[2] * D];
  return { pose: { position, up: baseUp, target: center }, fov, sceneBounds };
}

// The offsets (renderStyles.js) are camera-space multiples of the camera-to-target
// distance: the key sits over the viewer's shoulder (up and to the right, ~41° off the
// view axis), the fill opposes it from the left at eye level. Both still shine mostly
// ALONG the view direction, so whatever the camera can see is lit.

// World-space positions for the capture key/fill, given a camera pose (the same
// `{position, up, target}` shape cameraPoseForView returns). Pure — no THREE, no scene.
export function captureLightPoses({ position, up, target }, lights = RENDER_STYLES.cad.lights) {
  const forward = norm(sub(target, position));
  // Camera basis. A canonical view never passes an `up` parallel to its own view axis,
  // but a caller could, and a degenerate basis would put NaN into the light positions.
  let right = cross(forward, up);
  if (Math.hypot(...right) < 1e-6) right = cross(forward, [0, 0, 1]);
  if (Math.hypot(...right) < 1e-6) right = cross(forward, [0, 1, 0]);
  right = norm(right);
  const trueUp = norm(cross(right, forward));
  const dist = Math.hypot(...sub(target, position)) || 1;
  const place = (offset) => [0, 1, 2].map(
    (i) => position[i] + (right[i] * offset.right + trueUp[i] * offset.up) * dist,
  );
  return { key: place(lights.key.offset), fill: place(lights.fill.offset) };
}

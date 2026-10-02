// Where a styled capture puts its camera, for BOTH renderers: the viewer's
// throwaway thumbnail scene and the CPU renderer call this one function, so
// they frame every view identically. World space is the viewer's Y-up frame
// (the pivot's rotation.x = -PI/2 maps model (x, y, z) -> world (x, z, -y)).
// Pure — no three.js.
import { cameraPoseForView } from "./view-angles.js";
import { RENDER_STYLES } from "./renderStyles.js";

const DEFAULT_RADIUS = 10; // the viewer's own `|| 10` fallback for an empty box

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

export function stylePose(style, view, box, { aspect = 1 } = {}) {
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

  // Fit: the canonical direction and up, at the nearest distance that keeps
  // all eight box corners within `fill` of the frame's half-extent. For a
  // corner at offset r from the centre, at camera distance D along d:
  //   |r·right| <= (D - r·d)·tanH·aspect·fill  and  |r·up| <= (D - r·d)·tanH·fill
  const base = cameraPoseForView(view, { center, radius: 1 });
  const d = norm(sub(base.position, center)); // centre -> camera
  const f = [-d[0], -d[1], -d[2]];
  let right = cross(f, base.up);
  if (Math.hypot(...right) < 1e-9) right = cross(f, [0, 0, 1]);
  right = norm(right);
  const up = cross(right, f);
  const t = Math.tan((fov * Math.PI) / 360) * style.camera.fill;
  let D = 0;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const r = sub([x, y, z], center);
    const depth = dot(r, d);
    D = Math.max(D, depth + Math.abs(dot(r, right)) / (t * aspect), depth + Math.abs(dot(r, up)) / t);
  }
  const position = [center[0] + d[0] * D, center[1] + d[1] * D, center[2] + d[2] * D];
  return { pose: { position, up: base.up, target: center }, fov, sceneBounds };
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

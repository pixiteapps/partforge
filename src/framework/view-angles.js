// Canonical camera angles for headless/offscreen captures, in the viewer's
// three.js WORLD space (Y-up). The model is authored Z-up; the viewer's pivot
// rotates it into Y-up, so these directions are expressed Y-up directly. Kept in
// one place so the cloud render tool and any future headless capture agree.
export const CANONICAL_VIEWS = ["iso", "front", "back", "top", "bottom", "left", "right"];

// Direction FROM the part centre TOWARD the camera (world Y-up), plus the up vector.
const DIRS = {
  iso:    { dir: [1, 1, 1],   up: [0, 1, 0] },
  front:  { dir: [0, 0, 1],   up: [0, 1, 0] },
  back:   { dir: [0, 0, -1],  up: [0, 1, 0] },
  top:    { dir: [0, 1, 0],   up: [0, 0, -1] },
  bottom: { dir: [0, -1, 0],  up: [0, 0, 1] },
  left:   { dir: [-1, 0, 0],  up: [0, 1, 0] },
  right:  { dir: [1, 0, 0],   up: [0, 1, 0] },
};

// The view cube's 26 orientations: 6 faces, 12 edges, 8 corners. Deliberately
// SEPARATE from CANONICAL_VIEWS, which stays at 7 — captureViewsFromScene
// slices against its length and the CLI names it, so growing that list would
// change contracts the cube has no business touching. The seven canonical
// names resolve to identical poses (iso === top-front-right).
//
// Face names are MODEL-frame (parts are authored Z-up); the world directions
// below already carry the pivot's rotation.x = -PI/2, which maps model
// (x, y, z) -> world (x, z, -y).
const FACE_DIRS = {
  right:  [1, 0, 0],   // model +X
  left:   [-1, 0, 0],  // model -X
  top:    [0, 1, 0],   // model +Z
  bottom: [0, -1, 0],  // model -Z
  front:  [0, 0, 1],   // model -Y
  back:   [0, 0, -1],  // model +Y
};

// Canonical id ordering. A compound id always reads vertical, then depth, then
// side — "top-front-right", never "right-front-top" — so cube-geom.js can
// assemble an id from three independent axis choices and land on the same
// string every time.
const VERTICAL = ["top", "bottom"];
const DEPTH = ["front", "back"];
const SIDE = ["left", "right"];

// A pure top or bottom view is degenerate against a +Y up vector, so those two
// keep the special-cased ups DIRS already used. Every compound orientation has
// a well-defined +Y up.
//
// These ups matter to the OFFSCREEN capture path, which builds a temp camera and
// calls lookAt itself with no orbit frame to fall back on. The LIVE camera never
// needs them: it is driven through OrbitControls, whose polar frame derives the
// same roll on its own at azimuth 0 (a top cue lands with screen-up on world -Z,
// which is exactly [0, 0, -1]). Handing the live camera a non-+Y `up` would also
// re-base every subsequent orbit drag and would not survive getCameraState, so it
// deliberately keeps the default.
function upFor(parts) {
  if (parts.length === 1 && parts[0] === "top") return [0, 0, -1];
  if (parts.length === 1 && parts[0] === "bottom") return [0, 0, 1];
  return [0, 1, 0];
}

function buildOrientations() {
  const out = {};
  const add = (parts) => {
    const dir = [0, 0, 0];
    for (const part of parts) {
      const d = FACE_DIRS[part];
      dir[0] += d[0];
      dir[1] += d[1];
      dir[2] += d[2];
    }
    const id = parts.join("-");
    out[id] = { id, parts: [...parts], dir, up: upFor(parts) };
  };
  for (const face of Object.keys(FACE_DIRS)) add([face]);
  for (const v of VERTICAL) for (const other of [...DEPTH, ...SIDE]) add([v, other]);
  for (const d of DEPTH) for (const s of SIDE) add([d, s]);
  for (const v of VERTICAL) for (const d of DEPTH) for (const s of SIDE) add([v, d, s]);
  return out;
}

export const ORIENTATIONS = buildOrientations();
export const ORIENTATION_IDS = Object.keys(ORIENTATIONS);

// Every angle an animation camera cue may name: the seven canonical names first,
// then the view cube's other orientations (so "top-front-left" is iso seen from
// the other front corner). cameraPoseForView resolves all of them; this list is
// what lint holds cues to. Kept apart from CANONICAL_VIEWS for the reason the
// comment on ORIENTATIONS gives.
export const CAMERA_CUE_VIEWS = [...new Set([...CANONICAL_VIEWS, ...ORIENTATION_IDS])];

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// A free-form camera cue: `{ azimuth, elevation, distance? }`, for the angles no
// name reaches ("halfway between iso and level"). Degrees, in the MODEL frame
// the face names already use: azimuth 0 looks from the front (model -Y) and
// turns toward the right (model +X) at 90, back at 180, left at -90 (or 270);
// elevation is above the horizontal, 90 straight down from the top. So iso is
// { azimuth: 45, elevation: 35.26 } and front-right is { azimuth: 45,
// elevation: 0 }. `distance` multiplies the framing distance a named angle
// would use (1, the default, frames the part exactly as a name does; 2 is
// twice as far out), so a cue keeps meaning the same thing as the part's
// params change its size. The camera always aims at the part's centre: a cue
// orbits, it never pans.
export const CAMERA_ORBIT_KEYS = ["azimuth", "elevation", "distance"];
export const CAMERA_ORBIT_DISTANCE = { min: 0.1, max: 10 };

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Why `v` is not a valid orbit cue, as a short phrase; null when it is.
export function cameraOrbitProblem(v) {
  if (!isPlainObject(v)) return "is not an { azimuth, elevation } object";
  const extra = Object.keys(v).filter((k) => !CAMERA_ORBIT_KEYS.includes(k));
  if (extra.length) return `has unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => `\`${k}\``).join(", ")}`;
  if (!Number.isFinite(v.azimuth)) return "needs a finite numeric `azimuth` (degrees)";
  if (!Number.isFinite(v.elevation)) return "needs a finite numeric `elevation` (degrees)";
  if (v.elevation < -90 || v.elevation > 90) return "has an `elevation` outside -90..90";
  if (v.distance !== undefined) {
    const { min, max } = CAMERA_ORBIT_DISTANCE;
    if (!Number.isFinite(v.distance) || v.distance < min || v.distance > max) {
      return `has a \`distance\` outside ${min}..${max} (a multiple of the default framing distance)`;
    }
  }
  return null;
}

// Every value a camera cue may be: an angle name from CAMERA_CUE_VIEWS, or an orbit.
export function isCameraCue(v) {
  if (typeof v === "string") return CAMERA_CUE_VIEWS.includes(v);
  return cameraOrbitProblem(v) === null;
}

// A filename- and log-safe label for a cue: the name itself, or e.g.
// "az30-el20" / "az30-el20-d1.5" for an orbit.
export function cameraCueLabel(cue) {
  if (typeof cue === "string") return cue;
  const n = (x) => String(Math.round(x * 100) / 100).replace("-", "m");
  return `az${n(cue.azimuth)}-el${n(cue.elevation)}${cue.distance !== undefined && cue.distance !== 1 ? `-d${n(cue.distance)}` : ""}`;
}

const RAD = Math.PI / 180;

// World (Y-up) direction and up for an orbit. Model (x, y, z) -> world (x, z, -y)
// as everywhere else in this file, so model (sin az·cos el, -cos az·cos el, sin el)
// lands at world (sin az·cos el, sin el, cos az·cos el).
function orbitAngle({ azimuth, elevation }) {
  const az = azimuth * RAD, el = elevation * RAD;
  const h = Math.cos(el);
  const dir = [Math.sin(az) * h, Math.sin(el), Math.cos(az) * h];
  // Straight down (or up) a +Y up is degenerate; use the screen-up a camera
  // approaching that pole from this azimuth would have, which at azimuth 0 is
  // exactly the `up` the top/bottom names use.
  let up = [0, 1, 0];
  if (Math.abs(h) < 1e-9) {
    const s = elevation > 0 ? -1 : 1;
    up = [s * Math.sin(az), 0, s * Math.cos(az)];
  }
  return { dir, up };
}

const framingDistance = (radius) => radius * 2.6 + 6; // matches viewer.frameTo's framing distance

export function cameraPoseForView(view, { center, radius }) {
  // DIRS first so the seven canonical names keep their exact existing poses;
  // ORIENTATIONS covers the other nineteen the cube can reach; an object is an orbit.
  let a, scale = 1;
  if (typeof view === "string") {
    a = DIRS[view] ?? ORIENTATIONS[view];
    if (!a) throw new Error(`unknown canonical view "${view}"`);
  } else {
    const problem = cameraOrbitProblem(view);
    if (problem) throw new Error(`camera cue ${problem}`);
    a = orbitAngle(view);
    scale = view.distance ?? 1;
  }
  const d = norm(a.dir);
  const dist = framingDistance(radius) * scale;
  return {
    position: [center[0] + d[0] * dist, center[1] + d[1] * dist, center[2] + d[2] * dist],
    up: a.up,
    target: [...center],
  };
}

// The inverse of an orbit cue: the cue that reproduces a live camera's angle and
// distance, so a host (or the agent behind it) can say "keep the view the user
// has now". `position`/`target` are the viewer's world (Y-up) camera state, and
// `radius` the same framing radius cameraPoseForView takes for this scene.
// Rounded to 0.1° and 0.01× — finer than the eye can tell — so the result reads
// like something an author would write. A pan is not representable (cues always
// aim at the centre), so it is reported rather than silently dropped. Null for a
// camera sitting on its target.
export function cameraCueForPose({ position, target }, { center, radius }) {
  const off = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
  const len = Math.hypot(off[0], off[1], off[2]);
  if (!(len > 1e-9)) return null;
  const [x, y, z] = [off[0] / len, off[1] / len, off[2] / len];
  const round = (v, step) => Math.round(v / step) * step;
  const fix = (v, places) => Number(v.toFixed(places)) || 0; // || 0 folds -0
  const elevation = fix(round(Math.asin(Math.max(-1, Math.min(1, y))) / RAD, 0.1), 1);
  // Azimuth is meaningless at a pole; 0 matches the top/bottom names' roll.
  const azimuth = Math.abs(elevation) >= 90 ? 0 : fix(round(Math.atan2(x, z) / RAD, 0.1), 1);
  const { min, max } = CAMERA_ORBIT_DISTANCE;
  const distance = fix(Math.min(max, Math.max(min, round(len / framingDistance(radius), 0.01))), 2);
  const panned = Math.hypot(target[0] - center[0], target[1] - center[1], target[2] - center[2]);
  return {
    cue: distance === 1 ? { azimuth, elevation } : { azimuth, elevation, distance },
    // How far the user's orbit target sits from the part centre the cue aims at,
    // as a fraction of the framing radius. 0 when they never panned.
    panned: radius > 0 ? fix(panned / radius, 2) : 0,
  };
}

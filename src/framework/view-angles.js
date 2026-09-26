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

export function cameraPoseForView(view, { center, radius }) {
  // DIRS first so the seven canonical names keep their exact existing poses;
  // ORIENTATIONS covers the other nineteen the cube can reach.
  const a = DIRS[view] ?? ORIENTATIONS[view];
  if (!a) throw new Error(`unknown canonical view "${view}"`);
  const d = norm(a.dir);
  const dist = radius * 2.6 + 6; // matches viewer.frameTo's framing distance
  return {
    position: [center[0] + d[0] * dist, center[1] + d[1] * dist, center[2] + d[2] * dist],
    up: a.up,
    target: [...center],
  };
}

// Shared, backend-agnostic Shape2D factory. Storage is the curve-native contour IR
// (Tasks 4-10's regions: [{outer, holes}]) — booleans/transforms/queries all run against
// that IR directly (paper.js under the hood for booleans/area/bounds, no backend WASM
// involved). `toRegions()`/`simple()` are the only points where a shape gets tessellated
// down to point rings, for handoff to a kernel op (extrude/revolve) or export.
//
// `deps.extrude`/`deps.revolve` are the two backends' own hooks (Task 13 wires
// Manifold/OCCT versions); everything else here is pure curve math shared by both,
// including offset, which now runs the native contour-offset engine directly rather
// than through a backend hook. Each op returns a NEW Shape2D — value semantics, no
// operand is ever mutated.
import { addShape2dSugar } from "./shape2d-sugar.js";
import { assembleRegions } from "./shape2d-regions.js";
import { tessellateContour } from "./profile.js";
import { booleanRegions } from "./paper-bridge.js";
import { offsetRegions } from "./contour-offset.js";
import { h } from "./solid-hash.js";
import { closeContourGap } from "./profile.js";
import {
  liftProfile, ensureRegionWinding, translateProfile, rotateProfile, scaleProfile,
  mirrorProfile, filletProfile, chamferProfile, simplifyProfile, profileCorners,
  profileArea, profileBounds, profileContains,
} from "./contour-ops.js";

const deepCopy = (regions) => JSON.parse(JSON.stringify(regions));

// Degenerate-input guard, carried over from the tessellation path the Manifold
// backend used to lift through: a 2-point "polygon" bounds no area, and silently
// accepting one yields an empty shape instead of an error. POINT LISTS only — a
// curve contour legitimately closes in one or two segments (a circle is two arcs),
// so no segment-count rule applies there. Every lift runs this, including the ones
// behind a boolean operand (`.cut([[0,0],[1,0]])`), so the message names the VALUE
// (Shape2D) rather than the `shape2d()` entry point.
const isPointList = (x) => Array.isArray(x) && Array.isArray(x[0]);
const checkPointRing = (c, role) => {
  if (isPointList(c) && c.length < 3) throw new Error(`Shape2D: a point-list ${role} needs ≥3 points`);
};
const checkProfile = (x) => {
  if (!x || x._shape2d) return;
  if (isPointList(x)) { checkPointRing(x, "profile"); return; }
  for (const rg of Array.isArray(x) ? x : [x]) {
    if (!rg || !rg.outer) continue;
    checkPointRing(rg.outer, "outer contour");
    for (const hole of rg.holes ?? []) checkPointRing(hole, "hole");
  }
};

// `recordWarning` is the kernel's build-warning recorder (see manifold-backend /
// occt-backend). Corner ops CLAMP a magnitude the geometry cannot take rather
// than throwing, and a clamp that only reached the console would leave a caller
// believing it got the radius it asked for.
export function makeShape2dFactory({ segs, extrude, revolve, recordWarning, warnProfile }) {
  // Lift any accepted profile form into stored regions: a live Shape2D is deep-copied out
  // via its own toContours() (value semantics — never alias another shape's storage);
  // anything else goes through liftProfile + per-ring winding normalization. A raw
  // profile is also the one place a hand-authored outline enters 2-D storage — from
  // k.shape2d(x) or as a boolean operand — so it is where a self-crossing one is
  // reported (profile-warnings.js). `trusted` skips that for the kernel's own
  // machine-resolved lifts (text2d glyphs, vector2d documents).
  const liftRegions = (x, { trusted = false } = {}) => {
    if (x && x._shape2d) return deepCopy(x._regions);
    checkProfile(x);
    if (!trusted) warnProfile?.("shape2d: profile", x);
    return liftProfile(x).regions.map(ensureRegionWinding);
  };

  const make = (regions) => {
    const hash = h("shape2d", regions);
    const viaOps = (fn) => make(fn(regions));            // regions-in → regions-out delegation
    const s = {
      _shape2d: true, _regions: regions, _hash: hash,
      union:     (o) => make(booleanRegions(regions, liftRegions(o), "unite")),
      cut:       (o) => make(booleanRegions(regions, liftRegions(o), "subtract")),
      cutAll:    (os) => make(os.reduce((acc, o) => booleanRegions(acc, liftRegions(o), "subtract"), regions)),
      intersect: (o) => make(booleanRegions(regions, liftRegions(o), "intersect")),
      // offset now runs the shared native engine directly, like the booleans above — no
      // backend hook. Its result feeds straight into make() without routing through
      // liftRegions, so unlike every other op here nothing already guaranteed its rings
      // are explicitly closed; offsetRegions' own readback closes explicitly today, so
      // this is a no-op in practice. It's here so the storage invariant (every stored
      // ring explicitly closed — see closeContourGap's own comment) holds unconditionally.
      // Empty in → empty out without entering the engine: the 2-D ops stay total on the
      // empty shape, and the engine would otherwise read an empty result as a collapse
      // and throw. Only 3-D materialization (extrude/revolve) rejects the empty shape.
      offset:    (delta, opts = {}) => regions.length === 0 ? make([]) : make(offsetRegions(regions, delta, opts)
        .map((rg) => ({ outer: closeContourGap(rg.outer), holes: rg.holes.map(closeContourGap) }))),
      isEmpty:   () => regions.length === 0,
      area:      () => profileArea(regions),
      boundingBox: () => profileBounds(regions),
      toRegions: () => assembleRegions(regions.flatMap((rg) =>
        [tessellateContour(rg.outer, segs), ...rg.holes.map((hl) => tessellateContour(hl, segs))])),
      toContours: () => deepCopy(regions),
      clone:     () => make(deepCopy(regions)),
      translate: (v) => viaOps((r) => translateProfile(r, v)),
      rotate:    (deg, center) => viaOps((r) => rotateProfile(r, deg, center)),
      scale:     (f, center) => viaOps((r) => scaleProfile(r, f, center)),
      mirror:    (axis) => viaOps((r) => mirrorProfile(r, axis)),
      fillet:    (r, opts) => viaOps((rg) => filletProfile(rg, r, opts, recordWarning)),
      chamfer:   (d, opts) => viaOps((rg) => chamferProfile(rg, d, opts, recordWarning)),
      simplify:  (tol) => viaOps((r) => simplifyProfile(r, tol)),
      corners:   () => profileCorners(regions),
      contains:  (p) => profileContains(regions, p),
    };
    return addShape2dSugar(s, { shape2d, extrude, revolve });
  };
  const shape2d = (profile) => (profile && profile._shape2d ? profile : make(liftRegions(profile)));
  shape2d.trusted = (profile) => (profile && profile._shape2d ? profile : make(liftRegions(profile, { trusted: true })));
  return shape2d;
}

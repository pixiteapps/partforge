// Resolve a sheet sub-part's declaration at (p, d) into shapes, and build its preview.
//
// PROBE-SAFE: everything here calls kernel and Shape2D METHODS only — no toContours,
// isEmpty, area, boundingBox or regions (the pose/parameter probes treat those as
// queries, poison trust and hand back dummies; pose-probe-core.js), and never branches
// on geometry. That is what keeps every sheet part's pose trusted, so a pose-only
// slider drag re-poses instead of rebuilding.
//
// Paper-free (the oracle imports this module — test/oracle-no-paper.test.js): a score
// line's groove is a plain butt-capped rectangle, never geometry/stroke-outline.js,
// which reaches paper through contour-ops.js.
import { EMPTY_MARK_RE, MARK_DEPTH, MARK_OVERCUT, SCORE_WIDTH, sheetGroup } from "./constants.js";
import { poseSteps, validatePose } from "./pose.js";

const fail = (sp, problem) => new Error(`sheet part${sp.label ? ` "${sp.label}"` : ""}: ${problem}`);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isLine = (e) => Array.isArray(e) && e.length === 2
  && e.every((pt) => Array.isArray(pt) && pt.length === 2 && isNum(pt[0]) && isNum(pt[1]));

// Run `make`; a mark that turned out empty (an empty Shape2D extruded, an offset that
// collapsed) comes back null instead of failing the build. Matched by MESSAGE, never
// by asking the shape whether it is empty — that would be a probe query.
function orEmpty(make) {
  try {
    return make();
  } catch (e) {
    if (EMPTY_MARK_RE.test(e?.message ?? "")) return null;
    throw e;
  }
}

// A score line as a SCORE_WIDTH-wide rectangle, butt-capped at both ends (CCW).
function lineGroove(k, [a, b]) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = (-(b[1] - a[1]) / len) * (SCORE_WIDTH / 2), ny = ((b[0] - a[0]) / len) * (SCORE_WIDTH / 2);
  return k.shape2d([[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]]);
}

// A closed score shape: every boundary grooved, SCORE_WIDTH wide, centred on it. A
// shape too small to keep an inside collapses under the inward offset; it is then
// scored solid (the outward offset alone).
function shapeGroove(shape) {
  const outer = shape.offset(SCORE_WIDTH / 2);
  return orEmpty(() => outer.cut(shape.offset(-SCORE_WIDTH / 2))) ?? outer;
}

// → ResolvedSheet: { process, material, thickness, group, label, pose, profile,
//   score: { lines, shapes }, engrave, grooves, customBuild }. Throws a
//   `sheet part "<label>": …` error for a field that resolves to something unusable.
export function resolveSheet(k, sp, p, d) {
  const s = sp.sheet;
  const thickness = typeof s.thickness === "function" ? s.thickness(p, d) : s.thickness;
  if (!isNum(thickness) || thickness <= 0) throw fail(sp, `thickness must be a finite number > 0 (mm), got ${thickness}`);
  const material = typeof s.material === "function" ? s.material(p, d) : s.material;
  if (typeof material !== "string" || material.trim() === "") throw fail(sp, `material must be a non-empty string, got ${JSON.stringify(material)}`);

  let pose = null;
  if (s.pose !== null) {
    pose = typeof s.pose === "function" ? s.pose(p, d) : s.pose;
    if (pose !== null) {
      const reason = validatePose(pose);
      if (reason) throw fail(sp, reason);
    }
  }

  const drawn = s.profile(k, p, d);
  if (drawn === null || drawn === undefined) throw fail(sp, "profile(k, p, d) returned nothing — return a Shape2D or profile");
  const profile = k.shape2d(drawn);

  const lines = [], shapes = [];
  if (s.score) {
    const entries = s.score(k, p, d);
    if (entries !== null && entries !== undefined) {
      if (!Array.isArray(entries)) throw fail(sp, "score(k, p, d) must return an array of lines [[x, y], [x, y]] and shapes");
      for (const entry of entries) {
        if (entry === null || entry === undefined) continue;          // a mark switched off
        if (!isLine(entry)) { shapes.push(k.shape2d(entry)); continue; } // a point list is a polygon
        const [a, b] = entry;
        // A zero-length line marks nothing. Dropped HERE, not just from the grooves, so
        // the preview and the cut file (which draws score.lines) always agree.
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) lines.push([[a[0], a[1]], [b[0], b[1]]]);
      }
    }
  }
  const engraved = s.engrave ? s.engrave(k, p, d) : null;
  const engrave = engraved === null || engraved === undefined ? null : k.shape2d(engraved);

  const grooves = [
    ...lines.map((ln) => lineGroove(k, ln)),
    ...shapes.map(shapeGroove),
  ];

  return {
    process: s.process, material, thickness, group: sheetGroup(material, thickness),
    label: sp.label ?? null, pose, profile, score: { lines, shapes }, engrave, grooves,
    customBuild: sp.build !== s.generatedBuild,
  };
}

// The default preview: the profile extruded to the thickness, the engrave pocketed and
// each groove cut MARK_DEPTH deep. Each mark tool spans z = t − MARK_DEPTH to
// t + MARK_OVERCUT, so its top face is never coplanar with the laser face; the removed
// volume is still MARK_DEPTH × area(marks ∩ profile).
export function sheetPreview(k, s) {
  const t = s.thickness;
  const body = s.profile.extrude({ h: t });
  const tools = [s.engrave, ...s.grooves]
    .filter(Boolean)
    .map((mark) => orEmpty(() => mark.extrude({ h: MARK_DEPTH + MARK_OVERCUT }).translate([0, 0, t - MARK_DEPTH])))
    .filter(Boolean);
  return tools.length ? body.cutAll(tools) : body;
}

// Carry a canonical solid (z ∈ [0, t]) to its pose — translate and rotate only, so
// display and export differ by nothing and the probe keeps trusting the pose. A null
// pose is no transform.
export function applyPose(solid, pose, t) {
  if (pose === null) return solid;
  return poseSteps(pose, t).reduce(
    (s, st) => (st.t === "translate" ? s.translate(st.v) : s.rotate(st.deg, st.center, st.axis)),
    solid,
  );
}

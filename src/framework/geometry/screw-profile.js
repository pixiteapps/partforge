import { segsForSagitta } from "./circle-segs.js";

// Screw motion as a transverse cross-section. A profile point (r, z) in the axial
// half-plane travels to (r·cos θ, r·sin θ, z + pitch·θ/2π) under screw motion, and
// that whole solid is reproduced EXACTLY by extruding a polar-remapped section with
// twist = 360°·turns — one full turn of twist per pitch of height. So screwSweep
// needs no backend op: it is k.extrude in disguise (see kernel-front.js).
//
// The subtlety that makes this correct rather than nearly-correct: the map sends
// profile POINTS to polar, but the EDGES between them become straight chords where
// the true surface needs spiral arcs. Undensified, an ISO tooth loses ~42% of its
// volume. So every segment is subdivided to one polar step, sized from the profile
// alone (screwStepsPerTurn below) — never from the quality tier or the backend — so
// both backends see the identical polygon and the solid cache keys stay stable. "Every segment" includes the contour's implicit closing
// edge, except in the periodic case where that edge is a single polar point.

// How finely the screw motion is sampled. One count drives BOTH directions: the
// polar step every profile segment is densified at here, and the twist divisions
// Manifold's extrude takes per turn (kernel-front.js passes it as
// `_twistDivisions`), so the angular and axial sampling of the same solid agree.
//
// It used to be a flat 5° — 72 steps a turn — whatever the thread's size. Spent on
// a 1.5 mm-radius M3 thread that is a chord sagitta of 0.0014 mm, a hundredth of
// any printer's resolution, and because a thread's triangle count is QUADRATIC in
// the step (it is the cross-section's point count times the twist divisions), it
// was paid squared: eleven 50–80-turn M3 screws came to 7.7 M triangles, which is
// what feedback #244's 3MF export could not write.
//
// So the step is sized by chord tolerance at the profile's largest radius — the
// same 0.01 mm the print tier holds every circle to (circle-segs.js), through the
// same `segsForSagitta` formula — and clamped:
//
// - CAP at the old 72 a turn. A thread large enough to need more keeps exactly the
//   density it always had; nothing gets finer than before. From about r = 10.5 mm
//   up a thread is unchanged (an M20's 10 mm radius is 71).
// - FLOOR at SCREW_MIN_STEPS a turn (24, 15° facets), so a tiny thread never
//   reads as a polygon under close zoom.
//
// It is the same count on both quality tiers and both backends, on purpose: a
// thread previews exactly as it exports, OCCT's B-rep (which twists natively and
// reads only the cross-section) matches Manifold's mesh, and the solid cache key
// is a function of the profile alone. Measured on ISO metric threads: an M3
// is 28 steps a turn (6.5× fewer triangles), an M6 39 (3.3×), an M2 the floor 24
// (8.7×). The chords sit inside the exact surface, so the solid reads up to 0.01 mm
// small at the crest — 0.8% of an M3 rod's volume, 0.4% of an M6's — which is
// what the print tier's circles already do and a tenth of any printer's resolution.
export const SCREW_SAGITTA_TOL = 0.01; // mm — circle-segs.js SAGITTA_TOL.print
export const SCREW_MIN_STEPS = 24;
export const SCREW_MAX_STEPS = 72; // the old flat 5°

// Steps per full turn for an axial [[r, z]] profile. Never throws: a profile with
// no finite positive radius takes the floor, and screwCrossSection reports what is
// actually wrong with it.
export function screwStepsPerTurn(profile) {
  let maxR = 0;
  if (Array.isArray(profile))
    for (const p of profile) if (Array.isArray(p) && Number.isFinite(p[0]) && p[0] > maxR) maxR = p[0];
  return segsForSagitta(maxR, SCREW_SAGITTA_TOL, SCREW_MIN_STEPS, SCREW_MAX_STEPS);
}

const EPS = 1e-9;

export function screwCrossSection(profile, pitch, { lefthand = false, stepsPerTurn = screwStepsPerTurn(profile) } = {}) {
  const stepDeg = 360 / stepsPerTurn;
  if (!Array.isArray(profile) || profile.length < 2)
    throw new Error("screwSweep: profile must be an array of at least 2 [r, z] points");
  if (!(pitch > 0)) throw new Error("screwSweep: pitch must be > 0");
  for (const p of profile) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new Error("screwSweep: every profile point must be a finite [r, z]");
    if (p[0] < 0) throw new Error("screwSweep: profile radius must be ≥ 0");
  }

  const zs = profile.map(([, z]) => z);
  const extent = Math.max(...zs) - Math.min(...zs);
  if (extent > pitch + EPS)
    throw new Error(
      `screwSweep: profile axial extent ${extent} exceeds pitch ${pitch} — consecutive ` +
      "turns would interpenetrate; reduce the profile height or increase pitch");

  const n = profile.length;
  const first = profile[0], last = profile[n - 1];
  const periodic = extent > pitch - EPS;

  // Subdivide by POLAR span, not by length: a segment with no z change sweeps no
  // angle and needs no extra points.
  const dense = [];
  const densify = ([r0, z0], [r1, z1], { includeStart }) => {
    const span = Math.abs((360 * (z1 - z0)) / pitch);
    const steps = Math.max(1, Math.ceil(span / stepDeg - 1e-9));
    for (let j = includeStart ? 0 : 1; j < steps; j++)
      dense.push([r0 + ((r1 - r0) * j) / steps, z0 + ((z1 - z0) * j) / steps]);
  };
  for (let i = 0; i < n - 1; i++) densify(profile[i], profile[i + 1], { includeStart: true });
  dense.push(last);

  // A profile spanning exactly one pitch closes on itself by periodicity: its last
  // point maps to the same polar angle as its first, so it must agree in radius and
  // the duplicate is dropped (a zero-length edge would otherwise reach the backend).
  // Nothing is densified between them — they ARE the same polar point, and a
  // densified edge would trace a spurious full circle back around the axis.
  if (periodic) {
    if (Math.abs(last[1] - first[1]) < pitch - EPS)
      throw new Error(
        `screwSweep: a full-pitch profile must start and end at its extreme z values — ` +
        `the first and last points span ${Math.abs(last[1] - first[1])}, not the full ` +
        `pitch ${pitch}; reorder the profile so it opens and closes on the wrap`);
    if (Math.abs(first[0] - last[0]) > 1e-6)
      throw new Error(
        `screwSweep: a full-pitch profile must be periodic — first radius ${first[0]} ` +
        `must equal last radius ${last[0]}`);
    dense.pop();
  } else {
    // Sub-pitch: the contour's implicit closing edge (last → first) is a real edge
    // spanning real polar angle, so it needs the same treatment as every other one.
    // Undensified it is a straight chord across the unused part of the pitch, which
    // turns a slim ridge into a twisted half-disc. `first` already opens the
    // contour, so only the intermediate points are appended.
    densify(last, first, { includeStart: false });
  }

  const sign = lefthand ? 1 : -1;
  return dense.map(([r, z]) => {
    const psi = (sign * 2 * Math.PI * z) / pitch;
    const x = r * Math.cos(psi);
    let y = r * Math.sin(psi);
    if (y === 0) y = 0; // Normalize -0 to 0
    return [x, y];
  });
}

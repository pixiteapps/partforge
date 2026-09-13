// Reusable design-for-manufacturing process profiles — a manufacturing technique
// as DATA: which checks apply and at what thresholds. `bed` is the build volume
// [x,y,z] in mm (a hard bbox-fit gate); `minWall` mm (a warn); `overhang` is the
// steepest unsupported face the process prints cleanly, in degrees from vertical
// (a warn, armed only by the part — see overhangAngleFor; resin prints on
// supports, so it carries none); `clearance` mm is carried for a future gap check
// (not enforced yet).
export const PROFILES = {
  "fdm-pla": { bed: [220, 220, 250], minWall: 1.2, clearance: 0.2, overhang: 45 },
  "fdm-petg": { bed: [220, 220, 250], minWall: 1.5, clearance: 0.3, overhang: 45 },
  "resin": { bed: [120, 68, 160], minWall: 0.6, clearance: 0.1 },
};

export function resolveProfile(spec) {
  if (typeof spec === "string") {
    if (!(spec in PROFILES)) {
      throw new Error(`unknown process profile: "${spec}" (known: ${Object.keys(PROFILES).join(", ")})`);
    }
    return { ...PROFILES[spec] };
  }
  if (spec && typeof spec === "object") {
    const base = spec.base ? resolveProfile(spec.base) : {};
    const { base: _drop, ...overrides } = spec;
    return { ...base, ...overrides };
  }
  throw new Error(`invalid process profile: ${JSON.stringify(spec)}`);
}

// The one legal `verify.orientation` value today. Z is up everywhere in partforge
// and the bed is a sub-part's own lowest Z, so "print" is a declaration, not a
// choice of axis.
export const ORIENTATIONS = ["print"];

// The angle an author's own `overhangArea` expectation is measured against when
// the profile names none (a resin part, or no profile at all): FDM's usual 45.
export const DEFAULT_OVERHANG_ANGLE = 45;

// Which overhang angle a part is checked against, or null when it is not checked.
// Two ways in, both explicit — a profile alone never arms it, because the cloud
// agent writes `process: "fdm-pla"` by habit and a part still being shaped should
// not be nagged about its underside:
//   - `verify.orientation: "print"` (the part is laid out for its bed) under a
//     profile carrying `overhang`; a profile without one (resin) checks nothing;
//   - an `overhangArea` expectation the author wrote themselves, in any case's
//     `expect` (`expanded`, from gates.js's expandExpectations) — measured against
//     the profile's angle, or DEFAULT_OVERHANG_ANGLE when the profile has none,
//     so a declared expectation is never answered "unavailable".
// Throws on an orientation value outside ORIENTATIONS — verify's callers want that
// loud, like an unknown profile name, and lint's `verify-unknown-orientation`
// catches it before a kernel boots; gates.js wraps this total for measure().
export function overhangAngleFor(part, process, { expanded = [] } = {}) {
  const orientation = part?.verify?.orientation;
  if (orientation != null && !ORIENTATIONS.includes(orientation)) {
    throw new Error(`unknown verify.orientation: ${JSON.stringify(orientation)} (known: ${ORIENTATIONS.join(", ")})`);
  }
  const spec = process ?? part?.verify?.process;
  const fromProfile = spec ? resolveProfile(spec).overhang : undefined;
  const angle = typeof fromProfile === "number" && Number.isFinite(fromProfile) ? fromProfile : null;
  if (orientation === "print" && angle != null) return angle;
  const asserted = expanded.some(({ expect }) =>
    Object.entries(expect ?? {}).some(([name, o]) => name !== "_view" && o && typeof o === "object" && "overhangArea" in o));
  return asserted ? (angle ?? DEFAULT_OVERHANG_ANGLE) : null;
}

// Reusable design-for-manufacturing process profiles — a manufacturing technique
// as DATA: which checks apply and at what thresholds. `bed` is the build volume
// [x,y,z] in mm (a hard bbox-fit gate); `minWall` mm (a warn); `overhang` is the
// steepest unsupported face the process prints cleanly, in degrees from vertical
// (a warn, armed only by the part — see overhangAngleFor; resin prints on
// supports, so it carries none); `bedContact` is the least share (%) of a printed
// piece's near-bed flat underside that must rest on the bed (a GATE, armed by the
// profile alone — see bedContactFor; resin prints on supports, so it carries none);
// `clearance` mm is carried for a future gap check (not enforced yet).
//
// `fits`, `holeUndersize` and `bridge` are the numbers an author (or the cloud
// agent) copies into derive() for a mating feature; nothing in this repo reads
// them yet. They are guide defaults from the FDM design guides, not measurements:
// a calibrated printer overrides them through an inline `{ base, fits: {...} }`
// profile, which REPLACES the fits table whole. `fits` are diametral offsets in
// mm (negative = interference): press (a pin that never comes out), push (a cap
// pressed on by hand), slip (a lid that lifts off), moving (a hinge pin or axle),
// printInPlace (parts printed already assembled). `holeUndersize` is added to a
// horizontal bore's diameter, since the top of a printed arch sags inward.
// `bridge` is the longest flat span the process prints unsupported; resin prints
// on supports, so it carries none.
export const PROFILES = {
  "fdm-pla": {
    bed: [220, 220, 250], minWall: 1.2, clearance: 0.2, overhang: 45, bedContact: 50,
    fits: { press: -0.1, push: 0.05, slip: 0.25, moving: 0.35, printInPlace: 0.45 },
    holeUndersize: 0.25, bridge: 10,
  },
  "fdm-petg": {
    bed: [220, 220, 250], minWall: 1.5, clearance: 0.3, overhang: 45, bedContact: 50,
    fits: { press: -0.1, push: 0.05, slip: 0.3, moving: 0.4, printInPlace: 0.5 },
    holeUndersize: 0.3, bridge: 10,
  },
  "resin": {
    bed: [120, 68, 160], minWall: 0.6, clearance: 0.1,
    fits: { press: -0.05, push: 0.05, slip: 0.1, moving: 0.15, printInPlace: 0.2 },
    holeUndersize: 0.05,
  },
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

// The `bedContactPct` floor an author's own expectation or `orientation: "print"` arms
// the measurement against when the profile names none.
export const DEFAULT_BED_CONTACT = 50;

// The least share of a printed piece's near-bed flat underside that must touch the bed
// (oracle/bed-contact.js), or null when it is not checked. Unlike overhangAngleFor, the
// PROFILE ALONE arms it: an overhang is a design choice a part still being shaped may
// not have made yet, but a flat underside hovering a fraction of a millimetre above the
// piece's lowest point is a defect in whatever orientation the piece is exported —
// every exporter and slicer lays it on that lowest point — so a part carrying an FDM
// profile is checked from its first build. Three ways in:
//   - a profile carrying `bedContact` (the FDM profiles; resin carries none);
//   - `verify.orientation: "print"` under a profile without one, or with no profile;
//   - a `bedContactPct` expectation the author wrote themselves, in any case's `expect`.
// Throws on an orientation value outside ORIENTATIONS, as overhangAngleFor does.
export function bedContactFor(part, process, { expanded = [] } = {}) {
  const orientation = part?.verify?.orientation;
  if (orientation != null && !ORIENTATIONS.includes(orientation)) {
    throw new Error(`unknown verify.orientation: ${JSON.stringify(orientation)} (known: ${ORIENTATIONS.join(", ")})`);
  }
  const spec = process ?? part?.verify?.process;
  const fromProfile = spec ? resolveProfile(spec).bedContact : undefined;
  if (typeof fromProfile === "number" && Number.isFinite(fromProfile)) return fromProfile;
  if (orientation === "print") return DEFAULT_BED_CONTACT;
  const asserted = expanded.some(({ expect }) =>
    Object.entries(expect ?? {}).some(([name, o]) => name !== "_view" && o && typeof o === "object" && "bedContactPct" in o));
  return asserted ? DEFAULT_BED_CONTACT : null;
}

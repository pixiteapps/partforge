// The profiles live on the print process descriptors (process/fdm, process/resin);
// PROFILES is the registry's merged map, re-exported so every import keeps working.
import { PRINT_PROFILES as PROFILES } from "../process/registry.js";
export { PROFILES };

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
//   - `verify.orientation: "print"` with NO profile. A named profile decides alone:
//     resin prints on supports, so orientation must not arm it there (overhangAngleFor's
//     rule), and `{ base: "fdm-pla", bedContact: null }` must stay off;
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
  if (orientation === "print" && !spec) return DEFAULT_BED_CONTACT;
  const asserted = expanded.some(({ expect }) =>
    Object.entries(expect ?? {}).some(([name, o]) => name !== "_view" && o && typeof o === "object" && "bedContactPct" in o));
  return asserted ? DEFAULT_BED_CONTACT : null;
}

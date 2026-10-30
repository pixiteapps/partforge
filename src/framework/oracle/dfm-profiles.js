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
// Two ways in:
//   - the print process alone: a profile carrying `overhang` arms it (a profile
//     without one, resin, checks nothing). The reading is a COST, not a warning, so a
//     part still being shaped is told what supports would cost, never nagged;
//     `verify.orientation` no longer takes part in the decision;
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
  if (angle != null) return angle;
  const asserted = expanded.some(({ expect }) =>
    Object.entries(expect ?? {}).some(([name, o]) => name !== "_view" && o && typeof o === "object" && "overhangArea" in o));
  return asserted ? DEFAULT_OVERHANG_ANGLE : null;
}

// The `bedContactPct` floor an author's own expectation or `orientation: "print"` arms
// the measurement against when the profile names none.
export const DEFAULT_BED_CONTACT = 50;

// The least share of a printed piece's near-bed flat underside that must touch the bed
// (oracle/bed-contact.js), or null when it is not checked. Like overhangAngleFor the
// PROFILE ALONE arms it, but as a GATE, not a cost: a flat underside hovering a fraction
// of a millimetre above the piece's lowest point is a defect in whatever orientation the
// piece is exported — every exporter and slicer lays it on that lowest point — so a part
// carrying an FDM profile is checked from its first build. Three ways in:
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

// The `footprintPct` floor an author's own expectation arms the measurement against
// when the profile names none (a resin part, or no profile at all).
export const DEFAULT_FOOTPRINT = 10;

// The least share of a printed piece's silhouette on the bed that must actually touch
// it (the footprint, read by bed contact's pass — measure.js `footprintPct`), or null when it
// is not checked. A COST, like overhang: a piece standing on a point, a line or a curl
// prints with a brim or a raft, which the user may well choose. Two ways in:
//   - a profile carrying `footprint` (the FDM profiles; resin carries none, since it
//     prints on supports), and `{ base: "fdm-pla", footprint: null }` stays off;
//   - a `footprintPct` expectation the author wrote themselves, in any case's `expect`.
// `verify.orientation` takes no part (overhangAngleFor's rule), but an invalid value
// still throws, as it does there.
export function footprintFor(part, process, { expanded = [] } = {}) {
  const orientation = part?.verify?.orientation;
  if (orientation != null && !ORIENTATIONS.includes(orientation)) {
    throw new Error(`unknown verify.orientation: ${JSON.stringify(orientation)} (known: ${ORIENTATIONS.join(", ")})`);
  }
  const spec = process ?? part?.verify?.process;
  const fromProfile = spec ? resolveProfile(spec).footprint : undefined;
  if (typeof fromProfile === "number" && Number.isFinite(fromProfile)) return fromProfile;
  const asserted = expanded.some(({ expect }) =>
    Object.entries(expect ?? {}).some(([name, o]) => name !== "_view" && o && typeof o === "object" && "footprintPct" in o));
  return asserted ? DEFAULT_FOOTPRINT : null;
}

// ── flexing members (`verify.flex`, oracle/flex-root.js) ─────────────────────
// The root fillet a flexing member needs, as a share of its thickness; the strain its
// material takes at the root for a one-time snap, in percent; the steepest its long
// axis may rise off the bed, in degrees. Guide defaults for a part that names no
// profile — the root rule and the strain rule hold in any material.
export const DEFAULT_ROOT_FILLET = 0.5;
export const DEFAULT_STRAIN = 1.5;
export const DEFAULT_FLEX_TILT = 45;

const orientationOk = (part) => {
  const orientation = part?.verify?.orientation;
  if (orientation != null && !ORIENTATIONS.includes(orientation)) {
    throw new Error(`unknown verify.orientation: ${JSON.stringify(orientation)} (known: ${ORIENTATIONS.join(", ")})`);
  }
};
const asserts = (expanded, metric) => expanded.some(({ expect }) =>
  Object.entries(expect ?? {}).some(([name, o]) => name !== "_view" && o && typeof o === "object" && metric in o));

// The least root fillet, as a share of the member's thickness, a declared flexing
// member is held to (a GATE), or null when switched off. Armed by `verify.flex` alone —
// no profile needed, the rule holds in any material — so with no profile it is the
// default; the profile's `rootFillet` sets it, `{ base, rootFillet: null }` switches it off.
export function rootFilletFor(part, process) {
  orientationOk(part);
  const spec = process ?? part?.verify?.process;
  const v = spec ? resolveProfile(spec).rootFillet : undefined;
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_ROOT_FILLET;
}

// The largest root strain, in percent, a flexing member may see at its declared
// deflection (an advisory), or null when switched off. Read for a member that declares
// a `deflection`, or where the author asserts `flexStrain`; the profile's `strain` sets
// the limit, the default stands in with no profile, `{ base, strain: null }` switches it off.
export function strainFor(part, process) {
  orientationOk(part);
  const spec = process ?? part?.verify?.process;
  const v = spec ? resolveProfile(spec).strain : undefined;
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_STRAIN;
}

// The steepest a flexing member's long axis may rise off the bed, in degrees, before
// its layers stack across the root (a COST, `standing`), or null when not checked. Like
// overhangAngleFor: the PROFILE alone arms it (the FDM profiles carry `flexTilt`; resin
// is isotropic and carries none), or an authored `flexTilt` expectation, read against
// the default when the profile has none.
export function flexTiltFor(part, process, { expanded = [] } = {}) {
  orientationOk(part);
  const spec = process ?? part?.verify?.process;
  const v = spec ? resolveProfile(spec).flexTilt : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return asserts(expanded, "flexTilt") ? DEFAULT_FLEX_TILT : null;
}

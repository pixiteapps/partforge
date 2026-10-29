// Metric registry: name → how to pull the value out of facts, whether a failure
// is a hard gate or a warning, and the diagnostics attached to a non-pass check:
// `hint` (required — the report contract promises one on every fail/warn),
// `pattern` (optional stable ERROR-PATTERNS.md#<id>), `locate` (optional
// [x,y,z] source), `note` (optional caveat about HOW the value was measured,
// attached whatever the status — a passing-but-sampled reading is exactly the
// case a reader needs told about). `manifoldOnly` facts are null on OCCT parts.
//
// This lives one level above framework/oracle/ deliberately: the set of legal
// `verify.expect` metrics is part of the PartDefinition CONTRACT, which both the
// verify runner (oracle/verify.js) and the linter (partforge/lint) must agree on.
// Keeping it here lets the linter import the vocabulary without reaching
// measure.js, which pulls in the geometry kernels. Its one import is the process
// registry, whose closure is import-free in turn (the process descriptors,
// sheet/constants.js, lint/finding.js) — so the linter's stays kernel-free.
import { PROCESSES } from "./process/registry.js";
import { DOMAINS } from "./domains/registry.js";

// `bounds` is written the way measure() reports it — `bounds: { min: [x,y,z], max:
// [x,y,z] }` — so a reader who copies the shape of a measurement gets a legal
// expectation: `bounds: { min: ">=[0,0,0]", max: "<=[220,220,250]" }`. It is the one
// COMPOUND metric: its value is an object of `sides`, each an ordinary vector
// expectation checked on its own and reported as `bounds.min` / `bounds.max`. Either
// side may be left out; nothing else may sit under it (boundsSpecError).
export const BOUNDS_FORM = 'bounds: { min: ">=[x,y,z]", max: "<=[x,y,z]" }';
const BOUNDS_HINT = `write ${BOUNDS_FORM} — either side may be left out, and * skips an axis`;

function boundsMetric(bounds, minHint, maxHint) {
  return { kind: "gate", hint: BOUNDS_HINT, sides: {
    min: { kind: "gate", form: "vector", extract: (f) => bounds(f)?.min, hint: minHint },
    max: { kind: "gate", form: "vector", extract: (f) => bounds(f)?.max, hint: maxHint },
  } };
}

// The flat spellings `bounds` replaced. Still evaluated, so a part written against
// them keeps verifying, but `legacy` keeps them out of everything that TEACHES the
// vocabulary: lint's list of valid metrics and its did-you-mean (teachableMetrics).
function legacyBounds(bounds, minHint, maxHint) {
  return {
    boundsMin: { kind: "gate", form: "vector", legacy: "bounds", extract: (f) => bounds(f)?.min, hint: minHint },
    boundsMax: { kind: "gate", form: "vector", legacy: "bounds", extract: (f) => bounds(f)?.max, hint: maxHint },
  };
}

// The metric names a reader should be shown: every registry key but the legacy ones.
export const teachableMetrics = (registry) => Object.keys(registry).filter((k) => !registry[k].legacy);

// Why a compound metric's value is malformed, or null when it is well formed. verify
// throws with it and lint reports it, so both say the same thing.
export function sidesSpecError(metric, reg, spec) {
  const sides = Object.keys(reg.sides);
  const form = metric === "bounds" ? BOUNDS_FORM : `${metric}: { ${sides.join(", ")} }`;
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    let shown;
    try { shown = JSON.stringify(spec); } catch { shown = String(spec); }
    return `${metric} takes an object { ${sides.join(", ")} }, got ${shown} — write ${form}`;
  }
  const keys = Object.keys(spec);
  const unknown = keys.filter((k) => !sides.includes(k));
  if (unknown.length) {
    return `${metric} accepts only ${sides.map((k) => `"${k}"`).join(" and ")}, got ${unknown.map((k) => `"${k}"`).join(", ")} — write ${form}`;
  }
  if (!keys.length) return `${metric} needs at least one of ${sides.join(" or ")} — write ${form}`;
  return null;
}

// Every registered domain's oracle.metrics joined to the core and sheet vocabulary.
// A name already present is a LOAD error naming both sides — a silent overwrite would
// change what an authored expectation measures, and nothing downstream would notice.
function mergeMetrics(out, metrics, owner) {
  for (const [name, metric] of Object.entries(metrics)) {
    if (Object.hasOwn(out, name)) {
      throw new Error(`verify-metrics: ${owner} metric "${name}" collides with an existing sub-part metric of that name`);
    }
    out[name] = metric;
  }
  return out;
}
function withDomainMetrics(base) {
  const out = { ...base };
  // Sheet parts (sheetPart(), partforge/geometry): each process's own checks. verify
  // volunteers them on every sheet sub-part; an author may declare them like any other.
  // The processes may come from a domain, so they go through the same guard.
  for (const proc of PROCESSES) mergeMetrics(out, proc.metrics, `process "${proc.id}"`);
  for (const d of DOMAINS) mergeMetrics(out, d.oracle.metrics, `domain "${d.id}"`);
  return out;
}

export const SUBPART_METRICS = withDomainMetrics({
  holes: { kind: "gate", manifoldOnly: true, extract: (s) => s.holes,
    hint: "genus is wrong — an unintended tunnel exists or an intended bore is blocked; make cut tools pierce fully (overcut past the faces)" },
  watertight: { kind: "gate", manifoldOnly: true, extract: (s) => s.watertight,
    hint: "a boolean produced an open shell — check for coplanar faces or a cut that exactly grazes a surface",
    pattern: "boolean-not-watertight" },
  volume: { kind: "gate", extract: (s) => s.volume,
    hint: "solid volume is out of range — a feature is missing, doubled, or a governing parameter is mis-scaled" },
  surfaceArea: { kind: "gate", extract: (s) => s.surfaceArea,
    hint: "surface area is out of range — detail features (facets, ribs, textures) are missing or doubled" },
  triangleCount: { kind: "gate", extract: (s) => s.triangleCount,
    hint: "triangle count is out of range — tessellation quality or feature count changed unexpectedly" },
  bbox: { kind: "gate", form: "vector", extract: (s) => s.bbox,
    hint: "bounding box is out of range — check the governing dimensions and the part's orientation" },
  centerOfMass: { kind: "gate", form: "vector", extract: (s) => s.centerOfMass,
    hint: "center of mass is outside the expected region — mass is distributed differently than intended; check feature placement or a mis-scaled sub-part" },
  bounds: boundsMetric((s) => s.bounds,
    "the low corner is out of range — the part is positioned or oriented differently than expected",
    "the high corner is out of range — the part is positioned or oriented differently than expected"),
  ...legacyBounds((s) => s.bounds,
    "the low corner is out of range — the part is positioned or oriented differently than expected",
    "the high corner is out of range — the part is positioned or oriented differently than expected"),
  minWall: { kind: "warn", extract: (s) => s.minWall,
    hint: "thinnest wall is at the reported location — increase the governing wall/thickness parameter or reduce the intersecting feature's depth",
    pattern: "minwall-sliver-triangles",
    locate: (s) => s.minWallAt,
    // Two sampled outcomes, and the second is the one that most needs saying: a
    // sampled run that found NO wall reports minWall null, which without this note
    // is indistinguishable from a part nobody measured. `sampled` counts triangles
    // the walk selected, not rays cast — degenerate triangles are skipped.
    note: (s) => {
      if (!s.minWallSampled || !s.minWallSamples) return null;
      const { sampled, total } = s.minWallSamples;
      return s.minWall == null
        ? `no reading from the ${sampled} of ${total} triangles sampled — not a clean bill of health; a thin spot may exist between samples`
        : `sampled ${sampled} of ${total} triangles — an upper bound; a thinner spot may exist between samples`;
    } },
  // Unsupported downward-facing area (oracle/overhang.js), in mm². Measured for a
  // part whose print process carries an `overhang` angle (the process alone arms it)
  // or that asserts it; elsewhere `extract` returns null and check() skips it.
  // A cost, never a gate or a warning: needing supports is a design choice with a
  // price (a bridge reads as a ceiling and cannot be told apart), so it is listed
  // under `costs` and the user may accept it (`verify.accept: ["supports"]`).
  overhangArea: { kind: "cost", costId: "supports", extract: (s) => s.overhangArea,
    hint: "unsupported downward-facing surface at the reported location — reorient the part so the face is vertical or on the bed, chamfer it to the process's overhang angle, split it into a bridged or supported feature; when the user chooses supports instead, record it with verify.accept: [\"supports\"]",
    locate: (s) => s.overhangAt,
    note: (s) => (s.overhangAngle != null ? `steepest unsupported face ${s.overhangAngle.toFixed(1)}° from vertical` : null) },
  // How much of a printed piece's near-bed flat underside rests on the bed
  // (oracle/bed-contact.js), in percent. Measured for a part whose FDM profile carries
  // `bedContact` (or, with no profile, `orientation: "print"`; or this expectation itself);
  // elsewhere `extract` returns null and check() skips it. A GATE, unlike overhangArea:
  // a flat bottom hovering above a lower knuckle or emboss is a failed print in any
  // orientation, and a flat face cannot be mistaken for anything else.
  bedContactPct: { kind: "gate", extract: (s) => s.bedContactPct,
    hint: "this piece's flat underside sits just above the bed, because something lower (a knuckle, a pin, a boss, or lettering on the bottom) touches first — exporters and slicers rest the piece on that lowest point, so the flat face prints in mid-air. Trim the piece flat at the bed plane (cut everything below z = 0 in its print pose), or raise or shorten the lower feature so the flat face is the lowest; a recess meant to clear the bed can declare a lower bedContactPct",
    pattern: "piece-hovers-above-bed",
    locate: (s) => s.bedHoverAt,
    note: (s) => (s.bedHoverGap != null
      ? `${s.bedHoverArea.toFixed(1)} mm² of flat underside sits ${s.bedHoverGap.toFixed(2)} mm above the bed; ${s.bedContactArea.toFixed(1)} mm² touches it`
      : null) },
  // The footprint (measure.js, from bed contact's pass): the flat contact area over the
  // piece's silhouette on the bed, in percent. Measured where bed contact is, plus where the
  // profile carries `footprint` or the author declares it. A COST, like overhangArea: a
  // piece on a point or a line prints with a brim or a raft, which the user may choose
  // (`accept: ["footprint"]`); bedContactPct passes such a piece, since nothing hovers.
  footprintPct: { kind: "cost", costId: "footprint", extract: (s) => s.footprintPct,
    hint: "the share of this piece's silhouette on the bed (its outline in the print pose) that actually touches it is small — it stands on a point, a line or a curve, which reads near zero, so the first layer has almost nothing to hold on to and the piece can tip or pull loose. Lay it on its flat face, add a flat foot or pad at its lowest point, or print it with a brim (accept: [\"footprint\"] records that choice)",
    pattern: "piece-stands-on-nothing",
    locate: (s) => s.footprintAt },
  // `s.deviation` (measure.js) exists only for a sub-part declaring `reference:
  // "<import name>"`; on every other sub-part `extract` returns null, which
  // `check()` already reports as status "skip" rather than a fail — the
  // no-reference path needs nothing here.
  // The declared wall band's worst member (min-wall.js `band`): the member thickness
  // farthest from the range the part declared, located. Range form only — `form` is
  // read by the linter's verify-bad-expr rule only. A warning like minWall,
  // because it is a sampled ray reading: a sample can miss the widest spot, never
  // invent one. `unavailable` is the skip message when no ray fell in the window.
  wall: { kind: "warn", form: "range", extract: (s) => s.wall?.value ?? null,
    hint: "wall thickness drifts from the declared band at the reported location — a fillet radius, an offset or a boolean tool there is not tracking the wall",
    locate: (s) => s.wall?.location ?? null,
    unavailable: "no wall in band",
    note: (s) => {
      if (!s.wall) return null;
      const sampled = s.minWallSampled && s.minWallSamples ? ` (sampled ${s.minWallSamples.sampled} of ${s.minWallSamples.total} triangles)` : "";
      return `${s.wall.members} rays read as this wall${sampled}`;
    } },
  refXorVolume: { kind: "gate", extract: (s) => s.deviation?.xorVolume ?? null,
    hint: "the rebuild's symmetric difference vs its reference import is too large — compare the ghost overlay, then adjust the governing dimensions toward the measured reference" },
  refVolumeDeltaPct: { kind: "gate", extract: (s) => s.deviation?.volumeDeltaPct ?? null,
    hint: "rebuild volume differs from the reference import by more than the allowed percentage — a feature is missing, doubled, or mis-scaled vs the reference" },
  refBboxDelta: { kind: "gate", form: "vector", extract: (s) => s.deviation?.bboxDelta ?? null,
    hint: "the rebuild's bounding-box corners drift from the reference import — check overall dimensions and that the rebuild is aligned to the reference's coordinates" },
});
export const VIEW_METRICS = {
  bbox: { kind: "gate", form: "vector", extract: (r) => r.aggregate.bbox,
    hint: "the assembled view exceeds its size limit — shrink the assembly or pick a process with a larger bed" },
  volume: { kind: "gate", extract: (r) => r.aggregate.volume,
    hint: "total assembly volume is out of range — a sub-part is missing, doubled, or mis-scaled" },
  overlaps: { kind: "gate", extract: (r) => r.overlaps.length,
    hint: "sub-parts interpenetrate near the reported location — adjust placement or add clearance in derive()",
    locate: (r) => r.overlaps[0]?.location ?? null },
  centerOfMass: { kind: "gate", form: "vector", extract: (r) => r.aggregate.centerOfMass,
    hint: "the assembly's center of mass is outside the expected region — a sub-part is mis-placed or mis-scaled" },
  bounds: boundsMetric((r) => r.aggregate.bounds,
    "the assembly's low corner is out of range — check placement or orientation",
    "the assembly's high corner is out of range — check placement or orientation"),
  ...legacyBounds((r) => r.aggregate.bounds,
    "the assembly's low corner is out of range — check placement or orientation",
    "the assembly's high corner is out of range — check placement or orientation"),
};

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
// measure.js, which pulls in the geometry kernels. Must stay import-free.
export const SUBPART_METRICS = {
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
  bbox: { kind: "gate", extract: (s) => s.bbox,
    hint: "bounding box is out of range — check the governing dimensions and the part's orientation" },
  centerOfMass: { kind: "gate", extract: (s) => s.centerOfMass,
    hint: "center of mass is outside the expected region — mass is distributed differently than intended; check feature placement or a mis-scaled sub-part" },
  boundsMin: { kind: "gate", extract: (s) => s.bounds?.min,
    hint: "the low corner is out of range — the part is positioned or oriented differently than expected" },
  boundsMax: { kind: "gate", extract: (s) => s.bounds?.max,
    hint: "the high corner is out of range — the part is positioned or oriented differently than expected" },
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
  // Unsupported downward-facing area (oracle/overhang.js), in mm². Measured only
  // for a part that declares `verify.orientation: "print"` under a profile with
  // an `overhang` angle; elsewhere `extract` returns null and check() skips it.
  // A warning, never a gate: a bridge reads as a ceiling and cannot be told apart.
  overhangArea: { kind: "warn", extract: (s) => s.overhangArea,
    hint: "unsupported downward-facing surface at the reported location — reorient the part so the face is vertical or on the bed, chamfer it to the process's overhang angle, split it into a bridged or supported feature, or accept supports",
    locate: (s) => s.overhangAt,
    note: (s) => (s.overhangAngle != null ? `steepest unsupported face ${s.overhangAngle.toFixed(1)}° from vertical` : null) },
  // `s.deviation` (measure.js) exists only for a sub-part declaring `reference:
  // "<import name>"`; on every other sub-part `extract` returns null, which
  // `check()` already reports as status "skip" rather than a fail — the
  // no-reference path needs nothing here.
  refXorVolume: { kind: "gate", extract: (s) => s.deviation?.xorVolume ?? null,
    hint: "the rebuild's symmetric difference vs its reference import is too large — compare the ghost overlay, then adjust the governing dimensions toward the measured reference" },
  refVolumeDeltaPct: { kind: "gate", extract: (s) => s.deviation?.volumeDeltaPct ?? null,
    hint: "rebuild volume differs from the reference import by more than the allowed percentage — a feature is missing, doubled, or mis-scaled vs the reference" },
  refBboxDelta: { kind: "gate", extract: (s) => s.deviation?.bboxDelta ?? null,
    hint: "the rebuild's bounding-box corners drift from the reference import — check overall dimensions and that the rebuild is aligned to the reference's coordinates" },
};
export const VIEW_METRICS = {
  bbox: { kind: "gate", extract: (r) => r.aggregate.bbox,
    hint: "the assembled view exceeds its size limit — shrink the assembly or pick a process with a larger bed" },
  volume: { kind: "gate", extract: (r) => r.aggregate.volume,
    hint: "total assembly volume is out of range — a sub-part is missing, doubled, or mis-scaled" },
  overlaps: { kind: "gate", extract: (r) => r.overlaps.length,
    hint: "sub-parts interpenetrate near the reported location — adjust placement or add clearance in derive()",
    locate: (r) => r.overlaps[0]?.location ?? null },
  centerOfMass: { kind: "gate", extract: (r) => r.aggregate.centerOfMass,
    hint: "the assembly's center of mass is outside the expected region — a sub-part is mis-placed or mis-scaled" },
  boundsMin: { kind: "gate", extract: (r) => r.aggregate.bounds?.min,
    hint: "the assembly's low corner is out of range — check placement or orientation" },
  boundsMax: { kind: "gate", extract: (r) => r.aggregate.bounds?.max,
    hint: "the assembly's high corner is out of range — check placement or orientation" },
};

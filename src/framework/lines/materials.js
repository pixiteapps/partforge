// Rope material presets for the lines core (spec 2026-11-20-lines-rope-and-cable-design.md,
// decision 2). Every value names its source; a value with no source is not in this table,
// and a rope may always give its own numbers, which win. Import-free.
//
// What a preset is NOT: `mu` here is the fibre maker's yarn-on-yarn figure, not a rope on
// a printed drum, and `modulus` is the FIBRE's, so a braided rope (whose strands straighten
// before they stretch) is less stiff than modulus × area. Both are bounds to design from
// until the joint has been measured: a holding ratio from this `mu` is a low estimate for
// a rougher drum, and a stiffness from this `modulus` is an upper bound.
export const ROPE_MATERIALS = Object.freeze({
  // Dyneema (UHMWPE) fibre, DSM "Dyneema Comprehensive factsheet UHMWPE": friction
  // coefficient (yarn-on-yarn) 0.05 - 0.07; axial tensile modulus 116 GPa (SK75: 109 - 132).
  uhmwpe: Object.freeze({ mu: 0.06, modulus: 116000 }), // modulus in MPa (N/mm²)
});

/**
 * A rope's numbers: `{ d, mu, EA, minBendRatio, bound }`. Explicit `mu`, `EA` (N) and
 * `minBendRatio` win over the preset; `EA` from a preset is `modulus × π d² / 4`, the solid
 * cross-section, and `bound: true` then marks every stiffness read from it as an upper bound.
 * `fail(field, msg)` throws.
 */
export function resolveRope(fail, rope) {
  if (!rope || typeof rope !== "object") fail("rope", "must be { d, material? }");
  const { d } = rope;
  if (!Number.isFinite(d) || !(d > 0)) fail("rope.d", `must be a positive number, got ${JSON.stringify(d)}`);
  let preset = null;
  if (rope.material != null) {
    preset = Object.hasOwn(ROPE_MATERIALS, rope.material) ? ROPE_MATERIALS[rope.material] : null;
    if (!preset) fail("rope.material", `unknown material ${JSON.stringify(rope.material)} (known: ${Object.keys(ROPE_MATERIALS).join(", ")}); give mu and EA instead`);
  }
  const opt = (field, v) => {
    if (v == null) return null;
    if (!Number.isFinite(v) || !(v > 0)) fail(`rope.${field}`, `must be a positive number, got ${JSON.stringify(v)}`);
    return v;
  };
  const mu = opt("mu", rope.mu) ?? preset?.mu ?? null;
  const own = opt("EA", rope.EA);
  const EA = own ?? (preset ? (preset.modulus * Math.PI * d * d) / 4 : null);
  return { d, mu, EA, minBendRatio: opt("minBendRatio", rope.minBendRatio), bound: own == null && EA != null };
}

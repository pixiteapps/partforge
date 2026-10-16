// meshImplicit's result object, shared by the JS stages and the native core
// (core/implicit-core.js) so both word their warnings, and count their stats,
// from the same facts: the compiled tree, the grid edge, the leaf plan, the
// final mesh and whether sampling clipped.
export function implicitResult(compiled, edge, plan, mesh, clipped) {
  const warnings = [];
  if (compiled.thin < 2 * edge) {
    warnings.push(`implicit: thinnest feature (${compiled.thin.toFixed(2)} mm) is under 2 grid cells at ${edge} mm — it may break up or grow handles; mesh it as its own k.implicit with a finer grid, or thicken it`);
  }
  if (clipped) {
    warnings.push(compiled.hasExpr
      ? "implicit: the shape reached the edge of its sampling box and was clipped flat there — enlarge the `box` of the `expr` node(s) it reaches past, or reduce blend widths and displacement"
      : "implicit: the shape reached the edge of its sampling box and was clipped flat there — its derived bounds were too tight (an engine limitation); reduce blend, round, onion or displace sizes");
  }
  return { positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, warnings,
    stats: { samples: plan.samples, leaves: plan.leaves.length, programs: plan.programs.length } };
}

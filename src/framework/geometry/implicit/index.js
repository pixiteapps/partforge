// The implicit engine's public surface for the kernels: compile a spec once,
// mesh it at a grid edge. Pure and DOM-free (loads in the geometry worker).
import { validateSpec } from "./grammar.js";
import { lowerSpec } from "./ir.js";
import { sampleField } from "./sparse.js";
import { meshStore } from "./mesher.js";
import { cleanupMesh } from "./cleanup.js";
import { applySurfaceDetail } from "./detail.js";

export const IMPLICIT_DEFAULTS = Object.freeze({ resolution: 0.6, preview: 1.5 });

export function compileImplicit(spec, { images = new Map() } = {}) {
  validateSpec(spec, { imageNames: new Set(images.keys()) });
  return lowerSpec(spec, { images });
}

export function meshImplicit(compiled, edge) {
  const store = sampleField(compiled, edge);
  let mesh = cleanupMesh(store, meshStore(store));
  if (compiled.detail.length) mesh = applySurfaceDetail(store, mesh, compiled);
  const warnings = [];
  if (compiled.thin < 2 * edge) {
    warnings.push(`implicit: thinnest feature (${compiled.thin.toFixed(2)} mm) is under 2 grid cells at ${edge} mm — it may break up or grow handles; mesh it as its own k.implicit with a finer grid, or thicken it`);
  }
  if (store.clipped) warnings.push("implicit: the shape reached the edge of its sampling box and was clipped flat there — enlarge the `box` of any `expr` node, or reduce blend widths and displacement");
  return { positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, warnings,
    stats: { samples: store.samples, leaves: store.leaves.length, programs: store.programs.size } };
}

export const implicitHashable = (spec, compiled) => ({ spec, digests: compiled.digests });

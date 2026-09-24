// Box-projected UVs and brush tangents, added only for realistic mode. three's
// anisotropy (brushed metal) needs a tangent frame, and CAD meshes carry neither
// UVs nor tangents. Projection is in OBJECT space along each vertex normal's
// dominant axis, so it rides with the sub-part and never swims. Nothing samples a
// texture through these UVs — triplanar patterns (patterns.js) ignore them.
//
// The TANGENT attribute is what the brush actually follows. Without one, three
// derives the frame per pixel from screen-space UV derivatives, which is constant
// across each triangle: on a fillet or a corner every facet read as its own flat
// brushed patch, and a triangle whose corners picked different projection axes
// got a garbage frame outright. The per-vertex tangent is the projection's u-axis
// (world X, or Y where X dominates the normal) flattened into the tangent plane, so
// it interpolates smoothly with the (analytic) vertex normals. It turns 90° only
// across the one facet row where the dominant axis changes, and never through
// zero — the two candidate axes are orthogonal.
import * as THREE from "three";

export function ensureBoxUVs(geometry, scaleMm = 20) {
  if (geometry.userData.boxUVs && geometry.attributes.uv && geometry.attributes.tangent) return geometry;
  const pos = geometry.attributes.position, nrm = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const tangent = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nrm ? nrm.getX(i) : 0, ny = nrm ? nrm.getY(i) : 0, nz = nrm ? nrm.getZ(i) : 1;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let u, v;
    if (az >= ax && az >= ay) { u = x; v = y; } else if (ay >= ax) { u = x; v = z; } else { u = y; v = z; }
    uv[i * 2] = u / scaleMm; uv[i * 2 + 1] = v / scaleMm;
    // u-axis minus its normal component; |that| ≥ √½ because the axis is never the
    // dominant one, so the normalize is always well-conditioned
    const uxAxis = !(ax > ay && ax > az);
    const d = uxAxis ? nx : ny;
    let tx = (uxAxis ? 1 : 0) - d * nx, ty = (uxAxis ? 0 : 1) - d * ny, tz = -d * nz;
    const L = Math.hypot(tx, ty, tz) || 1;
    tangent[i * 4] = tx / L; tangent[i * 4 + 1] = ty / L; tangent[i * 4 + 2] = tz / L; tangent[i * 4 + 3] = 1;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute("tangent", new THREE.BufferAttribute(tangent, 4));
  geometry.userData.boxUVs = true;
  return geometry;
}

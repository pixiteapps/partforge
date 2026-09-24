// Box-projected UVs, added only for realistic mode. three's anisotropy (brushed
// metal) builds its tangent frame from UV derivatives, and CAD meshes carry no
// UVs. Projection is in OBJECT space along each vertex normal's dominant axis, so
// it rides with the sub-part and never swims. Seams on curved surfaces are
// acceptable: nothing samples a texture through these UVs — triplanar patterns
// (patterns.js) ignore them.
import * as THREE from "three";

export function ensureBoxUVs(geometry, scaleMm = 20) {
  if (geometry.userData.boxUVs && geometry.attributes.uv) return geometry;
  const pos = geometry.attributes.position, nrm = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm ? nrm.getX(i) : 0), ay = Math.abs(nrm ? nrm.getY(i) : 0), az = Math.abs(nrm ? nrm.getZ(i) : 1);
    let u, v;
    if (az >= ax && az >= ay) { u = x; v = y; } else if (ay >= ax) { u = x; v = z; } else { u = y; v = z; }
    uv[i * 2] = u / scaleMm; uv[i * 2 + 1] = v / scaleMm;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.userData.boxUVs = true;
  return geometry;
}

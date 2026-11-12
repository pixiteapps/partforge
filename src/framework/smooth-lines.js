// Anti-aliased fat lines. three's LineMaterial draws each screen-space segment
// as a quad exactly `linewidth` wide, so its sides are only as smooth as the
// target's MSAA (4 coverage levels, and none on a target without samples).
// smoothLineMaterial widens the quad by one resolution pixel and fades the
// fragment's alpha over the device pixel straddling the true edge (fwidth of
// the across-line coordinate), so a near-horizontal line no longer
// stair-steps. The patch rewrites the material's own shader strings — which
// clone()/copy() carry, unlike onBeforeCompile — and makes it blend.
// World-unit lines are left alone.

const PAD = "1.0"; // resolution px added across the quad: 0.5 each side

export function smoothLineMaterial(material) {
  if (!material?.isLineMaterial || material.defines?.PF_SMOOTH_LINE !== undefined) return material;
  const vert = material.vertexShader.replace(
    "offset *= linewidth;",
    "offset *= linewidth + PF_SMOOTH_LINE;",
  );
  const frag = material.fragmentShader.replace(
    "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
    `#ifndef WORLD_UNITS
				// the true edge sits at |vUv.x| = w / (w + pad); fade over one device pixel
				float pfEdge = linewidth / ( linewidth + PF_SMOOTH_LINE );
				float pfFw = max( fwidth( vUv.x ), 1e-5 );
				alpha *= clamp( ( pfEdge - abs( vUv.x ) ) / pfFw + 0.5, 0.0, 1.0 );
			#endif
			gl_FragColor = vec4( diffuseColor.rgb, alpha );`,
  );
  // three's shader changed shape: leave the material as it was rather than half-patched.
  if (vert === material.vertexShader || frag === material.fragmentShader) return material;
  material.vertexShader = vert;
  material.fragmentShader = frag;
  material.defines = { ...material.defines, PF_SMOOTH_LINE: PAD };
  material.transparent = true;
  material.needsUpdate = true;
  return material;
}

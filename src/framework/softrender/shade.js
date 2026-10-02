// Per-sample shading = three.js MeshStandardMaterial under a HemisphereLight
// and two DirectionalLights, no environment map, no tone mapping (the CAD and
// thumbnail captures render LDR, linear). Ported from three r184's shader
// chunks (common, lights_physical_pars_fragment, lights_pars_begin,
// lights_physical_fragment); if three changes them, re-port — the parity
// script is what notices.
//
// r184 differs from the classic Lambert + GGX picture in two ways that matter
// even with no env map: direct specular carries a multiscattering term, and the
// hemisphere irradiance feeds `indirectSpecular` (multiScattering) as well as a
// diffuse term darkened by the dielectric DFG energy. Both read the DFG LUT.
// Not ported: `geometryRoughness` (a screen-space derivative of the geometric
// normal, nonzero only across creases / smooth-normal gradients).
import { srgbHexToLinear } from "../renderStyles.js";
import { captureLightPoses } from "../style-camera.js";
import { dfgLut } from "./dfgLut.js";

const RECIPROCAL_PI = 1 / Math.PI;
const EPSILON = 1e-6;
const FAVG_K = 0.047619; // 1/21
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function prepareMaterial({ color, metalness, roughness }) {
  const base = srgbHexToLinear(color);
  return {
    base,
    metalness,
    diffuse: base.map((c) => c * (1 - metalness)), // diffuseContribution
    f0: base.map((c) => 0.04 * (1 - metalness) + c * metalness), // specularColorBlended
    roughness: Math.min(Math.max(roughness, 0.0525), 1),
  };
}

export function prepareLights(lights, pose) {
  const poses = captureLightPoses(pose, lights);
  const lin = (hex, k) => srgbHexToLinear(hex).map((c) => c * k);
  const dirTo = (p) => {
    const d = [p[0] - pose.target[0], p[1] - pose.target[1], p[2] - pose.target[2]];
    const l = Math.hypot(...d) || 1;
    return d.map((c) => c / l);
  };
  return {
    sky: lin(lights.hemisphere.sky, lights.hemisphere.intensity),
    ground: lin(lights.hemisphere.ground, lights.hemisphere.intensity),
    up: [0, 1, 0],
    directional: [
      { dir: dirTo(poses.key), color: lin(lights.key.color, lights.key.intensity) },
      { dir: dirTo(poses.fill), color: lin(lights.fill.color, lights.fill.intensity) },
    ],
  };
}

export function shade(N, V, mat, lights, out, o) {
  const { base, metalness, diffuse, f0, roughness } = mat;
  const dotNV = sat(N[0] * V[0] + N[1] * V[1] + N[2] * V[2]);
  const dfgV = dfgLut(roughness, dotNV);
  const EssV = dfgV[0] + dfgV[1];
  const EmsV = 1 - EssV;
  const col = [0, 0, 0];

  // Indirect: hemisphere irradiance, no env radiance. computeMultiscattering
  // runs for a dielectric (f0 = 0.04) and a metal (f0 = base colour), mixed by
  // metalness; diffuse keeps what the DIELECTRIC path does not reflect.
  const w = 0.5 * (N[0] * lights.up[0] + N[1] * lights.up[1] + N[2] * lights.up[2]) + 0.5;
  for (let i = 0; i < 3; i++) {
    const irr = lights.ground[i] + (lights.sky[i] - lights.ground[i]) * w;
    const scat = (fr) => {
      const fss = fr * dfgV[0] + dfgV[1];
      const favg = fr + (1 - fr) * FAVG_K;
      return [fss, (fss * favg / (1 - EmsV * favg)) * EmsV];
    };
    const [ssD, msD] = scat(0.04);
    const [, msM] = scat(base[i]);
    const multi = msD + (msM - msD) * metalness;
    const cosIrr = irr * RECIPROCAL_PI;
    col[i] = multi * cosIrr + diffuse[i] * (1 - (ssD + msD)) * cosIrr;
  }

  const alpha = roughness * roughness, a2 = alpha * alpha;
  for (const { dir: L, color } of lights.directional) {
    const dotNL = sat(N[0] * L[0] + N[1] * L[1] + N[2] * L[2]);
    if (dotNL <= 0) continue;
    let hx = L[0] + V[0], hy = L[1] + V[1], hz = L[2] + V[2];
    const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
    const dotNH = sat(N[0] * hx + N[1] * hy + N[2] * hz);
    const dotVH = sat(V[0] * hx + V[1] * hy + V[2] * hz);
    // F_Schlick, three's exp2 form, f90 = 1
    const fresnel = 2 ** ((-5.55473 * dotVH - 6.98316) * dotVH);
    // V_GGX_SmithCorrelated
    const gv = dotNL * Math.sqrt(a2 + (1 - a2) * dotNV * dotNV);
    const gl = dotNV * Math.sqrt(a2 + (1 - a2) * dotNL * dotNL);
    const vis = 0.5 / Math.max(gv + gl, EPSILON);
    // D_GGX
    const denom = dotNH * dotNH * (a2 - 1) + 1;
    const D = (RECIPROCAL_PI * a2) / (denom * denom);
    const sv = vis * D;
    // BRDF_GGX_Multiscatter's compensation (Turquin)
    const dfgL = dfgLut(roughness, dotNL);
    const EmsL = 1 - (dfgL[0] + dfgL[1]);
    for (let i = 0; i < 3; i++) {
      const single = (f0[i] * (1 - fresnel) + fresnel) * sv;
      const favg = f0[i] + (1 - f0[i]) * FAVG_K;
      const fssV = f0[i] * dfgV[0] + dfgV[1], fssL = f0[i] * dfgL[0] + dfgL[1];
      const multi = ((fssV * fssL * favg) / (1 - EmsV * EmsL * favg + EPSILON)) * EmsV * EmsL;
      col[i] += dotNL * color[i] * (diffuse[i] * RECIPROCAL_PI + single + multi);
    }
  }
  out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2];
}

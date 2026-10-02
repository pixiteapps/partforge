// src/framework/softrender/index.js
// renderStyled: one view of a set of sub-part meshes in a named capture style
// (renderStyles.js), as raw sRGB RGBA. The CPU twin of the viewer's offscreen
// captures: same framing (style-camera.js), same lights and material model
// (shade.js), same contact shadow (contact-shadow.js). Encoding is the
// caller's. Opacity keeps the old contract: pre-blended toward the
// background, still occluding — real transparency is out of scope.
import { getRenderStyle, srgbHexToLinear, SRGB8 } from "../renderStyles.js";
import { stylePose, modelToWorld, boundsOf } from "../style-camera.js";
import { contactShadowMask, sampleShadowMask } from "../contact-shadow.js";
import { cadAppearance, hasAppearance } from "../materials/resolve.js";
import { makeCamera } from "./camera.js";
import { createGBuffer, rasterizeMesh } from "./raster.js";
import { prepareMaterial, prepareLights, shade } from "./shade.js";
import { drawEdges } from "./edges.js";

const NORMAL_SAME = 0.9995; // samples this aligned share one shading evaluation
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function renderStyled(subparts, { view, style = "cad", size = [1024, 1024], supersample = 2, edges = true } = {}) {
  const st = getRenderStyle(style);
  const angle = view ?? st.view ?? "iso";
  const [W, H] = size;
  const ss = Math.round(supersample);
  if (!Number.isFinite(ss) || ss < 1) throw new Error("renderStyled: supersample must be a positive integer");
  const WS = W * ss, HS = H * ss;

  const parts = subparts.map((sp) => {
    const opacity = Number.isFinite(sp.opacity) ? clamp01(sp.opacity) : 1;
    const look = hasAppearance(sp.display) ? cadAppearance(sp.display) : { ...st.material, opacity: 1 };
    return {
      positions: modelToWorld(sp.mesh.positions ?? []),
      normals: sp.mesh.normals?.length ? modelToWorld(sp.mesh.normals) : null,
      indices: sp.mesh.indices,
      edges: sp.mesh.edges?.length ? modelToWorld(sp.mesh.edges) : null,
      opacity: opacity * (Number.isFinite(look.opacity) ? look.opacity : 1),
      material: prepareMaterial(look),
    };
  });
  // Framing counts EVERY sub-part, visible or not: a fade must not reframe.
  const box = boundsOf(parts.map((p) => p.positions));
  const points = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  parts.reduce((o, p) => { points.set(p.positions, o); return o + p.positions.length; }, 0);
  const { pose, fov, sceneBounds } = stylePose(st, angle, box, { aspect: W / H, points });
  const cam = makeCamera(pose, { fov, width: WS, height: HS });
  const visible = parts.map((p, i) => ({ ...p, owner: i })).filter((p) => p.opacity > 0);

  const gb = createGBuffer(WS, HS);
  for (const p of visible) rasterizeMesh(gb, cam, { positions: p.positions, normals: p.normals, indices: p.indices }, p.owner);

  const bg = srgbHexToLinear(st.background);
  const lights = prepareLights(st.lights, pose);
  const color = new Float32Array(WS * HS * 3);

  // Shadow: only from visible geometry, only seen from above the floor.
  const mask = st.shadow && box && pose.position[1] > box.min[1]
    ? contactShadowMask(visible.map((p) => ({ positions: p.positions, indices: p.indices })), box, st.shadow)
    : null;

  const N = [0, 0, 0], V = [0, 0, 0], R = [0, 0, 0], tmp = new Float32Array(3);
  const background = (k, sx, sy) => {
    let a = 0;
    if (mask) {
      const r = cam.ray(sx, sy, R);
      if (r[1] < 0) {
        const t = (mask.y - cam.position[1]) / r[1];
        a = sampleShadowMask(mask, cam.position[0] + r[0] * t, cam.position[2] + r[2] * t) * st.shadow.opacity;
      }
    }
    color[k * 3] = bg[0] * (1 - a); color[k * 3 + 1] = bg[1] * (1 - a); color[k * 3 + 2] = bg[2] * (1 - a);
  };
  const surface = (k, owner, sx, sy, out, o) => {
    N[0] = gb.normal[k * 3]; N[1] = gb.normal[k * 3 + 1]; N[2] = gb.normal[k * 3 + 2];
    const r = cam.ray(sx, sy, R);
    const l = Math.hypot(r[0], r[1], r[2]);
    V[0] = -r[0] / l; V[1] = -r[1] / l; V[2] = -r[2] / l;
    const p = parts[owner];
    shade(N, V, p.material, lights, out, o);
    if (p.opacity < 1) for (let c = 0; c < 3; c++) out[o + c] = bg[c] + (out[o + c] - bg[c]) * p.opacity;
  };

  // Shade per output pixel; a pixel whose samples all belong to one sub-part
  // with near-identical normals is shaded once (most of the image), others
  // per sample (silhouettes, creases). Same picture, far fewer evaluations.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k0 = (y * ss) * WS + x * ss;
    const owner0 = gb.owner[k0];
    let uniform = owner0 >= 0;
    for (let j = 0; j < ss && uniform; j++) for (let i = 0; i < ss && uniform; i++) {
      const k = (y * ss + j) * WS + x * ss + i;
      if (gb.owner[k] !== owner0) uniform = false;
      else {
        const d = gb.normal[k * 3] * gb.normal[k0 * 3] + gb.normal[k * 3 + 1] * gb.normal[k0 * 3 + 1] + gb.normal[k * 3 + 2] * gb.normal[k0 * 3 + 2];
        if (d < NORMAL_SAME) uniform = false;
      }
    }
    if (uniform) {
      surface(k0, owner0, (x + 0.5) * ss, (y + 0.5) * ss, tmp, 0);
      for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) color.set(tmp, ((y * ss + j) * WS + x * ss + i) * 3);
    } else {
      for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
        const k = (y * ss + j) * WS + x * ss + i;
        const sx = x * ss + i + 0.5, sy = y * ss + j + 0.5;
        if (gb.owner[k] < 0) background(k, sx, sy);
        else surface(k, gb.owner[k], sx, sy, color, k * 3);
      }
    }
  }

  if (edges) {
    const edgeRgb = srgbHexToLinear(st.edges.color);
    const bias = sceneBounds.radius * 0.01;
    for (const p of visible) {
      const rgb = p.opacity < 1 ? edgeRgb.map((c, i) => bg[i] + (c - bg[i]) * p.opacity) : edgeRgb;
      drawEdges(color, gb, cam, p.edges, rgb, st.edges.opacity, st.edges.widthPx, ss, bias);
    }
  }

  // Resolve: average linear samples (as an MSAA resolve does), quantize to a
  // linear byte, then the same sRGB LUT the viewer's readback uses.
  const rgba = new Uint8ClampedArray(W * H * 4);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const o = ((y * ss + j) * WS + x * ss + i) * 3;
      r += color[o]; g += color[o + 1]; b += color[o + 2];
    }
    const q = (y * W + x) * 4;
    rgba[q] = SRGB8[Math.round(clamp01(r * inv) * 255)];
    rgba[q + 1] = SRGB8[Math.round(clamp01(g * inv) * 255)];
    rgba[q + 2] = SRGB8[Math.round(clamp01(b * inv) * 255)];
    rgba[q + 3] = 255;
  }
  return { width: W, height: H, rgba, view: angle };
}

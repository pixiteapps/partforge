// src/framework/renderStyles.js
// The two offscreen capture looks, as plain data: `cad` (the agent's renders)
// and `thumbnail` (the card/product shot). Read by BOTH the three.js viewer
// (viewer.js, viewer-lighting.js) and the CPU renderer (softrender/), so a
// look is written down once and the two renderers cannot drift apart. No
// three.js here: this module runs in the Vercel Sandbox under plain Node.
//
// Colours are sRGB hex, exactly as three.js receives them; consumers convert
// to linear (srgbHexToLinear) the way three's ColorManagement does.

export const CAD_LIGHT_THEME = Object.freeze({ bg: 0xe9edf2, line: 0x33414f });
export const CAD_DARK_THEME = Object.freeze({ bg: 0x15181d, line: 0x1c232d });

const CAD_LIGHTS = {
  hemisphere: { sky: 0xdce9ff, ground: 0x687586, intensity: 1.35 },
  // Offsets are camera-space multiples of the camera-to-target distance:
  // key over the viewer's shoulder, fill opposing it at eye level
  // (style-camera.js captureLightPoses places them).
  key: { color: 0xffffff, intensity: 1.45, offset: { right: 0.45, up: 0.75 } },
  fill: { color: 0xe5efff, intensity: 0.65, offset: { right: -0.7, up: 0.15 } },
};
const CAD_MATERIAL = { color: 0x9fb4cc, metalness: 0.25, roughness: 0.55 };

// Starting values for the product shot, tuned against real parts in the
// parity task (scripts/check-softrender-parity.mjs). Retune them there, on
// captures, never by eye on the hex.
const STYLES = {
  cad: {
    camera: { projection: "perspective", fov: 45, framing: "canonical" },
    lights: CAD_LIGHTS,
    material: CAD_MATERIAL,
    edges: { color: CAD_LIGHT_THEME.line, widthPx: 1, opacity: 1 },
    background: CAD_LIGHT_THEME.bg,
    shadow: null,
    view: null,
  },
  thumbnail: {
    camera: { projection: "perspective", fov: 45, framing: "fit", fill: 0.82 },
    lights: {
      hemisphere: { ...CAD_LIGHTS.hemisphere, intensity: 1.55 },
      key: { ...CAD_LIGHTS.key, intensity: 1.25 },
      fill: { ...CAD_LIGHTS.fill, intensity: 0.85 },
    },
    material: CAD_MATERIAL,
    edges: { color: CAD_LIGHT_THEME.line, widthPx: 1, opacity: 0.6 },
    background: 0xeef1f5,
    // falloff/blur are fractions of the part's bounding-box diagonal;
    // resolution is the mask's long side in cells.
    shadow: { opacity: 0.25, falloff: 0.15, blur: 0.03, resolution: 128 },
    view: "iso",
  },
};

const isHex = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;
const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
function check(ok, field) { if (!ok) throw new Error(`render style: ${field} is invalid`); }

export function validateRenderStyle(s) {
  check(s && typeof s === "object", "style");
  check(s.camera?.projection === "perspective", "camera.projection");
  check(inRange(s.camera.fov, 1, 120), "camera.fov");
  check(s.camera.framing === "canonical" || s.camera.framing === "fit", "camera.framing");
  if (s.camera.framing === "fit") check(inRange(s.camera.fill, 0.05, 1), "camera.fill");
  const h = s.lights?.hemisphere;
  check(isHex(h?.sky) && isHex(h?.ground) && inRange(h?.intensity, 0, 20), "lights.hemisphere");
  for (const k of ["key", "fill"]) {
    const l = s.lights[k];
    check(isHex(l?.color) && inRange(l?.intensity, 0, 20), `lights.${k}`);
    check(inRange(l.offset?.right, -10, 10) && inRange(l.offset?.up, -10, 10), `lights.${k}.offset`);
  }
  check(isHex(s.material?.color), "material.color");
  check(inRange(s.material.metalness, 0, 1), "material.metalness");
  check(inRange(s.material.roughness, 0, 1), "material.roughness");
  check(isHex(s.edges?.color) && inRange(s.edges?.widthPx, 0.25, 8) && inRange(s.edges?.opacity, 0, 1), "edges");
  check(isHex(s.background), "background");
  if (s.shadow !== null) {
    const sh = s.shadow;
    check(inRange(sh?.opacity, 0, 1) && inRange(sh?.falloff, 0.001, 10) && inRange(sh?.blur, 0, 1)
      && Number.isInteger(sh?.resolution) && sh.resolution >= 8 && sh.resolution <= 1024, "shadow");
  }
  check(s.view === null || typeof s.view === "string", "view");
  return s;
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

// Validated once, at load: a typo in the data above fails every test that
// imports this module rather than producing odd images.
for (const s of Object.values(STYLES)) validateRenderStyle(s);
export const RENDER_STYLES = deepFreeze(structuredClone(STYLES));

export function getRenderStyle(nameOrStyle) {
  if (typeof nameOrStyle === "string") {
    if (!Object.hasOwn(RENDER_STYLES, nameOrStyle)) throw new Error(`unknown render style "${nameOrStyle}"`);
    return RENDER_STYLES[nameOrStyle];
  }
  return validateRenderStyle(nameOrStyle);
}

// sRGB hex → linear [r, g, b], the same transfer three's ColorManagement
// applies to a hex colour handed to a material or a light.
export function srgbHexToLinear(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((b) => {
    const c = b / 255;
    return c < 0.04045 ? c * 0.0773993808 : ((c * 0.9478672986) + 0.0521327014) ** 2.4;
  });
}

// three renders into a render target in the LINEAR working colour space: as of r184
// WebGLRenderer only applies `outputColorSpace` on the canvas path (WebGLPrograms
// substitutes workingColorSpace whenever a render target is bound), so readback pixels
// are linear no matter what the target texture's colorSpace says. Writing them straight
// into a JPEG is what made captured views come back muddy and dark compared to the live
// canvas. Encode the transfer function ourselves. The 8-bit LUT loses precision only in
// the deepest shadows, which a quality-0.9 JPEG would not have preserved anyway.
export const SRGB8 = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const l = i / 255;
    table[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
  }
  return table;
})();

// Linear RGBA bytes → sRGB, in place. Alpha is a coverage value, not a colour: untouched.
export function srgbEncodeInPlace(data) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = SRGB8[data[i]];
    data[i + 1] = SRGB8[data[i + 1]];
    data[i + 2] = SRGB8[data[i + 2]];
  }
  return data;
}

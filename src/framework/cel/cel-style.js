// The cel (anime) look as data plus two colour functions. Pure on purpose: no
// three.js and no DOM, so the constants and the tone derivation can be read and
// tested anywhere; the three.js materials built from them live in sibling modules
// the viewer alone imports. Every value here was locked by the look-and-feel spike.
import { cadAppearance } from "../materials/resolve.js";

export const CEL = Object.freeze({
  bands: Object.freeze({ count: 3, lit: 0.45, deep: 0.05, softness: 0.015 }),
  shadow: Object.freeze({ darken: 0.74, tint: 0x6f86b4, tintAmount: 0.5, deepDarken: 0.7 }),
  highlight: Object.freeze({ strength: 0.85, size: 0.6, shininess: 60 }),
  rim: Object.freeze({ strength: 0.6, width: 0.18 }),
  light: Object.freeze({ azimuthDeg: -35, elevationDeg: 38 }),
  ink: Object.freeze({
    color: 0x161a24, thickPx: 0.7, thinPx: 0.3, outerBoost: 1.4,
    depthThreshold: 0.004, normalThreshold: 0.3, kernelLineOpacity: 0.55,
  }),
  field: Object.freeze({ color: 0x9fd9ea, dots: 0.1, dotCellPx: 7, dotDarken: 0.82 }),
  ground: Object.freeze({
    opacity: 0.3, color: 0x24304a, penumbra: 0.08, elevationDeg: 60, minWorldElevationDeg: 40,
    mapSize: 2048, mapSizeSmall: 1024, bias: -0.0015, lightDistanceR: 30, nearR: 26, farR: 34,
    frustumR: 4, planeFill: 0.98,
  }),
});

/** The near-white a part with no colour and no material is drawn in. */
export const CEL_BODY = 0xeef1f4;

/** The sRGB hex a sub-part is toned from: its effective CAD colour, else the body white. */
export function celBase(display) {
  if (!display || typeof display !== "object") return CEL_BODY;
  if (display.color == null && display.material == null) return CEL_BODY;
  return cadAppearance(display).color;
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const channels = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => v / 255);
const pack = (c) => c.reduce((acc, v) => (acc << 8) | Math.round(Math.min(1, Math.max(0, v)) * 255), 0);

/** Lit / shadow / deep-shadow sRGB hexes for a base colour (shadow leans toward the cool tint). */
export function celTones(baseHex) {
  const { darken, tint, tintAmount, deepDarken } = CEL.shadow;
  const base = channels(baseHex);
  const tc = channels(tint);
  const scale = luma(...base) / luma(...tc);
  const shadow = base.map((b, i) => {
    const s = b * darken * (1 - tintAmount) + tc[i] * scale * darken * tintAmount;
    return Math.min(1, Math.max(0, s));
  });
  const deep = shadow.map((s) => s * deepDarken);
  return { lit: baseHex, shadow: pack(shadow), deep: pack(deep) };
}

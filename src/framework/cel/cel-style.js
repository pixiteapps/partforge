// The cel (anime) look as data plus two colour functions. Pure on purpose: no
// three.js and no DOM, so the constants and the tone derivation can be read and
// tested anywhere; the three.js materials built from them live in sibling modules
// the viewer alone imports. The values came from a look-and-feel spike, since
// deleted; the contract now is the goldens in test/cel-style.test.js. The tones
// are derived in LINEAR space, because that is where the spike's shader mixed
// them.
import { cadAppearance } from "../materials/resolve.js";

export const CEL = Object.freeze({
  bands: Object.freeze({ count: 3, lit: 0.45, deep: 0.05, softness: 0.015 }),
  shadow: Object.freeze({ darken: 0.74, tint: 0x6f86b4, tintAmount: 0.25, deepDarken: 0.7 }),
  highlight: Object.freeze({ strength: 0.85, size: 0.6, shininess: 60 }),
  rim: Object.freeze({ strength: 0.6, width: 0.18 }),
  // The key light: azimuth / elevation in VIEW space, read at the pose `at` — the
  // viewer's DEFAULT camera (viewer.js: camera.position.set(18, 12, 18), looking at
  // the origin, y up; about 25° above the horizon, not the 35° of a pure iso).
  // The live view holds that world direction still while the camera orbits
  // (celLightWorld); a capture lights camera-relative. Read at a higher pose the
  // world key steepens and a box's front face falls just under the lit band.
  light: Object.freeze({ azimuthDeg: -35, elevationDeg: 38, at: Object.freeze({ dir: Object.freeze([18, 12, 18]), up: Object.freeze([0, 1, 0]) }) }),
  ink: Object.freeze({
    color: 0x161a24, thickPx: 0.7, thinPx: 0.3, outerBoost: 1.4,
    depthThreshold: 0.004, normalThreshold: 0.3, kernelLineOpacity: 0.55,
  }),
  // The field (backdrop) per theme: `color` is the light theme's pale cyan,
  // `darkColor` the dark theme's slate; the halftone dot is the field darkened
  // (light) or lightened (dark) by `dotDarken` / `dotLighten`. celField() picks.
  field: Object.freeze({ color: 0x9fd9ea, darkColor: 0x273648, dots: 0.1, dotCellPx: 7, dotDarken: 0.82, dotLighten: 1.3 }),
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

// The spike's shader took the base and tint as THREE.Colors, which three decodes
// to linear, mixed them there, and encoded the result back to sRGB on output; so
// the tones are derived in linear space too, with the spike's own luma weights.
// This function's contract is "what the spike drew".
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const channels = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => toLinear(v / 255));
const pack = (c) => c.reduce((acc, v) => (acc << 8) | Math.round(Math.min(1, Math.max(0, toSrgb(v))) * 255), 0);

const scaleHex = (hex, k) => pack(channels(hex).map((c) => c * k));

/**
 * The field for a theme: `{ color, dot }` sRGB hexes — the backdrop and the
 * halftone dot drawn on it. "dark" gets the slate field with a lightened dot;
 * anything else the light theme's pale cyan with a darkened dot.
 */
export function celField(theme) {
  const { color, darkColor, dotDarken, dotLighten } = CEL.field;
  return theme === "dark"
    ? { color: darkColor, dot: scaleHex(darkColor, dotLighten) }
    : { color, dot: scaleHex(color, dotDarken) };
}

/** Lit / shadow / deep-shadow sRGB hexes for a base colour (shadow leans toward the cool tint). */
export function celTones(baseHex) {
  const { darken, tint, tintAmount, deepDarken } = CEL.shadow;
  const base = channels(baseHex);
  const tc = channels(tint);
  const k = luma(...base) / Math.max(luma(...tc), 0.001);
  const shadow = base.map((b, i) => {
    const plain = b * darken;
    const tinted = Math.min(1, tc[i] * k) * darken;
    return plain + (tinted - plain) * tintAmount;
  });
  const deep = shadow.map((s) => s * deepDarken);
  return { lit: baseHex, shadow: pack(shadow), deep: pack(deep) };
}

// --- The key light's frame ------------------------------------------------
// CEL.light is an up-left direction in view space, the way a drawn figure is
// lit. Held in view space it turns with the camera, and an orbit sweeps the band
// edges across the part — every face flips tone as it crosses one. So the LIVE
// view fixes the key in the world instead: the view-space direction is read once
// at the pose CEL.light.at (the viewer's default camera), and that world direction
// is what every live frame lights by, so a face keeps its tone through an orbit.
// Seen from the default camera the two agree exactly. Captures keep the camera-relative key (every
// canonical view lit the same way, as CAD's capture lights do), which is why
// this stays a pure function of the constants rather than a viewer setting.
const unit = ([x, y, z]) => { const n = Math.hypot(x, y, z) || 1; return [x / n, y / n, z / n]; };
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
const viewDir = ({ azimuthDeg, elevationDeg }) => {
  const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
};

/** The key light as a unit direction in VIEW space (x right, y up, z toward the viewer). */
export function celLightView() { return viewDir(CEL.light); }

/**
 * The key light as a unit direction in WORLD space: CEL.light read at the camera
 * pose CEL.light.at — a camera on `dir` looking at the origin with `up` up. The
 * same lookAt basis three builds, so a camera at that pose transforms this back
 * to celLightView() exactly.
 */
export function celLightWorld() {
  const z = unit(CEL.light.at.dir);              // camera +z: from the target back to the camera
  const x = unit(cross(CEL.light.at.up, z));     // camera +x: right
  const y = cross(z, x);                         // camera +y: up
  const [lx, ly, lz] = viewDir(CEL.light);
  return unit([x[0] * lx + y[0] * ly + z[0] * lz, x[1] * lx + y[1] * ly + z[1] * lz, x[2] * lx + y[2] * ly + z[2] * lz]);
}

/**
 * The ground shadow's light in WORLD space for the live view: the key's world
 * azimuth raised to CEL.ground.elevationDeg, so the shadow falls away from the
 * lit side and holds still with it.
 */
export function celGroundLightWorld() {
  const [kx, , kz] = celLightWorld();
  const el = CEL.ground.elevationDeg * Math.PI / 180;
  const h = Math.hypot(kx, kz) || 1;
  return [kx / h * Math.cos(el), Math.sin(el), kz / h * Math.cos(el)];
}

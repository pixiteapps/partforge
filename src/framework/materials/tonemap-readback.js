// three applies tone mapping and output colour space ONLY on the canvas path
// (r184: a bound render target gets NoToneMapping and linear output). Realistic
// captures therefore render HDR into a half-float target and finish here, in JS:
// exposure → Khronos PBR Neutral (the same curve THREE.NeutralToneMapping uses on
// the live canvas) → sRGB. Pure; no three import.
const START = 0.8 - 0.04, DESAT = 0.15;

function neutral(r, g, b) {
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset; g -= offset; b -= offset;
  const peak = Math.max(r, g, b);
  if (peak < START) return [r, g, b];
  const d = 1 - START;
  const newPeak = 1 - (d * d) / (peak + d - START);
  const s = newPeak / peak;
  r *= s; g *= s; b *= s;
  const t = 1 - 1 / (DESAT * (peak - newPeak) + 1);
  return [r + (newPeak - r) * t, g + (newPeak - g) * t, b + (newPeak - b) * t];
}

const srgb = (l) => {
  const c = Math.min(1, Math.max(0, l));
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};

// Linear RGBA floats → sRGB RGBA bytes. Alpha is forced opaque: a realistic
// capture always has the environment backdrop behind it.
export function neutralToneMapToSrgb8(src, exposure = 1) {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, b] = neutral(src[i] * exposure, src[i + 1] * exposure, src[i + 2] * exposure);
    out[i] = srgb(r); out[i + 1] = srgb(g); out[i + 2] = srgb(b); out[i + 3] = 255;
  }
  return out;
}

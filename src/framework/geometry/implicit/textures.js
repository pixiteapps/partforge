// Image textures for expr formulas and surface detail. Pixels are stored once as
// float32 in 0..1; sampling is bilinear with only + − × floor, so the native port
// matches it exactly. Orientation follows heightfield: image row 0 is v = 0.
import { ImplicitSizeError } from "./errors.js";

export const TEXTURE_LIMITS = Object.freeze({ maxSide: 2048, maxTexelsPerPart: 16 * 1024 * 1024 });

export function makeTexture(image) {
  const data = new Float32Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) data[i] = image.data[i] / 65535;
  return { width: image.width, height: image.height, data, digest: image.digest };
}

export function sampleTexture(t, u, v) {
  const uc = u > 0 ? (u < 1 ? u : 1) : 0;   // NaN fails `u > 0` → 0
  const vc = v > 0 ? (v < 1 ? v : 1) : 0;
  const fx = uc * (t.width - 1), fy = vc * (t.height - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1 < t.width ? x0 + 1 : x0, y1 = y0 + 1 < t.height ? y0 + 1 : y0;
  const ax = fx - x0, ay = fy - y0, d = t.data, w = t.width;
  const top = d[y0 * w + x0] * (1 - ax) + d[y0 * w + x1] * ax;
  const bot = d[y1 * w + x0] * (1 - ax) + d[y1 * w + x1] * ax;
  return top * (1 - ay) + bot * ay;
}

export function checkTextureBudget(textures) {
  let total = 0;
  for (const t of textures) {
    if (t.width > TEXTURE_LIMITS.maxSide || t.height > TEXTURE_LIMITS.maxSide) {
      throw new ImplicitSizeError(`texture ${t.width}×${t.height} exceeds ${TEXTURE_LIMITS.maxSide} px per side — downscale the image`);
    }
    total += t.width * t.height;
  }
  if (total > TEXTURE_LIMITS.maxTexelsPerPart) {
    throw new ImplicitSizeError(`textures total ${total} texels, over the ${TEXTURE_LIMITS.maxTexelsPerPart} per-part limit`);
  }
}

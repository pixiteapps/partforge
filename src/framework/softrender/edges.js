// src/framework/softrender/edges.js
// Feature edges as lines of the style's width, stamped at supersample
// resolution (so they come out antialiased after the downsample) and depth-
// tested against the G-buffer with a scene-relative bias. Coverage is marked
// first and blended ONCE per sample: overlapping stamps of a translucent line
// must not darken where they overlap.
import { NEAR } from "./raster.js";

export function drawEdges(color, gb, cam, segments, rgb, opacity, widthPx, ss, bias) {
  if (!segments?.length || opacity <= 0) return;
  const { width: W, height: H, depth } = gb;
  const mark = new Uint8Array(W * H);
  const half = Math.max(0.5, (widthPx * ss) / 2);
  for (let i = 0; i + 5 < segments.length; i += 6) {
    const p0 = cam.project(segments[i], segments[i + 1], segments[i + 2]);
    const p1 = cam.project(segments[i + 3], segments[i + 4], segments[i + 5]);
    if (p0[2] < NEAR || p1[2] < NEAR) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = p0[0] + (p1[0] - p0[0]) * t, y = p0[1] + (p1[1] - p0[1]) * t;
      const z = 1 / ((1 - t) / p0[2] + t / p1[2]); // depth is linear in 1/z on screen
      const xmin = Math.max(0, Math.floor(x - half + 0.5)), xmax = Math.min(W - 1, Math.max(xmin, Math.floor(x + half - 0.5)));
      const ymin = Math.max(0, Math.floor(y - half + 0.5)), ymax = Math.min(H - 1, Math.max(ymin, Math.floor(y + half - 0.5)));
      for (let yy = ymin; yy <= ymax; yy++) for (let xx = xmin; xx <= xmax; xx++) {
        const k = yy * W + xx;
        if (z - bias <= depth[k]) mark[k] = 1;
      }
    }
  }
  for (let k = 0; k < mark.length; k++) {
    if (!mark[k]) continue;
    const o = k * 3;
    color[o] += (rgb[0] - color[o]) * opacity;
    color[o + 1] += (rgb[1] - color[o + 1]) * opacity;
    color[o + 2] += (rgb[2] - color[o + 2]) * opacity;
  }
}

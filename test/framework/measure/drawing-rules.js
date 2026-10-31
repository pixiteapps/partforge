// Shared drawing rules for measure-mode dimensions: every linear dim must be
// drawn square to its frame. Used by the regression cases here and by every
// later drawing test.
//
// `dim` is one `drawings[i].dims[j]` record from placeDims:
//   { pA, pB, baseA, baseB, ext, dir, ... } — all number[3] in the parts frame.
// dim3-scene draws each extension line from pA toward baseA + ext·offset, so
// the line runs along `ext` only when pA − baseA has no component off `ext`.
import { expect } from "vitest";

export const PARTS_AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

export function expectSquareDim(dim, { frameAxes = PARTS_AXES } = {}) {
  const ext = norm(dim.ext);
  // extension lines run along ext, so they are parallel to each other
  const offA = sub(dim.pA, dim.baseA);
  const offB = sub(dim.pB, dim.baseB);
  expect(len(cross(offA, ext)), "extension line A runs off ext").toBeLessThan(1e-3 * Math.max(1, len(offA)));
  expect(len(cross(offB, ext)), "extension line B runs off ext").toBeLessThan(1e-3 * Math.max(1, len(offB)));
  // ext is perpendicular to the dim line
  expect(Math.abs(dot(norm(dim.dir), ext)), "ext not perpendicular to dir").toBeLessThan(1e-3);
  // the dim plane contains a frame axis: dir or ext is parallel to one of them
  const axes = frameAxes.map(norm);
  expect(
    axes.some((a) => Math.abs(Math.abs(dot(norm(dim.dir), a)) - 1) < 1e-3
      || Math.abs(Math.abs(dot(ext, a)) - 1) < 1e-3),
    "neither dir nor ext lies on a frame axis",
  ).toBe(true);
}

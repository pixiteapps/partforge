// A perspective camera with three.js's conventions (PerspectiveCamera +
// lookAt: vertical fov, right = forward × up, screen y down in pixel space),
// so a pose from style-camera.js lands every vertex where the viewer would.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export function makeCamera(pose, { fov, width, height }) {
  const f = norm(sub(pose.target, pose.position));
  let r = cross(f, pose.up);
  if (Math.hypot(...r) < 1e-9) r = cross(f, [0, 0, 1]);
  r = norm(r);
  const u = cross(r, f);
  const tanH = Math.tan((fov * Math.PI) / 360);
  const aspect = width / height;
  const [px, py, pz] = pose.position;
  return {
    position: pose.position, forward: f, right: r, up: u, tanH, aspect, width, height,
    project(x, y, z) {
      const dx = x - px, dy = y - py, dz = z - pz;
      const vz = dx * f[0] + dy * f[1] + dz * f[2];
      const vx = dx * r[0] + dy * r[1] + dz * r[2];
      const vy = dx * u[0] + dy * u[1] + dz * u[2];
      return [(vx / (vz * tanH * aspect) * 0.5 + 0.5) * width, (0.5 - (vy / (vz * tanH)) * 0.5) * height, vz];
    },
    ray(sx, sy) {
      const nx = (sx / width) * 2 - 1, ny = 1 - (sy / height) * 2;
      return [0, 1, 2].map((i) => f[i] + nx * tanH * aspect * r[i] + ny * tanH * u[i]);
    },
  };
}

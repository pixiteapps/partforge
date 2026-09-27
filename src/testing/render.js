import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { safeName } from "../framework/safe-name.js";
import { ORIENTATIONS } from "../framework/view-angles.js";
import { buildView } from "../framework/oracle/build.js";
import { bounds } from "../framework/oracle/mesh.js";

// Canonical view directions in MODEL space (Z-up). `dir` is the direction from
// the part centre toward the camera; `up` is the camera up vector.
//
// The same seven cameras as the viewer's framework/view-angles.js, which states
// them in the viewer's Y-up WORLD space (the pivot rotates the Z-up model into
// it). The two tables are related by model (x, y, z) → world (x, z, -y), and
// test/render-angles.test.js holds them to that — an agent asking for `left`
// through the CLI and through the browser must be shown the same face.
export const RENDER_ANGLES = {
  iso:    { dir: [1, -1, 1], up: [0, 0, 1] },
  front:  { dir: [0, -1, 0], up: [0, 0, 1] },
  back:   { dir: [0, 1, 0],  up: [0, 0, 1] },
  top:    { dir: [0, 0, 1],  up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  left:   { dir: [-1, 0, 0], up: [0, 0, 1] },
  right:  { dir: [1, 0, 0],  up: [0, 0, 1] },
};
export const RENDER_VIEWS = Object.keys(RENDER_ANGLES);

// The view cube's other orientations (animation camera cues may name them, and
// a still defaults to its cue's angle), mapped from the viewer's Y-up world
// back into model space: world (x, y, z) -> model (x, -z, y).
export function renderAngle(name) {
  if (Object.hasOwn(RENDER_ANGLES, name)) return RENDER_ANGLES[name];
  const o = Object.hasOwn(ORIENTATIONS, name) ? ORIENTATIONS[name] : null;
  if (!o) return null;
  const toModel = ([x, y, z]) => [x, -z, y];
  return { dir: toModel(o.dir), up: toModel(o.up) };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Render canonical-angle PNGs of one view of a part with a pure-JS software
// rasterizer (orthographic, z-buffered, Lambert-shaded, with depth-tested edge
// overlays). No native module, no browser. Returns the written file paths.
// pngjs is lazy-imported so importing the testing barrel for measure never loads it.
//
// `opacity` is a Record<subPartName, number> (an animation's evaluate() output,
// typically): a sub-part at 0 is skipped entirely — faces AND edges — but it
// still counts toward the SCENE BOUNDS, so a part crossing 0 cannot silently
// reframe the still. Framing is a property of the pose, not of what happens to
// be visible: without that, `--at 0,0.5,1` over a fade drew the same base at
// three different scales and the sequence read as a zoom.
// Values in (0,1) fade by PRE-BLENDING that part's shaded base and edge
// colours toward the background. That is a z-buffered approximation: a faded
// part still fully occludes whatever is behind it, because real transparency
// needs back-to-front sorting this rasterizer does not do. Stills only need to
// read as faded, so the approximation is the contract, not a stopgap.
export async function renderViews(kernel, part, view = Object.keys(part.views)[0], {
  views = ["iso", "front", "top"], out = "render", size = [800, 600], edges = true, params = {}, tag = "",
  opacity = {},
} = {}) {
  const { PNG } = await import("pngjs");
  const [W, H] = size;
  // Sub-part names are kept alongside the meshes: opacity is keyed by name.
  // Own-key lookups only — a part named "constructor" must not inherit a value
  // off Object.prototype and vanish from the render.
  const opacityOf = (name) => {
    if (!Object.hasOwn(opacity ?? {}, name)) return 1;
    const v = Number(opacity[name]);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; // a junk value renders solid
  };
  const built = buildView(kernel, part, view, params) // copied out
    .map((b) => ({ name: b.name, mesh: b.mesh }));

  // Scene bounds over EVERY built sub-part, visible or not (positions are
  // JS-owned; safe after cleanup). Opacity is deliberately NOT consulted here —
  // see the note above on why a fade must not move the camera.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { mesh: m } of built) {
    const b = bounds(m.positions);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.min[i]); hi[i] = Math.max(hi[i], b.max[i]); }
  }
  // kernel.cleanup() walks the backend's own tracked list, not this array, so
  // dropping the hidden sub-parts afterwards frees nothing and skips nothing.
  kernel.cleanup?.();

  // …and only the visible ones are rasterized: faces AND edges below iterate this.
  const meshes = built.filter(({ name }) => opacityOf(name) > 0);

  const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const radius = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 5;

  const bg = [0x15, 0x18, 0x1d], base = [0x9f, 0xb4, 0xcc], edgeColor = [0x1c, 0x23, 0x2d];
  const ambient = 0.35, diffuse = 0.75;
  const bias = radius * 0.02;           // edge depth bias so visible edges win ties

  // `out` is operator-supplied (a CLI flag) and stays verbatim; the part-derived
  // title and view key are sanitized, since this is the one place a part's
  // strings reach the filesystem.
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const name = safeName(part.meta?.title ?? view);
  const viewName = safeName(view);
  const written = [];

  for (const angle of views) {
    const a = renderAngle(angle);
    if (!a) throw new Error(`unknown angle "${angle}" (use: ${RENDER_VIEWS.join(", ")}, or a view-cube orientation such as top-front-left)`);
    // orthographic camera basis: zc toward camera, xc right, yc up
    const zc = norm(a.dir), xc = norm(cross(a.up, zc)), yc = cross(zc, xc);
    // Key direction (toward the light), placed over the viewer's shoulder — up and to
    // the right of the view axis — so every angle is lit and shaded. A world-fixed key
    // would leave whichever face the camera happens to be looking at in flat ambient:
    // that is what made `bottom` a featureless disc, and the browser viewer's offscreen
    // captures had the same bug (framework/viewer-lighting.js captureLightPoses).
    const light = norm([0, 1, 2].map((i) => zc[i] + 0.45 * xc[i] + 0.75 * yc[i]));
    const ppu = Math.min(W, H) / (2 * radius * 1.25); // pixels per mm (uniform; margin)
    const project = (p) => {
      const r = sub(p, center);
      return [W / 2 + dot(r, xc) * ppu, H / 2 - dot(r, yc) * ppu, dot(r, zc)]; // [sx, sy, depth]
    };

    const color = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { color[i * 3] = bg[0]; color[i * 3 + 1] = bg[1]; color[i * 3 + 2] = bg[2]; }
    const zbuf = new Float32Array(W * H).fill(-Infinity); // larger depth = nearer camera

    for (const { name, mesh: m } of meshes) {
      // Pre-blend toward the background: the fade is baked into the material
      // colour before shading, so no per-pixel compositing (and no depth sort)
      // is needed. See the note on renderViews for why that is enough here.
      const v = opacityOf(name);
      const faded = v < 1 ? base.map((c, i) => Math.round(c * v + bg[i] * (1 - v))) : base;
      const P = m.positions, N = m.normals, ind = m.indices;
      // Manifold meshes are a non-indexed soup (3 consecutive verts/triangle);
      // OCCT meshes are indexed. Both carry per-vertex normals.
      const triCount = ind?.length ? ind.length / 3 : P.length / 9;
      for (let t = 0; t < triCount; t++) {
        const ai = ind?.length ? ind[t * 3] * 3 : t * 9;
        const bi = ind?.length ? ind[t * 3 + 1] * 3 : t * 9 + 3;
        const ci = ind?.length ? ind[t * 3 + 2] * 3 : t * 9 + 6;
        const va = [P[ai], P[ai + 1], P[ai + 2]], vb = [P[bi], P[bi + 1], P[bi + 2]], vc = [P[ci], P[ci + 1], P[ci + 2]];
        const sp = [va, vb, vc].map(project);
        let inten;
        if (N?.length) {
          // per-vertex normals (same layout/offset as positions)
          inten = [ai, bi, ci].map((o) =>
            Math.min(1, ambient + diffuse * Math.max(0, N[o] * light[0] + N[o + 1] * light[1] + N[o + 2] * light[2])));
        } else {
          // no normals → flat face normal, two-sided so it lights regardless of winding
          const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
          const wx = vc[0] - va[0], wy = vc[1] - va[1], wz = vc[2] - va[2];
          const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
          const L = Math.hypot(nx, ny, nz) || 1;
          const I0 = Math.min(1, ambient + diffuse * Math.abs((nx * light[0] + ny * light[1] + nz * light[2]) / L));
          inten = [I0, I0, I0];
        }
        rasterTri(sp, inten, faded, color, zbuf, W, H);
      }
    }

    if (edges) {
      for (const { name, mesh: m } of meshes) {
        const E = m.edges;
        if (!E?.length) continue;
        const v = opacityOf(name);
        const fadedEdge = v < 1 ? edgeColor.map((c, i) => Math.round(c * v + bg[i] * (1 - v))) : edgeColor;
        for (let i = 0; i < E.length; i += 6)
          drawLine(project([E[i], E[i + 1], E[i + 2]]), project([E[i + 3], E[i + 4], E[i + 5]]), fadedEdge, color, zbuf, W, H, bias);
      }
    }

    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) {
      png.data[i * 4] = color[i * 3]; png.data[i * 4 + 1] = color[i * 3 + 1]; png.data[i * 4 + 2] = color[i * 3 + 2]; png.data[i * 4 + 3] = 255;
    }
    // The animation frame tag goes through safeName() as well — one rule for
    // every string that reaches a filename here.
    const file = join(out, `${name}-${viewName}-${angle}${tag ? `-${safeName(tag)}` : ""}.png`);
    // Belt and braces over safeName(): assert the escape never happened rather
    // than trusting the slug, because a miss here writes bytes to disk. (The
    // returned paths stay relative to `out` — the CLI echoes them.)
    if (!resolve(file).startsWith(outDir + sep)) throw new Error(`renderViews: refusing to write outside ${out}`);
    writeFileSync(file, PNG.sync.write(png));
    written.push(file);
  }
  return written;
}

// signed area of the 2-D edge from a to b evaluated at p (for barycentric coords)
const edgeFn = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

// Fill one projected triangle, z-buffered, with Gouraud-interpolated Lambert shading.
function rasterTri(sp, inten, base, color, zbuf, W, H) {
  const [a, b, c] = sp;
  const area = edgeFn(a, b, c);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const w0 = edgeFn(b, c, p), w1 = edgeFn(c, a, p), w2 = edgeFn(a, b, p);
      // inside if all the same sign (handle either winding from the projection)
      if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
      const l0 = w0 / area, l1 = w1 / area, l2 = w2 / area;
      const depth = l0 * a[2] + l1 * b[2] + l2 * c[2];
      const idx = y * W + x;
      if (depth <= zbuf[idx]) continue;
      zbuf[idx] = depth;
      const I = l0 * inten[0] + l1 * inten[1] + l2 * inten[2];
      color[idx * 3] = Math.min(255, base[0] * I);
      color[idx * 3 + 1] = Math.min(255, base[1] * I);
      color[idx * 3 + 2] = Math.min(255, base[2] * I);
    }
  }
}

// Depth-tested line for edge overlays: drawn only where it isn't behind the
// surface (within `bias`), so the silhouette and feature edges read as crisp lines.
function drawLine(p0, p1, col, color, zbuf, W, H, bias) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1]))));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(p0[0] + (p1[0] - p0[0]) * t), y = Math.round(p0[1] + (p1[1] - p0[1]) * t);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const depth = p0[2] + (p1[2] - p0[2]) * t;
    const idx = y * W + x;
    if (depth + bias < zbuf[idx]) continue; // occluded
    color[idx * 3] = col[0]; color[idx * 3 + 1] = col[1]; color[idx * 3 + 2] = col[2];
  }
}

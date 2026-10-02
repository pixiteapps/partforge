import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { safeName } from "../framework/safe-name.js";
import { ORIENTATIONS } from "../framework/view-angles.js";
import { buildView } from "../framework/oracle/build.js";
import { renderStyled } from "../framework/softrender/index.js";

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


// Render canonical-angle PNGs of one view of a part, in memory, through the
// styled CPU renderer (framework/softrender) — the same look the viewer's
// offscreen captures have (`style`: "cad" for the agent's renders, "thumbnail"
// for the product shot). No native module, no browser. pngjs is lazy-imported
// so importing the testing barrel for measure never loads it.
//
// `opacity` is a Record<subPartName, number> (an animation's evaluate()
// output, typically): a sub-part at 0 draws nothing — faces, edges, shadow —
// but still counts toward the FRAMING, so a part crossing 0 cannot silently
// reframe the still. Values in (0,1) PRE-BLEND toward the background: a faded
// part still occludes what is behind it (real transparency needs a depth sort
// this renderer does not do; stills only need to read as faded).
export async function renderViewImages(kernel, part, view = Object.keys(part.views)[0], {
  views = ["iso", "front", "top"], size = [800, 600], edges = true, params = {}, opacity = {},
  style = "cad", supersample = 2,
} = {}) {
  const { PNG } = await import("pngjs");
  for (const angle of views) {
    if (!renderAngle(angle)) throw new Error(`unknown angle "${angle}" (use: ${RENDER_VIEWS.join(", ")}, or a view-cube orientation such as top-front-left)`);
  }
  // Own-key lookups only — a part named "constructor" must not inherit a value
  // off Object.prototype and vanish from the render.
  const opacityOf = (name) => {
    if (!Object.hasOwn(opacity ?? {}, name)) return 1;
    const v = Number(opacity[name]);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; // a junk value renders solid
  };
  const subparts = buildView(kernel, part, view, params) // meshes are JS-owned: safe after cleanup
    .map((b) => ({ name: b.name, mesh: b.mesh, display: part.parts?.[b.name]?.display, opacity: opacityOf(b.name) }));
  kernel.cleanup?.();
  return views.map((angle) => {
    const img = renderStyled(subparts, { view: angle, style, size, supersample, edges });
    const png = new PNG({ width: img.width, height: img.height });
    png.data.set(img.rgba);
    return { angle, png: PNG.sync.write(png) };
  });
}

// renderViewImages, written to disk as `<title>-<view>-<angle>[-<tag>].png`
// under `out`. Returns the written paths (relative to `out`, as the CLI echoes them).
export async function renderViews(kernel, part, view = Object.keys(part.views)[0], opts = {}) {
  const { out = "render", tag = "", ...rest } = opts;
  const images = await renderViewImages(kernel, part, view, rest);
  // `out` is operator-supplied (a CLI flag) and stays verbatim; the part-derived
  // title, view key and frame tag are sanitized — the one place a part's
  // strings reach the filesystem.
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const name = safeName(part.meta?.title ?? view);
  const viewName = safeName(view);
  return images.map(({ angle, png }) => {
    const file = join(out, `${name}-${viewName}-${angle}${tag ? `-${safeName(tag)}` : ""}.png`);
    // Belt and braces over safeName(): assert the escape never happened.
    if (!resolve(file).startsWith(outDir + sep)) throw new Error(`renderViews: refusing to write outside ${out}`);
    writeFileSync(file, png);
    return file;
  });
}

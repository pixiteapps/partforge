// test/softrender-render.test.js
import { describe, expect, it } from "vitest";
import { renderStyled } from "../src/framework/softrender/index.js";
import { RENDER_STYLES } from "../src/framework/renderStyles.js";

// An axis-aligned box in MODEL space (Z-up), as indexed triangles with flat
// per-face normals (24 vertices) and its 12 edges.
function cube(s = 10, z0 = 0) {
  const faces = [
    [[1, 0, 0], [[s, -s, z0], [s, s, z0], [s, s, z0 + 2 * s], [s, -s, z0 + 2 * s]]],
    [[-1, 0, 0], [[-s, s, z0], [-s, -s, z0], [-s, -s, z0 + 2 * s], [-s, s, z0 + 2 * s]]],
    [[0, 1, 0], [[s, s, z0], [-s, s, z0], [-s, s, z0 + 2 * s], [s, s, z0 + 2 * s]]],
    [[0, -1, 0], [[-s, -s, z0], [s, -s, z0], [s, -s, z0 + 2 * s], [-s, -s, z0 + 2 * s]]],
    [[0, 0, 1], [[-s, -s, z0 + 2 * s], [s, -s, z0 + 2 * s], [s, s, z0 + 2 * s], [-s, s, z0 + 2 * s]]],
    [[0, 0, -1], [[-s, s, z0], [s, s, z0], [s, -s, z0], [-s, -s, z0]]],
  ];
  const positions = [], normals = [], indices = [];
  faces.forEach(([n, q], f) => {
    for (const v of q) { positions.push(...v); normals.push(...n); }
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  const e = [];
  for (const [, q] of faces.slice(0, 2)) for (let i = 0; i < 4; i++) e.push(...q[i], ...q[(i + 1) % 4]);
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), edges: new Float32Array(e) };
}
const px = (img, x, y) => [...img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const countNot = (img, bg, tol = 6) => {
  let n = 0;
  for (let i = 0; i < img.rgba.length; i += 4) if (!near([img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]], bg, tol)) n++;
  return n;
};

describe("renderStyled", () => {
  it("returns an opaque RGBA image of the requested size on the style background", () => {
    const img = renderStyled([{ name: "a", mesh: cube() }], { view: "iso", style: "cad", size: [96, 64] });
    expect([img.width, img.height, img.rgba.length]).toEqual([96, 64, 96 * 64 * 4]);
    expect(near(px(img, 0, 0), hex(RENDER_STYLES.cad.background), 1)).toBe(true);
    expect(img.rgba[3]).toBe(255);
    expect(countNot(img, hex(RENDER_STYLES.cad.background))).toBeGreaterThan(500);
  });

  it("the part is centred", () => {
    const img = renderStyled([{ name: "a", mesh: cube() }], { view: "front", style: "cad", size: [64, 64] });
    expect(near(px(img, 32, 32), hex(RENDER_STYLES.cad.background))).toBe(false);
  });

  it("antialiases: the silhouette has in-between pixels", () => {
    const img = renderStyled([{ name: "a", mesh: { ...cube(2), edges: undefined } }], { view: "iso", style: "cad", size: [64, 64], edges: false });
    const bg = hex(RENDER_STYLES.cad.background);
    const values = new Set();
    for (let x = 0; x < 64; x++) values.add(px(img, x, 32).join());
    expect(values.size).toBeGreaterThan(4);
    expect(near(px(img, 0, 32), bg)).toBe(true);
  });

  it("edges darken the pixels they cross", () => {
    const withE = renderStyled([{ name: "a", mesh: cube() }], { view: "iso", size: [128, 128] });
    const noE = renderStyled([{ name: "a", mesh: cube() }], { view: "iso", size: [128, 128], edges: false });
    let darker = 0;
    for (let i = 0; i < withE.rgba.length; i += 4) if (withE.rgba[i] + 20 < noE.rgba[i]) darker++;
    expect(darker).toBeGreaterThan(50);
  });

  it("thumbnail: fixed iso view, light background, a shadow darker than the background under the part", () => {
    const img = renderStyled([{ name: "a", mesh: cube() }], { style: "thumbnail", size: [160, 160] });
    expect(img.view).toBe("iso");
    const bg = hex(RENDER_STYLES.thumbnail.background);
    expect(near(px(img, 0, 0), bg, 1)).toBe(true);
    let shadowed = 0;
    for (let i = 0; i < img.rgba.length; i += 4) {
      const p = [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
      if (p.every((v, k) => v < bg[k] - 2 && v > bg[k] - 60)) shadowed++;
    }
    expect(shadowed).toBeGreaterThan(30);
  });

  it("per-sub-part display colour overrides the style material", () => {
    const red = renderStyled([{ name: "a", mesh: cube(), display: { color: 0xff0000 } }], { view: "front", size: [32, 32], edges: false });
    const [r, g, b] = px(red, 16, 16);
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 40);
  });

  it("hidden sub-parts frame but don't draw or cast (Review Focus 3)", () => {
    const both = renderStyled([{ name: "a", mesh: cube(5) }, { name: "b", mesh: cube(5, 40), opacity: 0 }], { view: "front", style: "thumbnail", size: [64, 64] });
    const alone = renderStyled([{ name: "a", mesh: cube(5) }], { view: "front", style: "thumbnail", size: [64, 64] });
    const bg = hex(RENDER_STYLES.thumbnail.background);
    expect(countNot(both, bg)).toBeLessThan(countNot(alone, bg)); // smaller in frame: b still framed
    const allHidden = renderStyled([{ name: "a", mesh: cube(), opacity: 0 }], { view: "iso", style: "thumbnail", size: [32, 32] });
    expect(countNot(allHidden, bg, 1)).toBe(0);
  });

  it("half opacity pre-blends toward the background", () => {
    const full = renderStyled([{ name: "a", mesh: cube() }], { view: "front", size: [32, 32], edges: false });
    const half = renderStyled([{ name: "a", mesh: cube(), opacity: 0.5 }], { view: "front", size: [32, 32], edges: false });
    const bg = hex(RENDER_STYLES.cad.background);
    const f = px(full, 16, 16)[0], h = px(half, 16, 16)[0];
    expect(Math.abs(h - bg[0])).toBeLessThan(Math.abs(f - bg[0]));
  });

  it("renders a 0.5 mm part and a 2000 mm part the same way under fit framing (Review Focus 2)", () => {
    // fit framing is scale-free, so the two must fill the frame alike; cad's
    // canonical distance carries the viewer's fixed +6 mm, so there a tiny part
    // is legitimately smaller — it only has to be visibly drawn.
    const counts = [0.25, 1000].map((s) => {
      const img = renderStyled([{ name: "a", mesh: cube(s) }], { style: "thumbnail", size: [96, 96] });
      return countNot(img, hex(RENDER_STYLES.thumbnail.background), 10);
    });
    expect(Math.abs(counts[0] - counts[1]) / counts[1]).toBeLessThan(0.05);
    const tinyCad = renderStyled([{ name: "a", mesh: cube(0.25) }], { view: "iso", size: [96, 96] });
    expect(countNot(tinyCad, hex(RENDER_STYLES.cad.background))).toBeGreaterThan(20);
  });

  it("degenerate input renders the background without throwing (Review Focus 1)", () => {
    const flat = { positions: new Float32Array([-5, -5, 0, 5, -5, 0, 5, 5, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) };
    expect(() => renderStyled([{ name: "f", mesh: flat }], { style: "thumbnail", size: [32, 32] })).not.toThrow();
    const empty = renderStyled([], { style: "cad", size: [16, 16] });
    expect(countNot(empty, hex(RENDER_STYLES.cad.background), 1)).toBe(0);
  });
});

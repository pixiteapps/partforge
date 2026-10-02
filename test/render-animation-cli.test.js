// CLI animation stills: --params passthrough, --animation/--at frame naming,
// --step targeting, cue-derived default views, cross-view --animation
// resolution, and opacity fades in the headless rasterizer.
//
// The fixture declares its animations under VIEWS (test/fixtures/animated-part.js):
// `open`/`assemble` live in "assembly", which is NOT the default (first-declared)
// view, so the view an animation resolves to is visible in the written filenames.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { renderViews } from "../src/testing/render.js";
import animatedPart from "./fixtures/animated-part.js";
import { RENDER_STYLES } from "../src/framework/renderStyles.js";
const CAD_BG = [(RENDER_STYLES.cad.background >> 16) & 255, (RENDER_STYLES.cad.background >> 8) & 255, RENDER_STYLES.cad.background & 255];

const PART = "test/fixtures/animated-part.js";
const AMBIGUOUS = "test/fixtures/animated-ambiguous-part.js";

const cli = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });
const out = () => mkdtempSync(join(tmpdir(), "pf-anim-render-"));

test("--params renders at the given params", () => {
  const dir = out();
  cli(["render", PART, "--views", "iso", "--out", dir, "--params", '{"lidAngle":90}']);
  expect(readdirSync(dir)).toEqual(["anim-box-box-iso.png"]);
});

test("--animation --at writes tagged frames, defaulting views to the governing cue", () => {
  const dir = out();
  cli(["render", PART, "--out", dir, "--animation", "open", "--at", "0,0.5,1"]);
  // open's cue is "front" at t=0 → governs every t
  expect(readdirSync(dir).sort()).toEqual([
    "anim-box-assembly-front-open-t000.png",
    "anim-box-assembly-front-open-t050.png",
    "anim-box-assembly-front-open-t100.png",
  ]);
});

test("--step renders the end of the named step at its cue view", () => {
  const dir = out();
  cli(["render", PART, "--out", dir, "--animation", "assemble", "--step", "Lower the lid"]);
  expect(readdirSync(dir)).toEqual(["anim-box-assembly-left-assemble-step1.png"]);
});

test("--at without --animation fails loudly", () => {
  expect(() => cli(["render", PART, "--at", "0.5"])).toThrow();
});

// --- the flags fail loudly rather than rendering something unasked-for --------
// bin/cli.js's header promises a typo'd flag "fails loudly instead of being
// silently ignored"; these are the cases where it previously didn't.

// Returns { code, stdout, stderr } instead of throwing, so a rejection can be asserted on.
const cliFails = (args) => {
  try {
    const stdout = execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
};

test("an empty --animation is rejected, not treated as absent", () => {
  const dir = out();
  // `--animation ""` is the shape an unset shell variable produces. Falsiness made
  // it indistinguishable from omitting the flag, so it rendered a plain still.
  const r = cliFails(["render", PART, "--views", "iso", "--out", dir, "--animation", ""]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/--animation needs an animation name/);
  expect(readdirSync(dir)).toEqual([]);
});

test("--at rejects an empty entry instead of rendering it as t=0", () => {
  const dir = out();
  const r = cliFails(["render", PART, "--out", dir, "--animation", "open", "--at", "0.2,,0.8"]);
  expect(r.code).toBe(1); // Number("") is 0, which passed the 0..1 range check
  expect(r.stderr).toMatch(/--at takes comma-separated positions/);
  expect(readdirSync(dir)).toEqual([]);
});

test("--at and --step together is a conflict, not a silent preference", () => {
  const dir = out();
  const r = cliFails(["render", PART, "--out", dir,
    "--animation", "assemble", "--at", "0.5", "--step", "1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/--at and --step are alternatives/);
});

test("--at positions closer than the tag's precision still get one file each", () => {
  const dir = out();
  // At two decimals 0.001 and 0.004 both tag "t000", and the second render
  // silently overwrote the first — one file for two requested frames. The tag
  // widens for this request rather than the request being refused.
  cli(["render", PART, "--out", dir, "--animation", "open", "--at", "0.001,0.004"]);
  expect(readdirSync(dir).sort()).toEqual([
    "anim-box-assembly-front-open-t0001.png",
    "anim-box-assembly-front-open-t0004.png",
  ]);
});

test("the usual positions keep their two-decimal names", () => {
  const dir = out();
  // Widening must be scoped to the request that needs it: a plain run must not
  // have its filenames churned.
  cli(["render", PART, "--out", dir, "--animation", "open", "--at", "0,0.5,1"]);
  expect(readdirSync(dir).sort()).toEqual([
    "anim-box-assembly-front-open-t000.png",
    "anim-box-assembly-front-open-t050.png",
    "anim-box-assembly-front-open-t100.png",
  ]);
});

test("the same --at position listed twice is rejected", () => {
  const dir = out();
  const r = cliFails(["render", PART, "--out", dir,
    "--animation", "open", "--at", "0.5,0.5"]);
  expect(r.code).toBe(1); // no precision separates them
  expect(r.stderr).toMatch(/same position more than once/);
});

test("--params must be a JSON object", () => {
  const dir = out();
  for (const bad of ["[1,2]", "42", '"hi"', "null"]) {
    const r = cliFails(["render", PART, "--views", "iso", "--out", dir, "--params", bad]);
    expect(r.code, `--params ${bad}`).toBe(1);
    expect(r.stderr).toMatch(/--params takes a JSON object/);
  }
});

test("an unknown positional view is rejected, not rendered blank", () => {
  const dir = out();
  // viewSubParts returns nothing for an unknown view, so this used to write
  // background-only PNGs with the bogus name baked in, and exit 0.
  const r = cliFails(["render", PART, "notaview", "--views", "iso", "--out", dir]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/unknown view "notaview"/);
  expect(readdirSync(dir)).toEqual([]);
});

test("a view named after an Object.prototype member is rejected too", () => {
  // `part.views?.["constructor"]` resolves through the prototype chain, so a
  // plain truthiness lookup waved these straight back into the blank render the
  // guard exists to stop.
  for (const view of ["constructor", "toString", "__proto__", "valueOf"]) {
    const dir = out();
    const r = cliFails(["render", PART, view, "--views", "iso", "--out", dir]);
    expect(r.code, `view: ${view}`).toBe(1);
    expect(r.stderr, `view: ${view}`).toMatch(/unknown view/);
    expect(readdirSync(dir), `view: ${view}`).toEqual([]);
  }
});

// --- cross-view --animation resolution ---------------------------------------
// Animations belong to a view now, so `--animation` has to find its owner. The
// disambiguator is the existing POSITIONAL view argument — `--views` still means
// camera angles, and no `--view` flag exists.

test("--animation resolves its owning view when the name is unique", () => {
  const dir = out();
  // "open" lives in view "assembly", NOT the default view ("box"), and the
  // written filenames carry the view slug — assert the owner's, not the default's.
  const stdout = cli(["render", PART, "--animation", "open", "--at", "1", "--out", dir]);
  expect(stdout).toMatch(/-assembly-/);
  expect(stdout).not.toMatch(/anim-box-box-/);
});

test("--animation with a name shared by two views demands the positional view", () => {
  const dir = out();
  const r = cliFails(["render", AMBIGUOUS, "--animation", "shared", "--out", dir]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/ambiguous/i);
  expect(r.stderr).toMatch(/positional/i);
  expect(readdirSync(dir)).toEqual([]);
});

test("the positional view picks one of two same-named animations", () => {
  const dir = out();
  cli(["render", AMBIGUOUS, "detail", "--animation", "shared", "--views", "iso", "--out", dir]);
  expect(readdirSync(dir)).toEqual(["ambiguous-anim-detail-iso-shared-t100.png"]);
});

test("positional view + --animation not in that view is an error naming the owner", () => {
  const dir = out();
  const r = cliFails(["render", PART, "box", "--animation", "open", "--out", dir]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/view "assembly"/);
  expect(readdirSync(dir)).toEqual([]);
});

test("an unknown animation is reported with the declared names", () => {
  const dir = out();
  const r = cliFails(["render", PART, "--animation", "nope", "--out", dir]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/unknown animation "nope"/);
  expect(r.stderr).toMatch(/cycle/);
  expect(r.stderr).toMatch(/assemble/);
});

// --- opacity in the headless rasterizer --------------------------------------

test("the CLI hands the animation's opacity to the renderer", async () => {
  // The integration seam this task adds: bin/cli.js must pass evaluate()'s
  // `opacity` into renderViews. Nothing else about the frame changes, so the
  // CLI's PNG is compared byte-for-byte against direct renders of the same
  // pose — once with the lid hidden, once with it drawn. Drop `opacity` from
  // the CLI call and the frame becomes the "drawn" one, flipping both asserts.
  //
  // A byte comparison rather than a luminance one because it pins the seam
  // exactly: the CLI frame must BE the hidden render, not merely resemble it.
  const dir = out();
  // assemble's step 1 at t=0: lidLift 40, and its opacity track puts the lid at 0.
  cli(["render", PART, "--animation", "assemble", "--at", "0", "--views", "front", "--out", dir]);
  const cliFile = join(dir, "anim-box-assembly-front-assemble-t000.png");

  const kernel = await bootManifoldKernel();
  const opts = { views: ["front"], out: dir, params: { lidLift: 40 } };
  const [hidden] = await renderViews(kernel, animatedPart, "assembly", { ...opts, tag: "seam-hidden", opacity: { lid: 0 } });
  const [drawn] = await renderViews(kernel, animatedPart, "assembly", { ...opts, tag: "seam-drawn", opacity: {} });

  const pixels = (f) => PNG.sync.read(readFileSync(f)).data;
  expect(Buffer.compare(pixels(cliFile), pixels(hidden))).toBe(0);
  expect(Buffer.compare(pixels(cliFile), pixels(drawn))).not.toBe(0);
});

test("a still mid-fade renders the faded part dimmer; at opacity 0 it is absent", async () => {
  // Bypasses the CLI: calls renderViews directly with an opacity map and
  // compares total ink (distance from the background) — absent < faded < full. This pins
  // the renderViews contract the CLI feeds evaluate()'s opacity into.
  const kernel = await bootManifoldKernel();
  const dir = out();
  const luminance = (file) => {
    const png = PNG.sync.read(readFileSync(file));
    let sum = 0;
    // Ink = distance from the (light) background, so absent < faded < full holds for any background.
    for (let i = 0; i < png.data.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(png.data[i + c] - CAD_BG[c]);
    return sum;
  };
  const opts = { views: ["front"], out: dir, size: [200, 150] };
  const [hidden] = await renderViews(kernel, animatedPart, "assembly", { ...opts, tag: "o0", opacity: { lid: 0 } });
  const [faded] = await renderViews(kernel, animatedPart, "assembly", { ...opts, tag: "o5", opacity: { lid: 0.5 } });
  const [full] = await renderViews(kernel, animatedPart, "assembly", { ...opts, tag: "o1", opacity: {} });
  expect(luminance(hidden)).toBeLessThan(luminance(faded));
  expect(luminance(faded)).toBeLessThan(luminance(full));
});

test("a sub-part fading through 0 does not reframe the still", async () => {
  // Scene bounds used to be computed AFTER the opacity>0 filter, so the frame a
  // fading part vanished on was framed from the survivors alone and drew them
  // ~10% larger than the neighbouring frames — `--at 0,0.5,1` over a fade read
  // as a zoom. Bounds now cover every built sub-part, visible or not.
  //
  // The fixture at lidLift 40 puts the lid (model z 64..66) well clear of the
  // base (z 0..24), and the `front` camera maps model +Z to screen up — so the
  // base owns the bottom half of the frame in both renders and the lid owns
  // none of it. Identical framing therefore means identical base pixels there;
  // a rescaled base moves its ink box by tens of pixels.
  const kernel = await bootManifoldKernel();
  const dir = out();
  const opts = { views: ["front"], out: dir, size: [200, 150], params: { lidLift: 40 } };
  const [hidden] = await renderViews(kernel, animatedPart, "assembly", { ...opts, tag: "frame-hidden", opacity: { lid: 0 } });
  const [drawn] = await renderViews(kernel, animatedPart, "assembly", { ...opts, tag: "frame-drawn", opacity: {} });

  // Bounding box of non-background pixels in the bottom half of the image.
  const bg = CAD_BG;
  const lowerInkBox = (file) => {
    const png = PNG.sync.read(readFileSync(file));
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (let y = png.height >> 1; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        if (png.data[i] === bg[0] && png.data[i + 1] === bg[1] && png.data[i + 2] === bg[2]) continue;
        box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
      }
    }
    return box;
  };

  const hiddenBox = lowerInkBox(hidden);
  expect(Number.isFinite(hiddenBox.minX)).toBe(true); // the base really is down there
  expect(hiddenBox).toEqual(lowerInkBox(drawn));
});

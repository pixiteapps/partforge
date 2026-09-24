// Type-level tests for the shipped declarations. Not a vitest suite: `npm run
// typecheck` compiles this file, and every `@ts-expect-error` below must be a
// real error (tsc fails the build if one of them stops erroring), so this
// doubles as a test that the types actually REJECT malformed input.
//
// Everything imports through the package's own subpath specifiers, so this also
// proves the `exports` map's `types` conditions resolve.

import { mount } from "partforge";
import type {
  AnimationRuntime,
  AnimationSpec,
  AnimationState,
  AnimationStep,
  ControlDef,
  ExpectMap,
  GeometryKernel,
  MountOptions,
  ParameterSection,
  PartDefinition,
  PartRuntime,
  Shape2D,
  Solid,
  SubPartDefinition,
} from "partforge";
import { circleProfile, offsetPolygon, pathProfile, roundedProfile, roundedRectPolygon, circularPattern } from "partforge/geometry";
import type { ArcContour, Region2D } from "partforge/geometry";
import { resolveDerived } from "partforge/derive";
import { lintPart, RULES } from "partforge/lint";
import { runWorker } from "partforge/worker";
import {
  assemblyOverlaps,
  bootManifoldKernel,
  buildBVH,
  buildView,
  matchMasks,
  matchViews,
  MATCH_VIEWS,
  measure,
  minWall,
  rasterizeMeshMask,
  rasterizeRingsMask,
  relevantParamKeys,
  RELEVANT_ALL,
  verify,
} from "partforge/testing";
import type { SilhouetteMask } from "partforge/testing";

// A tiny assertion helper: `expectType<T>(value)` fails to compile unless
// `value` is assignable to `T`.
declare function expectType<T>(value: T): void;

// ---------------------------------------------------------------------------
// 1. A real PartDefinition typechecks.
// ---------------------------------------------------------------------------

const spacer = {
  meta: { title: "Spacer", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "body",
      title: "Body",
      description: "The spacer barrel and its through-bore.",
      presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } },
      advanced: [
        { key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 },
        { key: "bore", label: "Bore", unit: "mm", min: 1, max: 30, step: 0.1, control: "number" },
        { key: "h", label: "Height", unit: "mm", min: 2, max: 60, step: 1 },
        { key: "flange_h", min: 1, max: 5, step: 0.5, hidden: true },
      ],
    },
    {
      id: "flange",
      title: "Flange",
      features: [
        {
          label: "Base flange",
          key: "flange_d",
          on: 16,
          sliders: [{ key: "flange_d", label: "Flange diameter", unit: "mm", min: 8, max: 50, step: 1 }],
        },
      ],
    },
    {
      id: "shape",
      title: "Shape ops",
      toggles: [{ key: "clip", label: "Clip arms to a disc", on: 1 }],
    },
  ],
  defaults: { od: 8, bore: 3.4, h: 10, flange_d: 0, flange_h: 2, clip: 0, note: "" },
  derive: (p) => ({ boreR: (p.bore + 0.2) / 2, cutH: p.h + 4 }),
  parts: {
    spacer: {
      label: "Spacer",
      views: ["spacer"],
      export: { name: "spacer" },
      display: { color: 0x9fb4cc, opacity: 0.6 },
      exportable: true,
      enabled: (p) => p.h > 0,
      build: (k, p, d, onProgress) => {
        onProgress?.("barrel");
        let s: Solid = k.cylinder({ d: p.od, h: p.h });
        if (p.flange_d > 0) s = s.union(k.cylinder({ d: p.flange_d, h: p.flange_h }));
        return s.cut(k.cylinder({ r: d.boreR, h: d.cutH }).at([0, 0, -2]).label("Bore"));
      },
      place: (solid, { purpose }) => (purpose === "export" ? solid.rotateX(90) : solid),
    },
  },
  views: { spacer: { label: "Spacer" } },
  verify: {
    process: "fdm-pla",
    cases: ["defaults", "M3"],
    expect: {
      spacer: { holes: 1, bbox: "<=[60,60,60]", minWall: { expr: ">=1.2", hint: "raise `od`" } },
      _view: { overlaps: 0, contacts: [["spacer", "flange"]], clearance: { "spacer×flange": ">=0.3" } },
    },
  },
} satisfies PartDefinition;

// The grouped `derive` form, and `expect` as a function of the case's params.
const grouped = {
  meta: { title: "Grouped" },
  parameters: [],
  defaults: { dia: 70, drain: 8 },
  derive: {
    core: (p) => ({ r: p.dia / 2 }),
    stand: (p, d) => ({ postH: d.r * 4 }),
  },
  parts: {
    body: { views: ["main"], build: (k, p, d) => k.cylinder({ r: d.r, h: d.postH }) },
  },
  views: { main: { label: "Main" } },
  verify: { expect: (p) => ({ body: { holes: p.drain > 0 ? 1 : 0 } }) },
} satisfies PartDefinition;

expectType<PartDefinition>(spacer);
expectType<PartDefinition>(grouped);

// A sub-part and a control descriptor are usable standalone.
expectType<SubPartDefinition>(spacer.parts.spacer);
expectType<ControlDef>({ key: "od", min: 0, max: 1, step: 0.1 });
// Both animation forms: one anonymous step (`tracks`), and a step list.
expectType<AnimationSpec>({ duration: 1.2, easing: "ease-in-out", camera: "front", tracks: { h: [[0, 0], [1, 10]] } });
expectType<AnimationSpec>({ label: "Assemble", steps: [{ label: "Lower", duration: 1, camera: "left", tracks: { h: [[0, 40], [1, 0]] } }] });
expectType<ExpectMap>({ _view: { overlaps: 0 }, body: { volume: "0.4..0.6cm3" } });

// ---------------------------------------------------------------------------
// 2. Malformed parts are REJECTED.
// ---------------------------------------------------------------------------

// meta.title is required (lint errors without it, so the type does too).
// @ts-expect-error - meta is missing `title`
const noTitle: PartDefinition = { ...spacer, meta: { units: "mm" } };
void noTitle;

// A `features` entry without `sliders` throws in the control panel.
const noSliders: PartDefinition = {
  ...spacer,
  parameters: [
    // @ts-expect-error - a feature must carry a `sliders` array; a bare on/off control belongs in `toggles`
    { id: "flange", title: "Flange", features: [{ key: "flange_d", label: "Base flange", on: 16 }] },
  ],
};
void noSliders;

// A sub-part must declare `views` and `build`.
const noViews: PartDefinition = {
  ...spacer,
  // @ts-expect-error - sub-part is missing `views`
  parts: { spacer: { build: (k) => k.sphere({ r: 1 }) } },
};
void noViews;

const noBuild: PartDefinition = {
  ...spacer,
  // @ts-expect-error - sub-part is missing `build`
  parts: { spacer: { views: ["spacer"] } },
};
void noBuild;

// `build` must return a Solid, not a Shape2D.
const buildReturnsShape: PartDefinition = {
  ...spacer,
  parts: {
    // @ts-expect-error - `build` must return a Solid; a Shape2D needs extruding first
    spacer: { views: ["spacer"], build: (k) => k.shape2d(circleProfile(4)) },
  },
};
void buildReturnsShape;

// An unknown metric name in `verify.expect` never runs (verify throws on it).
const badMetric: PartDefinition = {
  ...spacer,
  // @ts-expect-error - "genus" is not a verify metric (it is spelled `holes`)
  verify: { expect: { spacer: { genus: 1 } } },
};
void badMetric;

// `contacts` is a list of PAIRS, not a flat list of names.
const badContacts: PartDefinition = {
  ...spacer,
  // @ts-expect-error - each `contacts` entry must be an ["a", "b"] pair
  verify: { expect: { _view: { contacts: ["spacer", "flange"] } } },
};
void badContacts;

// An unrecognised control field is ignored by the panel (lint warns).
const badControlField: PartDefinition = {
  ...spacer,
  parameters: [
    // @ts-expect-error - "labl" is not a control field
    { id: "body", title: "Body", advanced: [{ key: "od", labl: "Outer diameter" }] },
  ],
};
void badControlField;

// ---------------------------------------------------------------------------
// 3. mount() — options and the runtime handle.
// ---------------------------------------------------------------------------

declare const createWorker: (name: "manifold" | "occt") => Worker;
declare const el: HTMLElement;

const options: MountOptions = {
  createWorker,
  elements: {
    viewer: el,
    controls: el,
    rail: el,
    shell: el,
    tabs: el,
    status: { status: el, busy: el, phase: el },
    exports: { stl: el, step: el, threeMf: el },
    chrome: { reframe: el, theme: el, cutaway: el, railToggle: el },
  },
  onBuild: (e) => {
    if (e.status === "success") expectType<number | undefined>(e.ms);
    else expectType<string>(e.error);
  },
  onPick: (e) => {
    expectType<string>(e.label);
    expectType<string>(e.selection.subPart);
    expectType<string | undefined>(e.selection.feature?.label);
  },
  onDownload: ({ data, filename, mime }) => void [data, filename, mime],
};

const runtime: PartRuntime = mount(spacer, options);

expectType<Promise<void>>(runtime.ready);
expectType<void>(runtime.dispose());
expectType<void>(runtime.setParams({ h: 20, note: "hi" }));
expectType<Array<{ view: string; dataUrl: string }>>(runtime.captureViews(["iso", "front"]));
expectType<Array<{ view: string; dataUrl: string }>>(runtime.captureViews());
expectType<string | null>(runtime.captureCurrent({ size: 2048, hideGrid: false, quality: 0.9 }));
expectType<string | null>(runtime.captureCurrent());
expectType<void>(runtime.setActive(false));
expectType<() => void>(runtime.onContextLost(() => {}));
expectType<Array<{ name: string; label: string }>>(runtime.listExportableParts());
expectType<Promise<void>>(runtime.exportParts({ parts: ["spacer"], format: "stl", onProgress: (phase) => void phase }));
expectType<void>(runtime.setHostPane("rail"));
expectType<void>(runtime.setHostPane(null));
// Animation playback: null for a part that declares none, so every call is guarded.
expectType<AnimationRuntime | null>(runtime.animation);
expectType<void | undefined>(runtime.animation?.play("open"));
expectType<AnimationState | undefined>(runtime.animation?.state());
// Realistic render mode and environments.
expectType<"cad" | "realistic">(runtime.renderMode.get());
expectType<Promise<"cad" | "realistic">>(runtime.renderMode.set("realistic"));
expectType<() => void>(runtime.renderMode.onChange((e) => void [e.mode, e.busy, e.error]));
expectType<Promise<string>>(runtime.environment.set("workshop"));
expectType<Array<{ id: string; label: string }>>(runtime.environment.list());
expectType<boolean>(runtime.declaresMaterials);
expectType<Promise<Array<{ view: string; dataUrl: string }>>>(runtime.renderViews(["iso"], { renderMode: "realistic" }));
expectType<"cad" | "realistic" | undefined>(runtime.getViewerState().renderMode);

// @ts-expect-error - "photo" is not a render mode
runtime.renderMode.set("photo");

// @ts-expect-error - "sidebar" is not a pane
runtime.setHostPane("sidebar");

// @ts-expect-error - "obj" is not an export format
runtime.exportParts({ parts: ["spacer"], format: "obj" });

// @ts-expect-error - the handle has no such method
runtime.setCamera({});

// @ts-expect-error - createWorker is required
mount(spacer, {});

// ---------------------------------------------------------------------------
// 4. The kernel.
// ---------------------------------------------------------------------------

declare const k: GeometryKernel;

expectType<Solid>(k.cylinder({ r: 4, h: 10 }));
expectType<Solid>(k.cylinder({ d1: 8, d2: 4, h: 10, center: true }));
expectType<Solid>(k.box({ size: [10, 20, 30] }));
expectType<Solid>(k.box({ min: [0, 0, 0], max: [1, 1, 1] }));
expectType<Solid>(k.sphere({ d: 8 }));
expectType<Solid>(k.sphere(4));
expectType<Solid>(k.roundedBox({ size: [60, 40, 22], round: { side: 4, top: 2, bottom: 0 } }));
expectType<Solid>(k.roundedCylinder({ r: 10, h: 30, round: 2 }));
expectType<Solid>(k.torus({ rMajor: 20, rMinor: 4 }));
expectType<Solid>(k.boredCylinder({ od: 8, h: 10, bore: 3.4 }));
expectType<Solid>(k.prism({ points: roundedRectPolygon(40, 30, 4), h: 10, twist: 15, scaleTop: 0.9 }));
expectType<Solid>(k.extrude({ profile: { outer: roundedRectPolygon(40, 30, 4), holes: [circleProfile(6)] }, h: 10 }));
expectType<Solid>(k.extrude({ profile: roundedProfile(roundedRectPolygon(40, 30, 0), 3), h: 5, bevel: { top: 0.6 } }));
expectType<Solid>(k.loft({ rings: [{ sides: 6, radius: 30, z: 0 }, { sides: 6, radius: 22, z: 120, rotate: 90 }] }));
expectType<Solid>(k.loft({ rings: [{ sides: 64, radius: 30, z: 0 }, { sides: 64, radius: 22, z: 120 }], shading: "smooth" }));
expectType<Solid>(k.loft({ rings: [{ sides: 64, radius: 30, z: 0 }, { sides: 64, radius: 22, z: 120 }], shading: "faceted" }));
// @ts-expect-error - shading only accepts "smooth" | "faceted"
k.loft({ rings: [{ sides: 6, radius: 30, z: 0 }, { sides: 6, radius: 22, z: 120 }], shading: "flat" });
expectType<Solid>(k.sweep({ profile: circleProfile(3), path: [[0, 0, 0], [0, 0, 20], [15, 0, 20]], cornerRadius: 5 }));
expectType<Solid>(k.revolve({ profile: [[0, 0], [10, 0], [10, 20]], degrees: 180 }));
expectType<Solid>(k.helixSweptTube({ pathR: 20, profileR: 2, pitch: 6, turns: 4, z0: 0, lefthand: false }));
expectType<Solid>(k.screwSweep({ profile: [[4, 0], [5, 0.5], [4, 1]], pitch: 2, turns: 3 }));
expectType<Solid>(k.union([k.sphere({ r: 1 }), k.sphere({ r: 2 })]));
expectType<Promise<ArrayBuffer>>(k.toSTEP([{ name: "body", solid: k.sphere({ r: 1 }) }]));

// Shape2D composition, including the sugar the kernel.js JSDoc omits.
const plate: Shape2D = k
  .shape2d(roundedRectPolygon(40, 24, 4))
  .union(circleProfile(8))
  .cutAll([circleProfile(2)])
  .offset(0.2, { corners: "sharp" });
expectType<number>(plate.area());
expectType<Shape2D[]>(plate.regions());
expectType<Solid>(plate.extrude({ h: 3 }));
expectType<Solid>(plate.revolve({ degrees: 270 }));
expectType<Shape2D>(k.text2d("v2.0", { size: 8, align: "center", valign: "middle" }));
expectType<Shape2D>(k.hull([circleProfile(4), circleProfile(4, [20, 0])]));
expectType<Shape2D>(k.hullChain([circleProfile(3), circleProfile(3, [15, 0])]));

// Solid transforms and the OCCT-only ops.
const body = k.box({ size: [40, 30, 16] });
expectType<Solid>(body.along("+Y").at([1, 2, 3]).rotateAbout({ axis: "Z", deg: 30, through: [5, 0, 0] }));
expectType<Solid>(body.mirror("XZ").scale(2, [0, 0, 0]).clone());
expectType<Solid>(body.fillet(3));
expectType<Solid>(body.fillet({ r: 3, edges: { dir: "Z" } }));
expectType<Solid>(body.chamfer({ d: 1, edges: { inPlane: "XY", at: 0 } }));
expectType<Solid>(body.shell({ t: 2, open: { near: [0, 0, 16] } }));
expectType<number>(body.volume());
expectType<number[]>(body.boundingBox().center);
// genus/isEmpty are Manifold-only, so they are optional on the interface.
expectType<number | undefined>(body.genus?.());
expectType<boolean | undefined>(body.isEmpty?.());

// @ts-expect-error - `h` is required on a cylinder
k.cylinder({ r: 4 });

// @ts-expect-error - "diameter" is not a cylinder option
k.cylinder({ diameter: 8, h: 10 });

// @ts-expect-error - `along` takes a signed axis direction
body.along("Z");

// @ts-expect-error - `mirror` takes a plane, not an axis
body.mirror("X");

// @ts-expect-error - `shell` always needs an `open` selector
body.shell({ t: 2 });

// ---------------------------------------------------------------------------
// 5. partforge/geometry.
// ---------------------------------------------------------------------------

expectType<number[][]>(circleProfile(4, [1, 2], 64));
expectType<ArcContour>(roundedProfile([[0, 0], [10, 0], [10, 10]], [2, 0, 2]));
expectType<ArcContour>(pathProfile([0, 0]).lineTo([20, 0]).arcTo([20, 8], [22, 4]).cubicTo([0, 8], [14, 16], [6, 16]).close());
expectType<number[][]>(offsetPolygon(roundedRectPolygon(20, 10, 2), -1, { corners: "sharp" }));
expectType<Region2D>(offsetPolygon({ outer: roundedRectPolygon(20, 10, 2), holes: [circleProfile(2)] }, 0.2));
expectType<Solid[]>(circularPattern(k.sphere({ r: 1 }), 8, { axis: "Z", angle: 180 }));

// @ts-expect-error - `close()` needs at least one segment, and the builder is not itself a contour
expectType<ArcContour>(pathProfile([0, 0]));

// ---------------------------------------------------------------------------
// 6. partforge/derive, /lint, /worker.
// ---------------------------------------------------------------------------

expectType<Record<string, unknown>>(resolveDerived(spacer, spacer.defaults));

const report = lintPart(spacer, { params: { h: 40 } });
expectType<boolean>(report.ok);
expectType<string>(report.errors[0]!.hint);
expectType<"error" | "warning" | "note">(report.errors[0]!.severity);
expectType<string | undefined>(report.warnings[0]!.pattern);
expectType<string>(report.notes[0]!.message);
expectType<string>(RULES[0]!.id);
// lintPart is deliberately total: it accepts anything and never throws.
expectType<boolean>(lintPart(null).ok);
expectType<boolean>(lintPart(spacer, null).ok);

expectType<void>(runWorker(spacer).setPart(grouped));

// ---------------------------------------------------------------------------
// 7. partforge/testing.
// ---------------------------------------------------------------------------

const kernel = await bootManifoldKernel({ quality: "print" });

const facts = measure(kernel, spacer, "spacer", {}, { minWall: true });
expectType<boolean>(facts.ok);
expectType<boolean>(facts.measuredMinWall);
expectType<number | null>(facts.subparts[0]!.holes);
expectType<number[] | null>(facts.subparts[0]!.centerOfMass);
expectType<number>(facts.aggregate.volume);
expectType<number>(facts.overlaps.length);
expectType<number>(facts.nearMisses[0]!.distance);

const v = verify(kernel, spacer, { process: "resin", view: "spacer", seed: { params: {}, result: facts } });
expectType<boolean | null>(v.ok);   // tri-state: null = no verdict (quick lap, or nothing declared)
expectType<number>(v.declared);
expectType<number | null>(facts.subparts[0]!.overhangArea);
expectType<string>(v.failures[0]!.case);
expectType<"pass" | "fail" | "warn" | "skip">(v.cases[0]!.checks[0]!.status);
expectType<"gate" | "warn">(v.cases[0]!.checks[0]!.kind);

expectType<number>(assemblyOverlaps(kernel, spacer, "spacer", {}, { tolerance: 0.5 }).length);

const built = buildView(kernel, spacer, "spacer");
expectType<string>(built[0]!.name);
const bvh = buildBVH(built[0]!.mesh);
expectType<number>(bvh.triangleCount);
expectType<{ t: number; tri: number } | null>(bvh.raycast([0, 0, 0], [0, 0, 1], { skipTri: 3 }));
expectType<number | null | undefined>(minWall(built[0]!.mesh, { bvh })?.value);

const relevant = relevantParamKeys(spacer, "spacer", spacer.defaults);
if (relevant !== RELEVANT_ALL) expectType<boolean>(relevant.has("od"));

// The single-build pattern the `inspect` job ships: build the view ONCE, measure
// that build, and rasterize the same meshes for match scoring. This shipped
// untypeable — `opts.built` was in the code and not in the declarations — so the
// exact call the job makes is the thing worth compiling here.
expectType<number>(measure(kernel, spacer, "spacer", {}, { minWall: true, built }).subparts.length);

const viewMasks: Record<string, SilhouetteMask | null> = {};
for (const view of MATCH_VIEWS) viewMasks[view] = rasterizeMeshMask(built.map((b) => b.mesh), view);
expectType<number | undefined>(viewMasks.top?.mmPerPx);

const target = rasterizeRingsMask([[[0, 0], [10, 0], [10, 10]]]);
const scored = matchViews(viewMasks, target, { scaleAware: true });
expectType<string | undefined>(scored.best?.view);
expectType<"mm" | "%bbox-diag" | undefined>(scored.best?.contourUnit);
expectType<number | undefined>(scored.best?.iouScale);
expectType<number | undefined>(scored.views.top);
expectType<Uint8Array | undefined>(scored.best?.delta.data);

// A photo mask carries no scale, and matchMasks accepts one that is not there at
// all — plus the unscoreable answer, which is null rather than a zero score.
expectType<number | undefined>(
  matchMasks({ data: new Uint8Array(16), width: 4, height: 4 }, viewMasks.front)?.iou,
);

// @ts-expect-error - measure's `view` is a string, not a number
measure(kernel, spacer, 0);

// @ts-expect-error - `built` is a buildView result, not a bare mesh list
measure(kernel, spacer, "spacer", {}, { built: [built[0]!.mesh] });

// A step may carry only a camera — an establishing shot that holds the pose while
// the view swings round. `partforge lint` allows it and the runtime plays it, so
// the published type has to as well; this is the case that caught them disagreeing.
const cameraOnlyStep: AnimationStep = { label: "Look", camera: "iso", duration: 1 };
const trackedStep: AnimationStep = {
  label: "Move", duration: 1, tracks: { lidAngle: [[0, 0], [1, 110]] },
};
// @ts-expect-error — duration is still required on every step
const noDuration: AnimationStep = { label: "Nope", camera: "iso" };

export { cameraOnlyStep, trackedStep, noDuration };

// `tracks` XOR `steps`, and camera cues limited to the canonical seven — both are
// rules `partforge lint` already enforces, so the declarations enforce them too
// rather than accepting blocks lint would reject.
const singlePhase: AnimationSpec = { duration: 1, tracks: { lidAngle: [[0, 0], [1, 110]] } };
const steppedSpec: AnimationSpec = {
  steps: [{ label: "Open", duration: 1, tracks: { lidAngle: [[0, 0], [1, 110]] } }],
};
const withCue: AnimationSpec = { duration: 1, camera: "iso", tracks: { a: [[0, 0], [1, 1]] } };
const withCueList: AnimationSpec = {
  duration: 1, camera: [[0, "front"], [0.5, "top"]], tracks: { a: [[0, 0], [1, 1]] },
};
// @ts-expect-error — both forms at once
const bothForms: AnimationSpec = { duration: 1, tracks: { a: [[0, 0], [1, 1]] }, steps: [] };
// @ts-expect-error — neither form
const neitherForm: AnimationSpec = { duration: 1 };
// @ts-expect-error — not one of the seven canonical angles
const badCue: AnimationSpec = { duration: 1, camera: "north-east-ish", tracks: { a: [[0, 0], [1, 1]] } };

// Opacity tracks ride alongside `tracks`, and an opacity-only animation is a
// legal single-phase form — a pure fade. The stepped form carries neither at the
// top level; its steps do.
const opacityStep: AnimationStep = { label: "Fade", duration: 1, opacity: { lid: [[0, 1], [1, 0]] } };
const opacityOnly: AnimationSpec = { duration: 1, opacity: { lid: [[0, 1], [1, 0]] } };
const tracksAndOpacity: AnimationSpec = {
  duration: 1, tracks: { lidAngle: [[0, 0], [1, 110]] }, opacity: { lid: [[0, 1], [1, 0]] },
};
const steppedOpacity: AnimationSpec = {
  steps: [{ duration: 1, opacity: { lid: [[0, 1], [1, 0]] } }],
};
const steppedTopLevelOpacity: AnimationSpec = {
  steps: [{ duration: 1, tracks: { a: [[0, 0], [1, 1]] } }],
  // @ts-expect-error — the stepped form has no top-level `opacity`; its steps carry it
  opacity: { lid: [[0, 1], [1, 0]] },
};

export { opacityStep, opacityOnly, tracksAndOpacity, steppedOpacity, steppedTopLevelOpacity };

// Animations are VIEW-owned: they hang off a `ViewDefinition`, and a top-level
// `part.animations` no longer exists — the clean break lint reports as an error.
const animatedPart = {
  meta: { title: "Animated" },
  parameters: [],
  defaults: { lidAngle: 0 },
  parts: { lid: { views: ["main"], build: (k) => k.cylinder({ r: 1, h: 1 }) } },
  views: { main: { label: "Main", animations: { open: tracksAndOpacity } } },
} satisfies PartDefinition;
const topLevelAnimations = {
  meta: { title: "Legacy" },
  parameters: [],
  defaults: { lidAngle: 0 },
  parts: { lid: { views: ["main"], build: (k) => k.cylinder({ r: 1, h: 1 }) } },
  views: { main: { label: "Main" } },
  // @ts-expect-error — animations moved onto the view they belong to
  animations: { open: tracksAndOpacity },
} satisfies PartDefinition;

export { animatedPart, topLevelAnimations };

// The authored controls shape typechecks.
const nodeSection: ParameterSection = {
  id: "body", title: "Body",
  controls: [
    { type: "preset", presets: { A: { od: 5 } } },
    { key: "od", type: "slider", min: 1, max: 10, step: 1, recommended: [2, 8] },
    { type: "group", title: "Wall", collapsed: "auto", controls: [
      { key: "wall", min: 0.8, max: 4, step: 0.1, when: { od: { gt: 2 } } },
    ] },
  ],
};
void nodeSection;

export { singlePhase, steppedSpec, withCue, withCueList, bothForms, neitherForm, badCue };

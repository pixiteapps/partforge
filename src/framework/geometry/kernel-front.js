// The backend-shared kernel front. Each backend builds its primitive mapping and
// returns finishKernel(kernel), which layers on everything that is NOT
// backend-specific:
//   - the options-object calling convention (op-options.js): one wrapper per
//     factory op normalizes an options-form call to positional args, then runs
//     the op's semantic check on the normalized args (both calling forms), then
//     calls the raw backend op — so backends stay positional and the solid
//     cache hashes normalized args;
//   - default compound-op compositions — a backend only overrides one when it has
//     a reason to (Manifold's boredCylinder hashes atomically for its solid cache);
//   - a KernelCapabilityError stub for toSTEP / shape2d when a backend lacks that
//     capability (Manifold can't do toSTEP; both backends now define shape2d, so
//     that stub is dead in practice — kept as a safety net for a future backend).
// The per-Solid twin of this layer is addSugar() in solid-sugar.js.
// opentype.js's namespace shape differs between bundler and Node resolution —
// see opentype-interop.js for the trap (it has bitten once in each direction).
import * as opentypeNamespace from "opentype.js";
import { normalizeOpentype, parseFont } from "./opentype-interop.js";
const opentype = normalizeOpentype(opentypeNamespace);
import { KernelCapabilityError } from "./errors.js";
import { isPlainOptions, KERNEL_OP_SPECS } from "./op-options.js";
import { textGlyphs } from "./text2d.js";
import { placeRegions } from "./vector2d.js";
import { beveledExtrude } from "./rim-bevel.js";
import { DEFAULT_FONT_BYTES } from "./fonts/default-font.js";
import { convexHull, hullPoints } from "./hull.js";
import { latheRoundedRect, torusContour } from "./rounded-solids.js";
import { screwCrossSection } from "./screw-profile.js";
import { smoothLoftRings } from "./loft-smooth.js";

export function finishKernel(k) {
  // Compound default: bored-through cylinder (tool overshoots 2 mm each end for
  // a clean cut). Assigned BEFORE the wrap loop so the fallback composition gets
  // the same key validation as a backend-native override.
  k.boredCylinder ??= ({ od, h, bore }) =>
    k.cylinder(od / 2, od / 2, h).cut(k.cylinder(bore / 2, bore / 2, h + 4).translate([0, 0, -2]));

  // Compound defaults: rounded lathe solids — ONE revolve of an arc-exact
  // profile, so OCCT gets real torus/sphere/cylinder faces in STEP and
  // Manifold facets at the mesh LOD. Zero booleans; neither backend overrides.
  k.roundedCylinder ??= ({ r, h, center, round }) => {
    const s = k.revolve({ profile: k.shape2d(latheRoundedRect(r, h, round.top, round.bottom)) });
    return center ? s.translate([0, 0, -h / 2]) : s;
  };
  k.torus ??= ({ rMajor, rMinor }) =>
    k.revolve({ profile: k.shape2d(torusContour(rMajor, rMinor)) });

  // Compound default: a screw-motion sweep of an axial [[r, z]] profile. Exactly
  // k.extrude with a polar-remapped section and one full turn of twist per pitch
  // (see screw-profile.js for why that identity holds, and why the profile must be
  // densified first). No backend override: both backends twist natively, so this
  // is one implementation and STEP gets a real twisted B-rep rather than a loft.
  k.screwSweep ??= ({ profile, pitch, turns, lefthand = false }) =>
    k.extrude({
      profile: screwCrossSection(profile, pitch, { lefthand }),
      h: pitch * turns,
      twist: (lefthand ? -360 : 360) * turns,
    });

  // Compound default: a tapped (internally threaded) hole, as ONE cut tool.
  //
  // The tool is a plain bore fused with a helical thread, and the whole reason
  // this op exists is the ONE line that makes that fuse cheap: the thread's root
  // is sunk INSIDE the bore rather than sitting on it. Hand-assembled, a tapped
  // hole is written the obvious way — bore of diameter d, thread whose root
  // radius is also d/2 — and those two tools then touch along an exactly
  // coincident cylinder without overlapping. Mesh CSG does not care. OCCT does:
  // it has to resolve a tangential contact between a cylinder and the swept
  // B-spline surface of the thread root, along a helix, and the intersector
  // degenerates. Measured on a real 6-turn M6-ish cap: the tangent form did not
  // finish in fifteen minutes (with OCCT's own glue mitigation, 73-92 s); the
  // sunk-root form is 8.4 s.
  //
  // Sinking is FREE, not a tolerance compromise: everything inside the bore is
  // already removed by the bore, so the union is the same point set either way.
  // That is exactly why this has to be an op that owns BOTH halves — screwSweep
  // alone cannot sink its own root, because a thread cut into solid stock with
  // no bore would then cut a deeper root and change the part.
  k.tappedBore ??= ({ d, pitch, turns, depth, crest, lefthand = false, rootSink = 0.2, overshoot = 0.2 }) => {
    const rootR = d / 2;
    const majorR = rootR + (crest ?? 0.15 * pitch);
    // A printable trapezoidal tooth: flat at root and crest so neither knife-edges
    // at FDM resolution. Same shape a hand-rolled coarse thread converges on.
    const rootFlat = pitch / 4;
    const crestFlat = pitch / 8;
    const rise = (pitch - rootFlat - crestFlat) / 2;
    // Sink the root by extending the flanks COLINEARLY into the bore, not by
    // moving the root points straight inward. A radially-moved root changes the
    // flank slope, which fattens the tooth OUTSIDE the bore — measured at 2% of
    // tool volume, and it lands exactly where a mating printed thread needs its
    // clearance. A colinear extension is the same swept surface carried further
    // down, so everything at r >= rootR is byte-identical to the hand-assembled
    // tangent construction and the union with the bore clips the rest — the
    // identity test in test/tapped-bore.test.js holds this to mesh precision.
    // The extension steals axial root-flat width (e per side), so the sink is
    // clamped where a full rootSink would consume it; the clamped overlap still
    // clears the coincidence band by an order of magnitude.
    const slope = rise / (majorR - rootR); // axial travel per unit of radial travel, along a flank
    const sink = Math.min(rootSink, rootR, (0.45 * rootFlat) / slope);
    const innerR = rootR - sink;
    const e = slope * sink;
    // Shifted down by e so the thread still spans [0, pitch*turns] — the bore's
    // overshoot math below must not depend on the flank geometry.
    const thread = k.screwSweep({
      profile: [
        [innerR, 0],
        [innerR, rootFlat - 2 * e],
        [majorR, rootFlat + rise - e],
        [majorR, rootFlat + rise + crestFlat - e],
        [innerR, pitch],
      ],
      pitch, turns, lefthand,
    });
    // The bore overhangs the thread at BOTH ends, for the same reason the sink
    // exists: flush is a coincident face. Built with both starting at z = 0 the
    // bore's end cap is coplanar with the thread's first turn, and this union
    // does not hang — it silently returns the bore alone (or, with the operands
    // swapped, an empty solid). A wrong answer with no error is the worst of the
    // three failure modes, and overhanging is what avoids it.
    const threadLength = pitch * turns;
    // _trustedUnion where the backend offers it (OCCT): this composition is the
    // coincidence guard's own coached FIX, audited by the identity test and the
    // guard suite, and its flank chord-bands legitimately hug the bore wall
    // they overlap — the guard must not second-guess it. Manifold has no guard
    // and no _trustedUnion; plain union is identical there.
    return (k._trustedUnion ?? k.union)([
      k.cylinder({ d, h: (depth ?? threadLength) + 2 * overshoot }).translate([0, 0, -overshoot]),
      thread,
    ]);
  };

  // Compound default: spline-smoothed loft. The shared Catmull-Rom densifier
  // (loft-smooth.js) now emits all-cubic curve rings on BOTH paths — every ring
  // is contour IR ({start, segments:[{to,c1,c2}…]}), fitted exactly from the CR
  // spline (a CR span IS a cubic; 4-point inversion has no approximation error).
  // On a mesh kernel it expands the sparse control sections in both directions
  // and plain loft stitches the curve rings (matched per-segment samples). On a
  // B-rep kernel, dense *point* wires broke OCCT (v1 spike: 23 s at 32×96, WASM
  // abort at 48×128) — that fragility is exactly why `stations:"controls"`
  // exists, skipping cross-station interpolation and handing the backend only
  // the around-ring reconciliation. Curve wires don't share that fragility:
  // OCCT's ThruSections handles many-span cubic-Bézier wires in milliseconds
  // (`ruled: false` — exact B-spline surfaces), probed at 74–261 ms for
  // 24–128 spans on the propeller reference part. Parity is therefore
  // screwSweep's tolerance class, not sweep's by-construction class: measured
  // ~0.4% volume divergence there.
  // B-rep detection: `toSTEP` exists here only on a B-rep backend — the stub for
  // mesh kernels is assigned later in this function.
  // The guarded shading spread keeps an undefined key out of loft's option
  // validation; a caller-supplied hint still passes through, and otherwise
  // loft's own curve-ring shading policy decides (corners crease, curves stay
  // smooth) rather than this composition forcing "smooth".
  const brepLoft = typeof k.toSTEP === "function";
  k.loftSmooth ??= ({ sections, stations, samples, shading, closed = false }) => {
    if (brepLoft && closed) throw new Error("loftSmooth: closed:true loops are only supported on the Manifold backend");
    return brepLoft
      ? k.loft({ rings: smoothLoftRings(sections, { stations: "controls", samples }), ruled: false })
      : k.loft({ rings: smoothLoftRings(sections, { stations, samples, closed }), ...(shading ? { shading } : {}), closed });
  };

  for (const [op, { toArgs, check, warn }] of Object.entries(KERNEL_OP_SPECS)) {
    const raw = k[op];
    if (!raw) continue;
    k[op] = (...a) => {
      // toArgs gets the kernel's warning recorder: a couple of specs (roundedBox's
      // rim clamp) DEGRADE during normalization rather than throwing, and that
      // degrade has to reach the build's warning list, not just the console.
      const pos = a.length === 1 && isPlainOptions(a[0]) ? toArgs(a[0], k._recordWarning) : a;
      check?.(...pos);
      // A self-crossing hand-authored profile is a warning, never a failure
      // (profile-warnings.js). Runs after `check` so a rejected input reports
      // the op's own error, and before the backend so both backends warn alike.
      warn?.(k._warnProfile, ...pos);
      return raw(...pos);
    };
  }

  // extrude({ bevel }) desugars here — before the spec-wrapped op ever sees it —
  // into extrude + loft + intersect (rim-bevel.js), so both backends share one
  // implementation and the probe records no CAD-only op. beveledExtrude calls
  // back into the wrapped k.extrude/k.loft, so caching and validation apply.
  const specExtrude = k.extrude;
  k.extrude = (...a) =>
    a.length === 1 && isPlainOptions(a[0]) && a[0].bevel !== undefined
      ? beveledExtrude(k, a[0])
      : specExtrude(...a);

  k.toSTEP ??= () => { throw new KernelCapabilityError("toSTEP requires the OCCT backend"); };
  k.shape2d ??= () => { throw new KernelCapabilityError("shape2d requires the Manifold backend"); };

  // 2-D text as a Shape2D. Backend-agnostic: builds per-glyph Shape2Ds and unions
  // them. Fonts come from k._fonts (framework-preloaded by name) or inline bytes.
  k._fonts ??= new Map();
  // Parse inline bytes once per buffer, keyed by the buffer's own IDENTITY (a stable
  // import yields the same ArrayBuffer each build). WeakMap-by-buffer avoids the
  // wrong-font bug a byteLength key would cause. No separate text2d cache/fontId is
  // needed: text2d builds k.shape2d(glyphContours)+union, and the Shape2D hash keys
  // on the actual glyph coordinates — a different font → different geometry →
  // different cache entry, automatically.
  const byteCache = new WeakMap();                              // original view/buffer → parsed font
  const parseBytes = (arg) => {
    let f = byteCache.get(arg);
    if (!f) {
      // Key on the ORIGINAL arg (stable identity for the cache), but parse the view's
      // EXACT byte range — arg.buffer alone spans the whole (possibly pooled) backing
      // buffer, which would feed opentype garbage for a byteOffset>0 view.
      const buf = ArrayBuffer.isView(arg) ? arg.buffer.slice(arg.byteOffset, arg.byteOffset + arg.byteLength) : arg;
      f = parseFont(opentype, buf); byteCache.set(arg, f);
    }
    return f;
  };
  const resolveFont = (font) => {
    if (font == null) {
      // Lazily parse + memoize the framework's bundled default (vendored Roboto,
      // SIL OFL 1.1 — see fonts/Roboto-LICENSE.txt) so k.text2d works with zero
      // setup when { font } is omitted. Slice to the exact byte range rather than
      // handing opentype the raw .buffer — DEFAULT_FONT_BYTES is a Uint8Array and,
      // while it spans its own freshly-allocated buffer today (byteOffset 0), slicing
      // guards against that ever changing.
      if (!k._defaultFont) {
        const { buffer, byteOffset, byteLength } = DEFAULT_FONT_BYTES;
        k._defaultFont = parseFont(opentype, buffer.slice(byteOffset, byteOffset + byteLength), "the bundled default");
      }
      return k._defaultFont;
    }
    if (typeof font === "string") {
      const f = k._fonts.get(font);
      if (!f) throw new Error(`text2d: unknown font "${font}" — declare it in the part's \`fonts\` field`);
      return f;
    }
    return parseBytes(font);
  };
  k.text2d = (string, opts = {}) => {
    const { font, size = 10, align = "center", valign = "middle", lineHeight, tracking = 0, kerning = true } = opts;
    const parsed = resolveFont(font);
    const regions = textGlyphs(parsed, string, { size, align, valign, lineHeight, tracking, kerning });
    if (regions.length === 0) throw new Error("text2d: string produced no glyph geometry (empty or all-whitespace?)");
    // Glyph regions are machine-resolved by curve-fill — trusted, so a text
    // part does not pay profile validation per glyph per rebuild.
    return regions.map((r) => k.shape2d.trusted(r)).reduce((a, b) => a.union(b));
  };

  // 2-D vector art as a Shape2D. Backend-agnostic for the same reason text2d is:
  // it lowers to k.shape2d + union, so both backends get identical curve regions.
  // Regions come from k._vectors, preloaded by name from the part's declared
  // vector documents — this op does no SVG parsing at all, by design.
  // k._vectors holds documents ({ units, shapes: Map<name, { role, regions }> }).
  // With no `shape` option, every "add" shape is unioned and every "subtract"
  // shape is cut from that union (role states the file's own composition; union
  // is commutative so key order is moot within each group). `shape` selects one
  // shape's own geometry by name, whatever its role, so the caller can compose
  // shapes with ordinary booleans in the drawing's own frame.
  k._vectors ??= new Map();
  k.vector2d = (name, opts = {}) => {
    if (typeof name !== "string" || !name)
      throw new Error("vector2d: first argument must be the name of an entry in the part's `vectors` field");
    const doc = k._vectors.get(name);
    if (!doc) throw new Error(`vector2d: unknown vector "${name}" — declare it in the part's \`vectors\` field`);
    // vector documents carry their own validation (VECTOR-FORMAT.md); trusted lift
    const lift = (regions, measureAgainst = regions) =>
      placeRegions(regions, doc.units, opts, { measureAgainst, name }).map((r) => k.shape2d.trusted(r)).reduce((a, b) => a.union(b));
    if (opts.shape != null) {
      const entry = doc.shapes.get(opts.shape);
      if (!entry) {
        throw new Error(`vector2d: "${name}" has no shape ${JSON.stringify(opts.shape)} — it declares: ${[...doc.shapes.keys()].join(", ")}`);
      }
      // Naming a shape is a request for THAT geometry; role governs only the
      // default composition below.
      return lift(entry.regions);
    }
    const adds = [...doc.shapes.values()].filter((e) => e.role === "add").flatMap((e) => e.regions);
    const subs = [...doc.shapes.values()].filter((e) => e.role === "subtract").flatMap((e) => e.regions);
    if (subs.length === 0) return lift(adds);
    // ONE transform for the whole document — both groups are measured against
    // the SAME regions, so a size or align option cannot scale the subtracts
    // relative to the adds. (With no size and no align — the common millimetre
    // case — the transform is the identity and this changes nothing.)
    //
    // Measured against the ADDS, not against every region. A subtract may
    // legitimately overhang the adds — a rect that lops off a corner, an
    // overhanging keyway — and that overhang is deleted before the caller sees
    // anything, so sizing or aligning against it puts the visible edge where
    // nobody asked for it. With a subtract reaching 5 mm past the adds' left,
    // measuring against all of them put `{ align: "left" }` — no size option at
    // all — 5 mm right of the origin.
    return lift(adds).cut(lift(subs, adds));
  };

  // Convex hull → Shape2D. Backend-agnostic: pure-JS monotone-chain hull of the inputs'
  // sampled points, lifted via k.shape2d. Faceted (curved inputs at a fixed LOD).
  k.hull = (inputs) => {
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new Error("hull: inputs must be a non-empty array");
    return k.shape2d(convexHull(inputs.flatMap(hullPoints)));
  };
  // Swept hull over an ordered sequence (≥2): union of the hull of each consecutive pair.
  k.hullChain = (inputs) => {
    if (!Array.isArray(inputs) || inputs.length < 2)
      throw new Error("hullChain: needs at least 2 inputs");
    let acc = null;
    for (let i = 0; i < inputs.length - 1; i++) {
      const seg = k.hull([inputs[i], inputs[i + 1]]);
      acc = acc ? acc.union(seg) : seg;
    }
    return acc;
  };

  return k;
}

// src/framework/geometry/op-options.js
// The options-object calling convention: pure normalizers turning each op's
// canonical options form into the backend's positional argument list, plus the
// detection predicate. Normative rule (KERNEL-CONTRACT.md "Calling convention"):
// a call is options form when the op receives exactly one plain-object argument.
// kernel-front.js and solid-sugar.js apply these at the backend-shared seams, so
// backends stay positional and the Manifold solid cache hashes normalized args —
// both spellings of a call share one cache entry. Geometry-free by design.

export function isPlainOptions(x) {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

// Small capped Levenshtein for did-you-mean hints (distance > 2 reads as "no").
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Prefix match first so long-form names hit their short key (radius→r,
// height→h, diameter→d), then edit distance ≤ 2 for plain typos. A digit
// suffix is peeled and re-attached so radius1 hints r1, not r.
// Exported so partforge/lint's `unknown-control-field` rule reuses this exact
// suggester rather than carrying a second copy of the edit-distance logic.
export function suggest(key, valid) {
  const lk = key.toLowerCase();
  const m = /^([a-z]+)(\d+)$/.exec(lk);
  if (m) for (const v of valid) if (m[1].startsWith(v.toLowerCase()) && valid.includes(v + m[2])) return v + m[2];
  for (const v of valid) if (lk.startsWith(v.toLowerCase())) return v;
  for (const v of valid) if (editDistance(lk, v.toLowerCase()) <= 2) return v;
  return null;
}

function checkKeys(op, o, valid) {
  for (const key of Object.keys(o)) {
    if (valid.includes(key)) continue;
    const hint = suggest(key, valid);
    throw new Error(`${op}: unknown option ${JSON.stringify(key)}${
      hint ? ` — did you mean ${hint}?` : ` (valid: ${valid.join(", ")})`}`);
  }
}

function req(op, o, key) {
  if (o[key] === undefined) throw new Error(`${op}: ${key} is required`);
  return o[key];
}

// Trailing positional opts object, only if any of `keys` is present — an empty
// options tail must normalize to *no* argument so it hashes identically to the
// bare positional call.
function tail(o, keys) {
  const t = {};
  let any = false;
  for (const key of keys) if (o[key] !== undefined) { t[key] = o[key]; any = true; }
  return any ? [t] : [];
}

export function cylinderArgs(o) {
  checkKeys("cylinder", o, ["r", "d", "r1", "r2", "d1", "d2", "h", "center"]);
  const has = (key) => o[key] !== undefined;
  const straight = has("r") + has("d");
  const coneR = has("r1") + has("r2");
  const coneD = has("d1") + has("d2");
  let rBottom, rTop;
  if (straight === 1 && coneR + coneD === 0) rBottom = rTop = has("r") ? o.r : o.d / 2;
  else if (straight === 0 && coneR === 2 && coneD === 0) { rBottom = o.r1; rTop = o.r2; }
  else if (straight === 0 && coneR === 0 && coneD === 2) { rBottom = o.d1 / 2; rTop = o.d2 / 2; }
  else throw new Error("cylinder: pass exactly one of r/d, or r1+r2 / d1+d2");
  return [rBottom, rTop, req("cylinder", o, "h"), ...tail(o, ["center"])];
}

export function sphereArgs(o) {
  checkKeys("sphere", o, ["r", "d"]);
  const hasR = o.r !== undefined;
  if (hasR === (o.d !== undefined)) throw new Error("sphere: pass exactly one of r/d");
  return [hasR ? o.r : o.d / 2];
}

export function boxArgs(o) {
  checkKeys("box", o, ["size", "center", "min", "max"]);
  if (o.min !== undefined || o.max !== undefined) {
    if (o.size !== undefined) throw new Error("box: pass size or min+max, not both");
    if (o.center !== undefined) throw new Error("box: center only applies to the size form");
    return [req("box", o, "min"), req("box", o, "max")];
  }
  const [x, y, z] = req("box", o, "size");
  return o.center === true
    ? [[-x / 2, -y / 2, -z / 2], [x / 2, y / 2, z / 2]]   // centered on all axes
    : [[-x / 2, -y / 2, 0], [x / 2, y / 2, z]];           // canonical: centered X/Y, base at z=0
}

export function prismArgs(o) {
  checkKeys("prism", o, ["points", "h", "twist", "scaleTop"]);
  return [req("prism", o, "points"), req("prism", o, "h"), ...tail(o, ["twist", "scaleTop"])];
}

export function extrudeArgs(o) {
  // `bevel` is accepted here so the validating probe (lint) doesn't flag it, but
  // it never reaches the positional backend op — kernel-front.js desugars a
  // bevel call into extrude + loft + intersect before this normalizer runs.
  checkKeys("extrude", o, ["profile", "h", "twist", "scaleTop", "bevel"]);
  return [req("extrude", o, "profile"), req("extrude", o, "h"), ...tail(o, ["twist", "scaleTop"])];
}

export function revolveArgs(o) {
  checkKeys("revolve", o, ["profile", "degrees"]);
  return [req("revolve", o, "profile"), ...tail(o, ["degrees"])];
}

export function loftArgs(o) {
  checkKeys("loft", o, ["rings", "ruled", "closed", "shading"]);
  return [req("loft", o, "rings"), ...tail(o, ["ruled", "closed", "shading"])];
}

export function sweepArgs(o) {
  checkKeys("sweep", o, ["profile", "path", "closed", "cornerRadius", "ruled", "smooth"]);
  return [req("sweep", o, "profile"), req("sweep", o, "path"),
    ...tail(o, ["closed", "cornerRadius", "ruled", "smooth"])];
}

// ---- rounded primitives (options-only ops) -------------------------------

// Clamp warnings are deduped per distinct message so a slider sweep doesn't
// spam the console on every rebuild. Console-only side channel; the returned
// geometry stays a pure function of the arguments.
const warnedClamps = new Set();

// `round` accepts a number (broadcast to every group) or a plain object with
// the op's group keys (missing keys → 0).
const normalizeRound = (op, v, keys) => {
  if (typeof v === "number") return Object.fromEntries(keys.map((key) => [key, v]));
  if (isPlainOptions(v)) {
    checkKeys(`${op}: round`, v, keys);
    return Object.fromEntries(keys.map((key) => [key, v[key] ?? 0]));
  }
  throw new Error(`${op}: round must be a number or { ${keys.join("?, ")}? }`);
};

const checkRoundRadius = (op, name, v, max, maxDesc) => {
  if (!(typeof v === "number" && Number.isFinite(v) && v >= 0))
    throw new Error(`${op}: ${name} must be a finite number ≥ 0`);
  if (v > max + 1e-9) throw new Error(`${op}: ${name} (${v}) must be ≤ ${maxDesc}`);
};

export function roundedBoxArgs(o, record) {
  checkKeys("roundedBox", o, ["size", "center", "round"]);
  const size = req("roundedBox", o, "size");
  if (!Array.isArray(size) || size.length !== 3 || !size.every((v) => Number.isFinite(v) && v > 0))
    throw new Error("roundedBox: size must be [w, d, h] with three positive numbers");
  const [w, d, h] = size;
  const round = normalizeRound("roundedBox", req("roundedBox", o, "round"), ["side", "top", "bottom"]);
  checkRoundRadius("roundedBox", "round.side", round.side, Math.min(w, d) / 2, "min(w, d)/2");
  checkRoundRadius("roundedBox", "round.top", round.top, Math.min(w, d) / 2, "min(w, d)/2");
  checkRoundRadius("roundedBox", "round.bottom", round.bottom, Math.min(w, d) / 2, "min(w, d)/2");
  // Normalize the +1e-9 validation slack above to the exact stadium bound, so
  // Manifold and OCCT build from bit-identical arguments at that boundary.
  round.side = Math.min(round.side, Math.min(w, d) / 2);
  // Middle regime (0 < side < rim): rims clamp DOWN to side — side defines the
  // footprint and must not grow; a shrunk round-over only adds material. The
  // side = 0 sphere-free rim round-over stays fully valid (see the spec).
  if (round.side > 0) {
    for (const key of ["top", "bottom"]) {
      if (round[key] > round.side) {
        // Keyed on op/field/side rather than the full message — a slider sweep
        // over the raw rim value (round[key]) would otherwise mint a distinct
        // message (and a distinct Set entry) on every rebuild, defeating the dedupe.
        const dedupeKey = `roundedBox.${key}|${round.side}`;
        const msg = `roundedBox: round.${key} ${round[key]} clamped to round.side ${round.side} (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)`;
        // The console dedupe stays (a slider sweep would otherwise spam it), but
        // the RECORDER is fed every time: warnings are drained per build, so
        // deduping them across builds would silently drop the clamp from the
        // second and every later build that still clamps.
        record?.(msg);
        if (!warnedClamps.has(dedupeKey)) { warnedClamps.add(dedupeKey); console.warn(msg); }
        round[key] = round.side;
      }
    }
  }
  if (round.top + round.bottom > h + 1e-9)
    throw new Error("roundedBox: round.top + round.bottom must be ≤ h");
  if (round.side > 0 && round.top + round.bottom > h - 1e-6)
    throw new Error("roundedBox: with round.side > 0, round.top + round.bottom must be < h (the rim fillets would meet tangentially; reduce the rim radii slightly, or use side: 0 for a sharp-sided full-height round-over)");
  return [{ size: [w, d, h], center: o.center === true, round }];
}

export function roundedCylinderArgs(o) {
  checkKeys("roundedCylinder", o, ["r", "d", "h", "center", "round"]);
  const hasR = o.r !== undefined;
  if (hasR === (o.d !== undefined)) throw new Error("roundedCylinder: pass exactly one of r/d");
  const r = hasR ? o.r : o.d / 2;
  if (!(Number.isFinite(r) && r > 0)) throw new Error("roundedCylinder: r must be > 0");
  const h = req("roundedCylinder", o, "h");
  if (!(Number.isFinite(h) && h > 0)) throw new Error("roundedCylinder: h must be > 0");
  const round = normalizeRound("roundedCylinder", req("roundedCylinder", o, "round"), ["top", "bottom"]);
  checkRoundRadius("roundedCylinder", "round.top", round.top, r, "r");
  checkRoundRadius("roundedCylinder", "round.bottom", round.bottom, r, "r");
  // Normalize the +1e-9 validation slack to the exact bound (the roundedBox
  // side clamp's twin) so the lathe profile never crosses the revolve axis.
  round.top = Math.min(round.top, r);
  round.bottom = Math.min(round.bottom, r);
  if (round.top + round.bottom > h + 1e-9)
    throw new Error("roundedCylinder: round.top + round.bottom must be ≤ h");
  return [{ r, h, center: o.center === true, round }];
}

export function torusArgs(o) {
  checkKeys("torus", o, ["rMajor", "rMinor"]);
  const rMajor = req("torus", o, "rMajor"), rMinor = req("torus", o, "rMinor");
  if (!(Number.isFinite(rMajor) && Number.isFinite(rMinor) && rMinor > 0 && rMinor < rMajor))
    throw new Error("torus: requires 0 < rMinor < rMajor");
  return [{ rMajor, rMinor }];
}

// Per-op semantic validations, applied to the NORMALIZED positional args so
// they cover both calling forms (these moved here from kernel-front.js).
const checkScaleTop = (op) => (_profile, _h, opts) => {
  if ((opts?.scaleTop ?? 1) < 0) throw new Error(`${op}: scaleTop must be ≥ 0`);
};

// An empty Shape2D (a cut/intersect can legitimately remove everything) is a
// valid 2-D value, but 3-D materialization must reject it identically on both
// backends — Manifold would silently build an empty solid, OCCT would throw a
// backend-specific error. `?.` because the probe's fake handle has no _regions.
const checkNonEmptyProfile = (op, profile) => {
  if (profile && profile._shape2d && profile._regions?.length === 0)
    throw new Error(`${op}: the profile Shape2D is empty — nothing to build ` +
      "(a cut/intersect may have removed everything; guard with .isEmpty())");
};

// Ops that were always options-only have no positional form to normalize —
// toArgs validates keys/required and passes the object through unchanged, so a
// typo'd key fails loudly instead of destructuring to undefined → NaN geometry.
const passThrough = (op, valid, required) => (o) => {
  checkKeys(op, o, valid);
  for (const key of required) req(op, o, key);
  return [o];
};

// Kernel factory ops under the options convention. finishKernel() wraps each:
// normalize (if options form) → check → raw backend op.
export const KERNEL_OP_SPECS = {
  cylinder: { toArgs: cylinderArgs },
  sphere:   { toArgs: sphereArgs },
  box:      { toArgs: boxArgs },
  // `warn` (finishKernel calls it after `check`, with the kernel's profile
  // warner first) reports a self-crossing hand-authored profile as a build
  // warning — the build proceeds; see profile-warnings.js.
  prism:    { toArgs: prismArgs, check: checkScaleTop("prism"),
    warn: (warnProfile, points) => warnProfile?.("prism: profile", points) },
  extrude:  { toArgs: extrudeArgs, check: (profile, h, opts) => {
    checkNonEmptyProfile("extrude", profile);
    checkScaleTop("extrude")(profile, h, opts);
  }, warn: (warnProfile, profile) => warnProfile?.("extrude: profile", profile) },
  revolve:  { toArgs: revolveArgs, warn: (warnProfile, pts) => warnProfile?.("revolve: profile", pts), check: (pts) => {
    checkNonEmptyProfile("revolve", pts);
    if (pts && pts._shape2d) {
      // The B-rep backend's Drawing bounding box is tolerance-padded (1e-6 on
      // every side, measured), so a lathe profile touching the revolve axis at
      // x = 0 reports min[0] = -1e-6. Tolerate the padding; a real negative-
      // radius profile still trips the check.
      if (pts.boundingBox().min[0] < -1e-5) throw new Error("revolve: profile radius must be ≥ 0");
      return;
    }
    for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
  } },
  loft:     { toArgs: loftArgs, warn: (warnProfile, rings) => {
    if (!Array.isArray(rings)) return;
    rings.forEach((r, i) => { if (r?.polygon && !r.polygon._shape2d) warnProfile?.(`loft: ring ${i}`, r.polygon); });
  } },
  sweep:    { toArgs: sweepArgs, warn: (warnProfile, profile) => warnProfile?.("sweep: profile", profile) },
  boredCylinder:  { toArgs: passThrough("boredCylinder", ["od", "h", "bore"], ["od", "h", "bore"]) },
  helixSweptTube: { toArgs: passThrough("helixSweptTube",
    ["pathR", "profileR", "pitch", "turns", "z0", "lefthand"], ["pathR", "profileR", "pitch", "turns"]) },
  tappedBore: {
    toArgs: passThrough("tappedBore",
      ["d", "pitch", "turns", "depth", "crest", "lefthand", "rootSink", "overshoot"], ["d", "pitch", "turns"]),
    check: (o) => {
      if (!(o.d > 0)) throw new Error("tappedBore: d must be > 0");
      if (!(o.pitch > 0)) throw new Error("tappedBore: pitch must be > 0");
      if (!(o.turns > 0)) throw new Error("tappedBore: turns must be > 0");
      if (o.depth != null && !(o.depth > 0)) throw new Error("tappedBore: depth must be > 0");
      if (o.crest != null && !(o.crest > 0)) throw new Error("tappedBore: crest must be > 0");
      // The sink is what keeps the bore and the thread root off the same
      // cylinder; at zero they are tangent again and OCCT degenerates, which is
      // the entire failure this op exists to prevent.
      if (o.rootSink != null && !(o.rootSink > 0)) throw new Error("tappedBore: rootSink must be > 0");
      if (o.rootSink != null && o.rootSink >= o.d / 2)
        throw new Error("tappedBore: rootSink must be smaller than the bore radius");
      if (o.overshoot != null && !(o.overshoot > 0)) throw new Error("tappedBore: overshoot must be > 0");
      // The thread is always pitch*turns long; a shorter bore would leave it
      // poking out past the bore's far end — a tap deeper than its own hole,
      // and the overhang guarantee above quietly broken at that end.
      if (o.depth != null && o.depth < o.pitch * o.turns)
        throw new Error(
          `tappedBore: depth (${o.depth}) must cover the thread (pitch*turns = ${o.pitch * o.turns}) — lower turns to Math.floor(depth / pitch), or raise depth`);
    },
  },
  screwSweep: {
    toArgs: passThrough("screwSweep", ["profile", "pitch", "turns", "lefthand"], ["profile", "pitch", "turns"]),
    check: (o) => {
      if (!(o.pitch > 0)) throw new Error("screwSweep: pitch must be > 0");
      if (!(o.turns > 0)) throw new Error("screwSweep: turns must be > 0");
    },
  },
  // loftSmooth: range checks live in loft-smooth.js, next to the defaults they guard.
  loftSmooth: { toArgs: passThrough("loftSmooth", ["sections", "stations", "samples", "shading", "closed"], ["sections"]) },
  // heightfield: (nameOrGrid, opts) is a two-positional call, not the options-object
  // convention — toArgs only normalizes a bare single-arg call (kernel-front.js's
  // wrapper invokes it as `toArgs(a[0], k._recordWarning)`, so the second
  // parameter here is always the kernel's warning recorder, never a real `opts`
  // — do not thread it through as one). The rest of the range/positivity checks
  // (base, pitch) live in heightfield.js next to the defaults they guard, same
  // split as loftSmooth above.
  heightfield: { toArgs: (a) => [a, {}], check: (_src, o = {}) => {
    if (!(o.w > 0) || !(o.d > 0)) throw new Error("heightfield: w and d must be positive");
  } },
  roundedBox:      { toArgs: roundedBoxArgs },
  roundedCylinder: { toArgs: roundedCylinderArgs },
  torus:           { toArgs: torusArgs },
};

// Solid ops under the options convention; addSugar() wraps these when the
// backend provides them natively (OCCT). The Manifold stubs check only for the
// zero-magnitude identity case below, then throw the routing error unnormalized.
export const SOLID_OP_SPECS = {
  fillet:  { toArgs: (o) => { checkKeys("fillet", o, ["r", "edges"]);
    return [req("fillet", o, "r"), ...(o.edges !== undefined ? [o.edges] : [])]; } },
  chamfer: { toArgs: (o) => { checkKeys("chamfer", o, ["d", "edges"]);
    return [req("chamfer", o, "d"), ...(o.edges !== undefined ? [o.edges] : [])]; } },
  shell:   { toArgs: (o) => { checkKeys("shell", o, ["t", "open"]);
    return [req("shell", o, "t"), req("shell", o, "open")]; } },
  roundAll: { toArgs: (o) => { checkKeys("roundAll", o, ["r"]);
    return [req("roundAll", o, "r")]; } },
};

// A zero-magnitude fillet/chamfer is the identity on every conformance class
// (KERNEL-CONTRACT.md), so it neither routes a part to OCCT nor throws the
// Manifold capability error. True only when the magnitude is PROVABLY the number
// 0 in either calling convention — anything unprovable stays conservative
// (routes/throws). shell is excluded: t = 0 means zero-thickness walls, which is
// degenerate, not identity.
export function isZeroMagnitudeCadOp(op, args) {
  const key = op === "fillet" ? "r" : op === "chamfer" ? "d" : null;
  if (!key) return false;
  const a0 = args[0];
  const v = typeof a0 === "number" ? a0 : isPlainOptions(a0) ? a0[key] : undefined;
  return v === 0;
}

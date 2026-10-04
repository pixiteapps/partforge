// Group 5 — the per-view `animations` blocks (specs
// 2026-08-02-model-animation-design.md, 2026-08-10-per-view-animations.md).
// Everything but the last rule is static data validation: the block is pure
// keyframe data by design, so lint can hold every track to the schema without
// executing author code. `animation-track-rebuilds` is the exception — it runs
// the geometry-free pose probe to classify each track as pose-only or
// geometry-rebuilding, and reports the latter at the note tier.
//
// Animations are VIEW-OWNED: each block lives at `views.<view>.animations`, and
// every finding path says so. A legacy top-level `animations` key is ignored by
// the runtime, so `animation-not-in-view` reports it as a hard error rather than
// letting the author wonder why nothing plays.
import { err, note } from "./finding.js";
import { EASINGS } from "../animation.js";
import { CANONICAL_VIEWS, CAMERA_CUE_VIEWS } from "../view-angles.js";
import { probeSubPartPose } from "../pose-probe-core.js";
import { resolveDerivedAttributed } from "../derive.js";
import { recorder, expandDerivedReads } from "../read-recorder.js";
import { desugar } from "../panel/legacy.js";
import { controlNodes } from "../panel/model.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// [{ view, name, a, base }] entries, only when blocks are well-shaped enough to
// walk; `base` is the finding-path prefix `views.<view>.animations.<name>`.
const animEntries = (part) => {
  const out = [];
  if (!isPlainObject(part?.views)) return out;
  for (const [view, v] of Object.entries(part.views)) {
    if (!isPlainObject(v) || !isPlainObject(v.animations)) continue;
    for (const [name, a] of Object.entries(v.animations)) {
      if (isPlainObject(a)) out.push({ view, name, a, base: `views.${view}.animations.${name}` });
    }
  }
  return out;
};

// Steps in normalized-adjacent form for rule walks (does NOT validate — each
// rule checks its own slice). A bare-tracks animation is one anonymous step;
// the spread carries `tracks` AND `opacity` through unchanged.
const rawSteps = (a) => (Array.isArray(a.steps) ? a.steps.filter(isPlainObject) : [{ ...a, label: null }]);

// The control descriptor ranges, for value-in-range checks. Walks the shared
// panel model rather than re-implementing the schema walk — before that model
// existed this duplicated rules-schema.js's collectDescriptors by design, and
// the two could drift.
//
// desugar() is used directly, WITHOUT buildTree(): hidden controls must stay in,
// because an animation may legitimately drive a parameter with no visible UI.
function paramRanges(part) {
  const ranges = new Map();
  for (const c of controlNodes(desugar(part?.parameters))) {
    // A checkbox has no range; only numeric controls constrain a keyframe.
    if (c.type === "checkbox") continue;
    if (typeof c.key === "string" && !ranges.has(c.key)) ranges.set(c.key, { min: c.min, max: c.max });
  }
  return ranges;
}

const validKeyframes = (kf) =>
  Array.isArray(kf) && kf.length >= 2
  && kf.every((e) => Array.isArray(e) && e.length === 2 && Number.isFinite(e[0]) && Number.isFinite(e[1]))
  && kf[0][0] === 0 && kf[kf.length - 1][0] === 1
  && kf.every((e, i) => i === 0 || e[0] > kf[i - 1][0]);

export const ANIMATION_RULES = [
  {
    // Clean break, not a deprecation: viewAnimations() reads only
    // `views.<v>.animations`, so a top-level block animates nothing at all.
    id: "animation-not-in-view",
    run: ({ part }) => (part?.animations === undefined ? [] : [
      err("animation-not-in-view",
        "`animations` moved into views — a top-level block is ignored at runtime",
        "Declare each animation under its owning view: `views.<name>.animations = { <anim>: { … } }`. The transport bar shows only the active view's animations.",
        "animations"),
    ]),
  },
  {
    id: "animations-not-object",
    run: ({ part }) => {
      const out = [];
      if (!isPlainObject(part?.views)) return out;
      for (const [view, v] of Object.entries(part.views)) {
        if (!isPlainObject(v) || v.animations === undefined) continue;
        if (!isPlainObject(v.animations)) {
          out.push(err("animations-not-object", `view "${view}" \`animations\` is not a plain object`,
            "Declare animations as `views.<name>.animations = { <anim>: { duration, tracks } }` — see docs/AUTHORING-PARTS.md \"Animations\".",
            `views.${view}.animations`));
          continue;
        }
        for (const [name, a] of Object.entries(v.animations)) {
          if (isPlainObject(a)) continue;
          out.push(err("animations-not-object", `animation "${name}" is not a plain object`,
            "Each animations entry must be an object with `duration` + `tracks`/`opacity`, or `steps`.",
            `views.${view}.animations.${name}`));
        }
      }
      return out;
    },
  },
  {
    id: "animation-tracks-or-steps",
    run: ({ part }) => {
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        // A single-phase animation may drive params (`tracks`), sub-part
        // opacity, or both — either one puts it in the non-stepped form.
        const hasSingle = a.tracks !== undefined || a.opacity !== undefined;
        const hasSteps = a.steps !== undefined;
        if (hasSingle === hasSteps) {
          out.push(err("animation-tracks-or-steps",
            `animation "${name}" must have exactly one of \`tracks\`/\`opacity\` or \`steps\``,
            "A single-phase animation declares `tracks` and/or `opacity` with a `duration`; a stepped one declares `steps: […]`. Never both forms, never neither.",
            base));
          continue;
        }
        if (hasSteps && (!Array.isArray(a.steps) || a.steps.length === 0 || !a.steps.every(isPlainObject))) {
          out.push(err("animation-tracks-or-steps",
            `animation "${name}" has an empty or malformed \`steps\` array`,
            "`steps` must be a non-empty array of `{ label, duration, tracks }` objects.",
            `${base}.steps`));
          continue;
        }
        const steps = rawSteps(a);
        const animated = (s) => (isPlainObject(s.tracks) && Object.keys(s.tracks).length > 0)
          || (isPlainObject(s.opacity) && Object.keys(s.opacity).length > 0);
        if (!steps.some(animated)) {
          out.push(err("animation-tracks-or-steps",
            `animation "${name}" animates nothing`,
            "At least one step needs a non-empty `tracks` object (param key → keyframes) or a non-empty `opacity` object (sub-part key → keyframes).",
            hasSteps ? `${base}.steps` : `${base}.tracks`));
          continue;
        }
        steps.forEach((s, i) => {
          if (animated(s)) return;
          // A camera-only step is legal: it holds the pose and just moves the
          // camera — an establishing shot before the motion starts. The runtime
          // emits its cue and evaluate() holds the surrounding values, so lint
          // must not reject what plays correctly.
          if (hasSteps && s.camera != null) return;
          out.push(err("animation-tracks-or-steps",
            `animation "${name}"${hasSteps ? ` step ${i}` : ""} has no tracks`,
            "Every step needs a non-empty `tracks` object (param key → keyframes) or an `opacity` object (sub-part key → keyframes) — or, for a step that only moves the camera, a `camera` angle.",
            hasSteps ? `${base}.steps[${i}].tracks` : `${base}.tracks`));
        });
      }
      return out;
    },
  },
  {
    // `tracks` only — opacity keys name SUB-PARTS, not params, and are checked
    // by animation-opacity-unknown-part instead.
    id: "animation-unknown-param",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const known = new Set(Object.keys(part.defaults));
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!known.has(key)) {
              out.push(err("animation-unknown-param",
                `animation "${name}" tracks "${key}", which is not in \`defaults\``,
                `Animations drive existing params — add "${key}" to \`defaults\` (and a control for it), or correct the key.`,
                `${base}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-param-not-numeric",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (key in part.defaults && typeof part.defaults[key] !== "number") {
              out.push(err("animation-param-not-numeric",
                `animation "${name}" tracks "${key}", whose default is not a number`,
                "v1 animations interpolate numeric params only — text/choice params cannot be keyframed.",
                `${base}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    // Keyframe SHAPE is the same contract for both fields, so one rule owns it.
    // Opacity's extra constraint (values in 0..1) is animation-opacity-range's,
    // and it only walks tracks this rule has already accepted.
    id: "animation-keyframes-invalid",
    run: ({ part }) => {
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const field of ["tracks", "opacity"]) {
            for (const [key, kf] of Object.entries(isPlainObject(s[field]) ? s[field] : {})) {
              if (validKeyframes(kf)) continue;
              out.push(err("animation-keyframes-invalid",
                `animation "${name}" ${field === "opacity" ? "opacity track" : "track"} "${key}" has invalid keyframes`,
                "Keyframes are `[[t, value], …]` with finite numbers, at least two entries, `t` strictly ascending from exactly 0 to exactly 1.",
                `${base}${a.steps ? `.steps[${i}]` : ""}.${field}.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-value-out-of-range",
    run: ({ part }) => {
      const ranges = paramRanges(part);
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            const r = ranges.get(key);
            if (!r || !validKeyframes(kf)) continue;
            for (const [, v] of kf) {
              if ((typeof r.min === "number" && v < r.min) || (typeof r.max === "number" && v > r.max)) {
                out.push(err("animation-value-out-of-range",
                  `animation "${name}" track "${key}" keyframe value ${v}, outside the control's range ${r.min ?? "-∞"}..${r.max ?? "∞"}`,
                  "Keyframe values are applied as-is (the engine does not clamp) — widen the control's range or move the keyframe inside it.",
                  `${base}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
                break; // one finding per track
              }
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-opacity-unknown-part",
    run: ({ part }) => {
      const out = [];
      for (const { view, name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.opacity) ? s.opacity : {})) {
            const sub = isPlainObject(part?.parts) ? part.parts[key] : undefined;
            const inView = isPlainObject(sub) && Array.isArray(sub.views) && sub.views.includes(view);
            if (!inView) {
              out.push(err("animation-opacity-unknown-part",
                `animation "${name}" fades "${key}", which is not a sub-part of view "${view}"`,
                `Opacity tracks name sub-parts of the owning view — add "${view}" to \`parts.${key}.views\`, or correct the key.`,
                `${base}${a.steps ? `.steps[${i}]` : ""}.opacity.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-opacity-range",
    run: ({ part }) => {
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const [key, kf] of Object.entries(isPlainObject(s.opacity) ? s.opacity : {})) {
            if (!validKeyframes(kf)) continue; // keyframes rule already reported it
            if (kf.some(([, v]) => v < 0 || v > 1)) {
              out.push(err("animation-opacity-range",
                `animation "${name}" opacity track "${key}" has values outside 0..1`,
                "Opacity is 0 (fully hidden) to 1 (normal); it multiplies any static `display.opacity`.",
                `${base}${a.steps ? `.steps[${i}]` : ""}.opacity.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-duration-invalid",
    run: ({ part }) => {
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          if (!(typeof s.duration === "number" && Number.isFinite(s.duration) && s.duration > 0)) {
            out.push(err("animation-duration-invalid",
              `animation "${name}"${a.steps ? ` step ${i}` : ""} has no positive \`duration\``,
              "Every animation (or step) needs a finite `duration` in seconds, greater than 0.",
              `${base}${a.steps ? `.steps[${i}]` : ""}.duration`));
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-loop-invalid",
    run: ({ part }) => {
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        if (a.loop === undefined) continue;
        // Type first, like `autoplay`. The runtime fails closed (normalizeAnimation
        // reads `spec.loop === true`), so a truthy non-boolean does NOT loop — it
        // silently means `false`. That is the safe default but not an obvious one,
        // so the author has to hear about it here rather than wonder why `loop: 1`
        // does nothing.
        if (typeof a.loop !== "boolean") {
          out.push(err("animation-loop-invalid",
            `animation "${name}" has a non-boolean \`loop\``,
            "`loop` must be `true` or `false`. Any other truthy value still loops at runtime, so it cannot be left to mean something else.",
            `${base}.loop`));
          continue; // one error per field: the check below assumes a real boolean
        }
        if (a.loop && Array.isArray(a.steps) && a.steps.length > 1) {
          out.push(err("animation-loop-invalid",
            `animation "${name}" sets \`loop: true\` on a multi-step animation`,
            "Loop is for continuous single-phase motion (gears). A stepped sequence replays via the transport instead — drop `loop` or collapse to one step.",
            `${base}.loop`));
        }
      }
      return out;
    },
  },
  {
    id: "animation-step-label-duplicate",
    run: ({ part }) => {
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        if (!Array.isArray(a.steps)) continue;
        const seen = new Set();
        a.steps.forEach((s, i) => {
          const label = s?.label;
          if (typeof label !== "string") return;
          if (seen.has(label)) {
            out.push(err("animation-step-label-duplicate",
              `animation "${name}" repeats the step label "${label}"`,
              "Step labels identify steps in the transport UI and the CLI's `--step <label>` — make each unique.",
              `${base}.steps[${i}].label`));
          }
          seen.add(label);
        });
      }
      return out;
    },
  },
  {
    id: "animation-easing-unknown",
    run: ({ part }) => {
      const out = [];
      const check = (easing, path) => {
        // Own-key test, not `in`: `"toString" in EASINGS` is true, so `in` would
        // wave through every Object.prototype member. The runtime (easingFor)
        // applies the same test and falls back to the default, so these names are
        // caught here rather than silently mis-animating or throwing mid-frame.
        if (easing !== undefined && !Object.hasOwn(EASINGS, easing)) {
          out.push(err("animation-easing-unknown",
            `unknown easing "${easing}"`,
            `Use one of: ${Object.keys(EASINGS).join(", ")}.`,
            path));
        }
      };
      for (const { a, base } of animEntries(part)) {
        check(a.easing, `${base}.easing`);
        if (Array.isArray(a.steps)) a.steps.forEach((s, i) => check(s?.easing, `${base}.steps[${i}].easing`));
      }
      return out;
    },
  },
  {
    id: "animation-camera-invalid",
    run: ({ part }) => {
      const out = [];
      const badName = (v) => typeof v !== "string" || !CAMERA_CUE_VIEWS.includes(v);
      // The seven canonical names plus the view cube's corners and edges.
      const angles = `${CANONICAL_VIEWS.join(", ")}, or a view-cube orientation such as top-front-left or top-back-right`;
      for (const { name, a, base } of animEntries(part)) {
        const stepCameras = Array.isArray(a.steps)
          ? a.steps.map((s, i) => [s?.camera, i]).filter(([c]) => c !== undefined && c !== null)
          : [];
        if (a.camera != null && stepCameras.length) {
          out.push(err("animation-camera-invalid",
            `animation "${name}" mixes an animation-level \`camera\` with per-step cameras`,
            "One camera mechanism per animation: either the animation-level name/cue-list, or per-step names — not both.",
            `${base}.camera`));
        }
        for (const [cam, i] of stepCameras) {
          if (badName(cam)) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" step ${i} camera "${cam}" is not a camera angle`,
              `Camera cues use ${angles}.`,
              `${base}.steps[${i}].camera`));
          }
        }
        // An explicit `camera: null` is "no camera", which is how
        // normalizeAnimation reads it — not a malformed value to report.
        if (a.camera == null) continue;
        if (typeof a.camera === "string") {
          if (badName(a.camera)) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" camera "${a.camera}" is not a camera angle`,
              `Camera cues use ${angles}.`,
              `${base}.camera`));
          }
        } else if (Array.isArray(a.camera)) {
          const cues = a.camera;
          const wellFormed = cues.length > 0 && cues.every((c) =>
            Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && c[0] >= 0 && c[0] <= 1 && !badName(c[1]));
          const sorted = cues.every((c, i) => i === 0 || (Array.isArray(c) && Array.isArray(cues[i - 1]) && c[0] > cues[i - 1][0]));
          if (!wellFormed || !sorted) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" has an invalid camera cue list`,
              `Cues are \`[[t, angle], …]\` with t strictly ascending in 0..1 and angles from: ${angles}.`,
              `${base}.camera`));
          }
        } else {
          out.push(err("animation-camera-invalid",
            `animation "${name}" \`camera\` is neither an angle name nor a cue list`,
            "Use a canonical angle string, or `[[t, angle], …]` cues.",
            `${base}.camera`));
        }
      }
      return out;
    },
  },
  {
    id: "animation-description-invalid",
    run: ({ part }) => animEntries(part)
      .filter(({ a }) => a.description !== undefined && typeof a.description !== "string")
      .map(({ name, base }) => err("animation-description-invalid",
        `animation "${name}" \`description\` is not a string`,
        "The description is CommonMark shown behind the ⓘ glyph — supply a string or omit it.",
        `${base}.description`)),
  },
  {
    // note tier: performance shape, not correctness. A track whose param feeds
    // real geometry still plays — just best-effort at worker cadence instead
    // of frame rate — and the authoring agent should know which it wrote.
    id: "animation-track-rebuilds",
    run: ({ part, p }) => {
      const out = [];
      for (const { view, name, a, base } of animEntries(part)) {
        const steps = rawSteps(a);
        // value range per key: the min and max across every keyframe value the
        // key ever takes, over every step that tracks it — not just the first
        // and last keyframe, so an out-and-back track (e.g. a hinge cycle that
        // returns to its start) still compares two genuinely different values.
        const valueRange = new Map();
        for (const s of steps) {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!validKeyframes(kf)) continue; // keyframes rule already reported it
            for (const [, v] of kf) {
              if (!valueRange.has(key)) valueRange.set(key, [v, v]);
              else {
                const range = valueRange.get(key);
                if (v < range[0]) range[0] = v;
                if (v > range[1]) range[1] = v;
              }
            }
          }
        }
        for (const [key, [v0, v1]] of valueRange) {
          if (typeof part?.defaults?.[key] !== "number") continue; // other rules own that
          const cls = classifyTrack(part, p, key, v0, v1, view);
          if (cls === "pose") continue;
          out.push(note("animation-track-rebuilds",
            cls === "rebuild"
              ? `animation "${name}" track "${key}" rebuilds geometry — playback is best-effort, not frame-rate`
              : `animation "${name}" track "${key}" — \`place()\` cannot be probed (it queries the solid or passes a function), so playback is best-effort`,
            cls === "rebuild"
              ? "Frame-rate playback needs the param to be read only by `place()` (or by a trailing translate/rotate in `build`) — if geometry morphing is the intent, this note is expected."
              : "Keep `place()` to translate/rotate of its argument, reading `p`/`d` only; `build()` may query freely.",
            base));
        }
      }
      return out;
    },
  },
  {
    id: "animation-autoplay-invalid",
    run: ({ part }) => {
      const out = [];
      // Autoplay is scoped to the view that owns it: the transport bar shows one
      // view's animations at a time, so two views may each auto-start their own.
      const firstByView = new Map();
      for (const { view, name, a, base } of animEntries(part)) {
        if (a.autoplay !== undefined && typeof a.autoplay !== "boolean") {
          out.push(err("animation-autoplay-invalid",
            `animation "${name}" \`autoplay\` is not a boolean`,
            "Use `autoplay: true` on the one animation in each view that should start on its own.",
            `${base}.autoplay`));
          continue;
        }
        if (a.autoplay !== true) continue;
        if (!firstByView.has(view)) { firstByView.set(view, name); continue; }
        out.push(err("animation-autoplay-invalid",
          `animations "${firstByView.get(view)}" and "${name}" both declare \`autoplay\` in view "${view}"`,
          "Only one animation per view can auto-start — remove `autoplay` from all but one.",
          `${base}.autoplay`));
      }
      return out;
    },
  },
];

// Classify one animated param per sub-part the OWNING view can show, at the
// track's two endpoint values (spec 2026-10-03-place-only-pose §8):
//   1. place-scope probe unreadable at either end → "untrusted" — the only way
//      the untrusted note fires: the viewer cannot pose that mesh without a rebuild.
//   2. build-scope probe trusted at both ends with different baseHash → "rebuild".
//   3. build-scope probe untrusted (build() queries) → "rebuild" when the build
//      READ the key, recorded by the probe run itself and derive-expanded as
//      subPartReadKeys does. A prediction: a read behind a dummy query branch is
//      missed, which costs a missing note, never a wrong behaviour.
//   4. otherwise → "pose".
// A place() that is readable but RESHAPES (scale/mirror/boolean, so its baseHash
// is not CANONICAL) is delivered posed and played by the full-scope delta fast
// path, so it is classified as before that path changed: the full probe trusted
// with equal hashes → "pose", anything else → "rebuild" (the runtime rebuilds it).
// Sub-parts outside the owning view cannot be moved by this animation, so probing
// them would only manufacture false notes.
function classifyTrack(part, p, key, v0, v1, view) {
  let result = "pose";
  for (const sp of Object.values(isPlainObject(part?.parts) ? part.parts : {})) {
    if (!Array.isArray(sp?.views) || !sp.views.includes(view)) continue;
    const ends = [];
    for (const v of [v0, v1]) {
      const pv = { ...p, [key]: v };
      // An endpoint whose derive() or enabled() throws cannot be shown to be
      // pose-only; "best-effort" is the honest claim, and the untrusted note names
      // place() specifically, so it would mislead here.
      let attributed;
      try { attributed = resolveDerivedAttributed(part, pv); } catch { return "rebuild"; }
      const dv = attributed.d ?? {};
      try { if (sp.enabled && !sp.enabled(pv)) { ends.push(null); continue; } } catch { return "rebuild"; }
      const ctx = { view, purpose: "display", p: pv, d: dv };
      const place = probeSubPartPose(sp, ctx, { scope: "place" });
      if (place.baseHash === undefined) return "untrusted";
      if (!place.trusted) { ends.push({ full: probeSubPartPose(sp, ctx) }); continue; }
      const reads = new Set();
      const dSeen = new Set();
      const build = probeSubPartPose(sp, { ...ctx, p: recorder(pv, reads), d: recorder(dv, dSeen) }, { scope: "build" });
      ends.push({ build, reads: expandDerivedReads(reads, dSeen, attributed) });
    }
    const [a, b] = ends;
    if (!a || !b) continue;
    if (a.full || b.full) {
      if (!a.full?.trusted || !b.full?.trusted || a.full.baseHash !== b.full.baseHash) result = "rebuild";
    } else if (a.build.trusted && b.build.trusted) {
      if (a.build.baseHash !== b.build.baseHash) result = "rebuild";
    } else if (a.reads.has(key) || b.reads.has(key)) {
      result = "rebuild";
    }
  }
  return result;
}

// Group — `collisions`: the block a part declares to say what may touch, and the motions
// `verify.sweeps` declares to be checked for contact. Reads the declarations, the
// sub-part names and the geometry-free pose probe, and never throws on a malformed one.
// Nothing here reaches the BVH or the native core (oracle/sweep.js does, so its target
// reading is restated here over the same lint-safe helpers it uses), nor any oracle
// module, which the worker loads lazily (test/worker-layering.test.js) — so the preset
// table is read here as oracle/cases.js's presetMap reads it.
import { err, warn } from "./finding.js";
import { rangesOf, dofsOf } from "../pose/param-solve.js";
import { desugar } from "../panel/legacy.js";
import { viewAnimations, evaluate } from "../animation.js";
import { probePoses } from "../pose-probe.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** Every preset by name, as cases.js's presetMap; throws on a name two sections share. */
function presetMap(part) {
  const map = {};
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.kind === "preset") {
        for (const [name, overrides] of Object.entries(node.presets ?? {})) {
          if (name in map) throw new Error(`duplicate preset name across sections: "${name}"`);
          map[name] = overrides;
        }
      }
      if (node.kind === "group") walk(node.children);
    }
  };
  walk(desugar(part.parameters ?? []));
  return map;
}
const sweepsOf = (part) => (isPlainObject(part?.verify?.sweeps) ? Object.entries(part.verify.sweeps) : []);
const SWEEP_SHAPES = "A sweep names one motion: `{ param: \"angle\" }` (a control with a finite min and max, or an explicit `range: [lo, hi]`), `{ handle: \"lid\" }`, `{ from: \"open\", to: \"shut\" }` (preset names), `{ path: [{…params}, {…params}] }` or `{ animation: \"spin\" }`.";

/**
 * What one sweep declaration moves, read the way oracle/sweep.js's normalizeSweeps reads
 * it: `{ problem }` (a target that cannot be read — the sweep-unknown-target message),
 * `{ goal: true }` (a goal handle: nothing to sweep), or `{ motions: [{ views, ends }] }`,
 * each motion's two end param sets and the views it can run in.
 */
function readSweep(part, p, spec) {
  if (!isPlainObject(spec)) return { problem: "is not an object naming a motion" };
  const ranges = rangesOf(part);
  const allViews = isPlainObject(part.views) ? Object.keys(part.views) : [];
  const views = Array.isArray(spec.views) ? spec.views : allViews;
  const span = (key) => {
    if (Array.isArray(spec.range)) return isNum(spec.range[0]) && isNum(spec.range[1]) && spec.range[1] > spec.range[0] ? spec.range : null;
    const r = ranges.get(key);
    return r && isNum(r.min) && isNum(r.max) && r.max > r.min ? [r.min, r.max] : null;
  };
  const paramMotion = (key, what) => {
    const r = span(key);
    if (r) return { views, ends: [{ ...p, [key]: r[0] }, { ...p, [key]: r[1] }] };
    if (Array.isArray(spec.range)) return { problem: `has a \`range\` that is not [lo, hi] with lo < hi` };
    return { problem: ranges.has(key) ? `${what} "${key}", whose control has no finite min and max` : `${what} "${key}", which is no control in \`parameters\`` };
  };
  if (typeof spec.param === "string") {
    const m = paramMotion(spec.param, "sweeps param");
    return m.problem ? m : { motions: [m] };
  }
  if (typeof spec.handle === "string") {
    const handle = isPlainObject(part.handles) ? part.handles[spec.handle] : undefined;
    if (!isPlainObject(handle)) return { problem: `names handle "${spec.handle}", which is not a key of \`handles\`` };
    if (handle.drag === "goal") return { goal: true };
    const motions = [];
    for (const key of dofsOf(handle, Object.values(part.handles), p)) {
      const m = paramMotion(key, `sweeps handle "${spec.handle}"'s param`);
      if (m.problem) return m;
      motions.push(m);
    }
    return { motions };
  }
  if (typeof spec.from === "string" || typeof spec.to === "string") {
    let presets;
    try { presets = presetMap(part); } catch (e) { return { problem: `names presets, which cannot be read (${e?.message || e})` }; }
    for (const name of [spec.from, spec.to]) {
      if (typeof name !== "string" || !Object.hasOwn(presets, name)) return { problem: `names preset ${JSON.stringify(name)}, which is no preset in \`parameters\` (and needs both \`from\` and \`to\`)` };
    }
    return { motions: [{ views, ends: [{ ...p, ...presets[spec.from] }, { ...p, ...presets[spec.to] }] }] };
  }
  if (Array.isArray(spec.path)) {
    if (spec.path.length < 2 || !spec.path.every(isPlainObject)) return { problem: "has a `path` that is not two or more param objects" };
    return { motions: [{ views, ends: [{ ...p, ...spec.path[0] }, { ...p, ...spec.path.at(-1) }] }] };
  }
  if (typeof spec.animation === "string") {
    const motions = [];
    for (const [view, anims] of viewAnimations(part)) {
      const anim = anims.find((a) => a.name === spec.animation);
      if (!anim || !views.includes(view)) continue;
      motions.push({ views: [view], ends: [0, 1].map((t) => ({ ...p, ...evaluate(anim, t).values })) });
    }
    if (motions.length) return { motions };
    const anywhere = [...viewAnimations(part).values()].some((list) => list.some((a) => a.name === spec.animation));
    return anywhere ? { motions: [] } : { problem: `names animation "${spec.animation}", which no view declares` };
  }
  return { problem: "names no motion" };
}

/** True when some in-view sub-part's build-scope probe differs between the two ends. */
function rebuildsBetween(part, view, a, b) {
  const pa = probePoses(part, view, a, { scope: "build" });
  const pb = probePoses(part, view, b, { scope: "build" });
  for (const [name, ea] of pa) {
    const eb = pb.get(name);
    if (!eb) continue; // enabled at one end only: nothing to compare
    if (!ea.trusted || !eb.trusted || ea.baseHash !== eb.baseHash) return true;
  }
  return false;
}

export const COLLISION_RULES = [
  {
    id: "sweep-unknown-target",
    run: ({ part, p }) => sweepsOf(part).flatMap(([name, spec]) => {
      const r = readSweep(part, p, spec);
      return r.problem
        ? [err("sweep-unknown-target", `verify.sweeps.${name} ${r.problem}`, `${SWEEP_SHAPES} Fix the name, or remove the sweep.`, `verify.sweeps.${name}`)]
        : [];
    }),
  },
  {
    id: "sweep-goal-handle",
    run: ({ part, p }) => sweepsOf(part).flatMap(([name, spec]) => (readSweep(part, p, spec).goal
      ? [warn("sweep-goal-handle", `verify.sweeps.${name} sweeps goal handle "${spec.handle}", which is a target, not a motion, so it is never swept`,
        "Sweep the limb's joint params (`{ param: \"elbow\" }`), a path between presets (`{ from: \"rest\", to: \"reach\" }`) or an animation instead.", `verify.sweeps.${name}`)]
      : [])),
  },
  {
    id: "sweep-rebuilds",
    run: ({ part, p }) => sweepsOf(part).flatMap(([name, spec]) => {
      const r = readSweep(part, p, spec);
      const rebuilds = (r.motions ?? []).some((m) => m.views.some((view) => isPlainObject(part.views?.[view]) && rebuildsBetween(part, view, ...m.ends)));
      return rebuilds
        ? [warn("sweep-rebuilds", `verify.sweeps.${name}: a sub-part's build changes along this motion, so this sweep rebuilds geometry at every step and runs slower`,
          "A sweep moves built pieces by matrix when only `place()` reads its params. If the motion should only move pieces, read its params in the `views` placement rather than in `build()`; a motion that really reshapes a piece is checked at fixed steps only.", `verify.sweeps.${name}`)]
        : [];
    }),
  },
  {
    id: "collisions-bad-clearance",
    run: ({ part }) => {
      const c = part?.collisions;
      if (!isPlainObject(c) || c.clearance === undefined) return [];
      if (typeof c.clearance === "number" && Number.isFinite(c.clearance) && c.clearance >= 0) return [];
      return [err("collisions-bad-clearance", `collisions.clearance is ${JSON.stringify(c.clearance)}, not a number of millimetres at or above 0`,
        "`clearance` is how close two sub-parts may come before they count as touching: `collisions: { clearance: 0.2 }`.", "collisions.clearance")];
    },
  },
  {
    id: "collisions-bad-pair",
    run: ({ part }) => {
      const c = part?.collisions;
      if (!isPlainObject(c) || c.allow === undefined) return [];
      if (!Array.isArray(c.allow)) {
        return [err("collisions-bad-pair", "collisions.allow is not an array of \"a×b\" pair strings",
          "List each pair that may touch as `\"lid×base\"`: `allow: [\"lid×base\"]`.", "collisions.allow")];
      }
      const out = [];
      c.allow.forEach((entry, i) => {
        const parts = typeof entry === "string" ? entry.split("×") : [];
        const ok = parts.length === 2 && parts[0] && parts[1] && parts[0] !== parts[1];
        if (ok) return;
        out.push(err("collisions-bad-pair", `collisions.allow entry ${JSON.stringify(entry)} is not a pair of two different sub-parts joined by "×"`,
          "Write each pair as `\"a×b\"` with two different sub-part names, e.g. `\"lid×base\"`.", `collisions.allow[${i}]`));
      });
      return out;
    },
  },
  {
    id: "collisions-unknown-part",
    run: ({ part }) => {
      const c = part?.collisions;
      if (!isPlainObject(c) || !Array.isArray(c.allow)) return [];
      const names = isPlainObject(part.parts) ? part.parts : {};
      const out = [];
      c.allow.forEach((entry, i) => {
        if (typeof entry !== "string") return;
        const sides = entry.split("×");
        if (sides.length !== 2) return;
        for (const name of sides) {
          if (!name || name in names) continue;
          out.push(err("collisions-unknown-part", `collisions.allow entry ${JSON.stringify(entry)} names "${name}", which is not a sub-part of \`parts\``,
            "Every name in a pair must be a key of `parts`; fix the spelling or remove the entry.", `collisions.allow[${i}]`));
        }
      });
      return out;
    },
  },
];

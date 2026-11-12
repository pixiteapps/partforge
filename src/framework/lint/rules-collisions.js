// Group — `collisions`: the block a part declares to say what may touch, and the motions
// `verify.sweeps` declares to be checked for contact. Reads the declarations, the
// sub-part names and the geometry-free pose probe, and never throws on a malformed one.
// A sweep is read by collide/sweep-targets.js, the BVH-free leaf the sweep engine reads
// it through too, so these rules say what the engine will do; nothing here reaches the
// BVH, the native core or an oracle module.
import { err, warn } from "./finding.js";
import { readSweep, sweepsInView } from "../collide/sweep-targets.js";
import { MOTION_HINT, uncoveredMotions } from "../collide/motion-coverage.js";

// MOTION_HINT's first sentence is the finding's message, the rest its hint.
const MOTION_HEAD_END = "and no sweep checks that motion. ";
function unsweptFinding(m) {
  const text = MOTION_HINT(m);
  const cut = text.indexOf(MOTION_HEAD_END) + MOTION_HEAD_END.length;
  return warn("motion-unswept", text.slice(0, cut - 2), text.slice(cut), "verify.sweeps");
}

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const SWEEP_SHAPES = "A sweep names one motion: `{ param: \"angle\" }` (a control with a finite min and max, or an explicit `range: [lo, hi]`), `{ handle: \"lid\" }`, `{ from: \"open\", to: \"shut\" }` (preset names), `{ path: [{…params}, {…params}] }` or `{ animation: \"spin\" }`.";

// Every declared sweep read ONCE per lint pass and shared by the three sweep rules (the
// rules run on one ctx): `{ name, spec, read }`, plus `rebuilds()`, whether some view's
// motion rebuilds a sub-part — sampled exactly as the engine's scanMotion samples it, an
// untrusted placement or build included — computed on first ask.
const SWEEPS = new WeakMap();
function sweepsOf(ctx) {
  let list = SWEEPS.get(ctx);
  if (list) return list;
  const { part, p } = ctx;
  const decl = isPlainObject(part?.verify?.sweeps) ? Object.entries(part.verify.sweeps) : [];
  const views = isPlainObject(part?.views) ? Object.keys(part.views) : [];
  list = decl.map(([name, spec]) => {
    const read = readSweep(part, name, spec, p);
    let rebuilds;
    return {
      name, spec, read,
      rebuilds: () => (rebuilds ??= views.some((view) => sweepsInView(part, view, name, spec, p, undefined, read).some((s) => s.rebuild?.length))),
    };
  });
  SWEEPS.set(ctx, list);
  return list;
}

export const COLLISION_RULES = [
  {
    id: "sweep-unknown-target",
    run: (ctx) => sweepsOf(ctx).flatMap(({ name, read }) => {
      const why = read.entries?.find((e) => e.why)?.why;
      return why
        ? [err("sweep-unknown-target", `verify.sweeps.${name} ${why}`, `${SWEEP_SHAPES} Fix the name, or remove the sweep.`, `verify.sweeps.${name}`)]
        : [];
    }),
  },
  {
    id: "sweep-goal-handle",
    run: (ctx) => sweepsOf(ctx).flatMap(({ name, spec, read }) => (read.goal
      ? [warn("sweep-goal-handle", `verify.sweeps.${name} sweeps goal handle "${spec.handle}", which is a target, not a motion, so it is never swept`,
        "Sweep the limb's joint params (`{ param: \"elbow\" }`), a path between presets (`{ from: \"rest\", to: \"reach\" }`) or an animation instead.", `verify.sweeps.${name}`)]
      : [])),
  },
  {
    id: "sweep-rebuilds",
    run: (ctx) => sweepsOf(ctx).flatMap(({ name, rebuilds }) => (rebuilds()
      ? [warn("sweep-rebuilds", `verify.sweeps.${name}: a sub-part's build changes along this motion, so this sweep rebuilds geometry at every step and runs slower`,
        "A sweep moves built pieces by matrix when only `place()` reads its params and every placement is a readable rigid transform. If the motion should only move pieces, read its params in the `views` placement rather than in `build()`; a motion that really reshapes a piece is checked at fixed steps only.", `verify.sweeps.${name}`)]
      : [])),
  },
  {
    // A param that poses one piece against another with no sweep checking it. A warning,
    // never an error: a stored forge must still load. Geometry-free; no sweep is run.
    id: "motion-unswept",
    run: (ctx) => {
      // the sweeps as the other sweep rules read them, so each is read once per pass
      let reads;
      try { reads = new Map(sweepsOf(ctx).map(({ name, read }) => [name, read])); } catch { /* read again below */ }
      return uncoveredMotions(ctx.part, ctx.p, reads).map(unsweptFinding);
    },
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
    id: "collisions-bad-pose",
    run: ({ part }) => {
      const c = part?.collisions;
      if (!isPlainObject(c) || c.pose === undefined || typeof c.pose === "boolean") return [];
      return [err("collisions-bad-pose", `collisions.pose is ${JSON.stringify(c.pose)}, not true or false`,
        "`pose` says whether Pose mode keeps pieces solid: `collisions: { pose: false }` turns that off; leave it out for the default (true).", "collisions.pose")];
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
          if (!name || Object.hasOwn(names, name)) continue;
          out.push(err("collisions-unknown-part", `collisions.allow entry ${JSON.stringify(entry)} names "${name}", which is not a sub-part of \`parts\``,
            "Every name in a pair must be a key of `parts`; fix the spelling or remove the entry.", `collisions.allow[${i}]`));
        }
      });
      return out;
    },
  },
];

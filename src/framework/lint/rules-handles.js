// Group — `handles`: draggable points a part declares (spec 2026-11-02). Every handle
// sits `on` a point source in derive's result (a posed limb from partforge/kinematics
// included) or at a `point` function, and moves by its `drag`. Every rule reads only the
// declaration, `defaults` and the resolved `d`, and never throws on a malformed one.
import { err, warn } from "./finding.js";
import { resolveDerived } from "../derive.js";
import { rangesOf } from "../pose/param-solve.js";
import { locateHandle, sourceInfo, resolveGeom, handleAxis } from "../pose/handle-source.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const handleEntries = (part) => (isPlainObject(part?.handles) ? Object.entries(part.handles).filter(([, h]) => isPlainObject(h)) : []);
const LIMB_DRAGS = ["goal", "angles"];
const GEOM_DRAGS = ["point", "axis", "plane", "rotary"];
const DRAGS = [...GEOM_DRAGS, ...LIMB_DRAGS];
/** A limb drag ("goal" / "angles"): the limb-only rules read it. */
const isLimbDrag = (h) => LIMB_DRAGS.includes(h.drag);
/** A handle with a source and a geometric (or unknown) drag: the limb-only rules do not apply to it. */
const isGeneric = (h) => !isLimbDrag(h) && (h.on != null || h.point != null);
const limbHandleEntries = (part) => handleEntries(part).filter(([, h]) => isLimbDrag(h));
const genericEntries = (part) => handleEntries(part).filter(([, h]) => isGeneric(h));
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && Number.isFinite(c));
const isDir3 = (v) => isVec3(v) && v.some((c) => c !== 0);
const NUDGE_MM = 0.01;
const NUDGE_DEG = 0.1;

// The parameter names a handle lists, each with the path it was found at.
function paramRefs(name, h) {
  const base = `handles.${name}`;
  const refs = [];
  if (isGeneric(h)) {
    if (Array.isArray(h.params)) h.params.forEach((n) => refs.push([n, `${base}.params`]));
    if (h.lock !== undefined) refs.push([h.lock, `${base}.lock`]);
    return refs;
  }
  const add = (list, path) => { if (Array.isArray(list)) list.forEach((n) => refs.push([n, path])); };
  if (h.drag === "goal") {
    if (isPlainObject(h.params)) {
      add(h.params.position, `${base}.params.position`);
      add(h.params.aim, `${base}.params.aim`);
    }
    add(h.seed, `${base}.seed`);
  } else if (h.drag === "angles") {
    add(h.params, `${base}.params`);
    if (h.lock !== undefined) refs.push([h.lock, `${base}.lock`]);
    if (isPlainObject(h.joints)) {
      for (const [key, entry] of Object.entries(h.joints)) {
        const path = `${base}.joints.${key}`;
        if (typeof entry === "string") refs.push([entry, path]);
        else if (isPlainObject(entry) && "param" in entry) refs.push([entry.param, path]);
        else if (isPlainObject(entry) && BALL_KEYS.some((k) => k in entry)) BALL_KEYS.forEach((k) => { if (k in entry) refs.push([entry[k], `${path}.${k}`]); });
        else refs.push([entry, path]);
      }
    }
  }
  return refs;
}

const BALL_KEYS = ["bend", "spread", "twist"];
/** A `joints` key's limb (null: the handle's own) and joint, split at the last ".". */
const splitJointKey = (key) => { const i = key.lastIndexOf("."); return i < 0 ? { limb: null, joint: key } : { limb: key.slice(0, i), joint: key.slice(i + 1) }; };

/** One `joints` entry's shape problem against its joint record (ikInfo), or null. */
function jointEntryProblem(entry, joint) {
  if (joint.type === "ball") {
    if (isPlainObject(entry) && BALL_KEYS.some((k) => k in entry) && Object.keys(entry).every((k) => BALL_KEYS.includes(k))) return null;
    return `is a ball joint: map it as { bend?, spread?, twist? }, each a parameter name`;
  }
  if (joint.follower) return "follows another joint and takes no value of its own";
  if (typeof entry === "string") return null;
  if (isPlainObject(entry) && typeof entry.param === "string" && Object.keys(entry).every((k) => k === "param" || k === "scale")) {
    if (entry.scale === undefined || (typeof entry.scale === "number" && Number.isFinite(entry.scale) && entry.scale !== 0)) return null;
    return "has a scale that is not a finite, non-zero number";
  }
  return 'is a hinge: map it to a parameter name, or { param, scale? }';
}

const isDirection = (v) => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && Number.isFinite(c)) && v.some((c) => c !== 0);
const isLimb = (d, key) => typeof d?.[key]?.ikInfo === "function";

/** `fn()` or the error it threw: { v } | { error }. */
const attempt = (fn) => { try { return { v: fn() }; } catch (e) { return { error: e?.message || String(e) }; } };

/** Where an `on` handle's source stands: { ok, finding? } - the shape problem, or the source info. */
function sourceProblem(name, h, d) {
  const base = `handles.${name}`;
  if (typeof h.on !== "string" || !d || !(h.on in d)) {
    return { finding: err("handle-unknown-source", `handle "${name}" has on ${JSON.stringify(h.on)}, which derive() does not return`,
      "`on` must be a key of the object `derive` returns, holding a point source (a value with a `handleInfo()` method).", `${base}.on`) };
  }
  // a limb is checked as a point source only under a geometric drag; otherwise
  // handle-bad-drag says what it is missing
  if (isLimb(d, h.on) && !GEOM_DRAGS.includes(h.drag)) return { limb: true };
  if (typeof d[h.on]?.handleInfo !== "function") {
    return { finding: err("handle-unknown-source", `handle "${name}" has on ${JSON.stringify(h.on)}, but derive().${h.on} has no handleInfo()`,
      "A point source is a value in derive's result with a `handleInfo()` method returning { kind: \"partforge.points\", points: { name: [x, y, z] }, axes?, lines? }.", `${base}.on`) };
  }
  const info = attempt(() => sourceInfo(d, h.on));
  if (info.error || !info.v || !isPlainObject(info.v.points)) {
    return { finding: err("handle-unknown-source", `handle "${name}": derive().${h.on}.handleInfo() ${info.error ? `throws (${info.error})` : "returns no `points` object"}`,
      "`handleInfo()` must return plain JSON with a `points` object of named [x, y, z] points.", `${base}.on`) };
  }
  const names = Object.keys(info.v.points);
  if (typeof h.at !== "string" || !names.includes(h.at)) {
    return { finding: err("handle-unknown-source", `handle "${name}" has at ${JSON.stringify(h.at)}, which is not a point of derive().${h.on}`,
      `\`at\` must be one of the source's points: ${names.join(", ") || "(none)"}.`, `${base}.at`) };
  }
  return { info: info.v };
}

/** The step a lint nudge moves a parameter by: its step, 1% of its range, or 0.1. */
function nudgeFor(part, key) {
  const r = rangesOf(part).get(key);
  if (r && Number.isFinite(r.step) && r.step > 0) return r.step;
  if (r && Number.isFinite(r.min) && Number.isFinite(r.max) && r.max > r.min) return 0.01 * (r.max - r.min);
  return 0.1;
}

/** The numeric params a generic handle lists that exist in `defaults`. */
function listedNumeric(part, h) {
  const defaults = isPlainObject(part?.defaults) ? part.defaults : {};
  return (Array.isArray(h.params) ? h.params : []).filter((k) => typeof k === "string" && typeof defaults[k] === "number" && Number.isFinite(defaults[k]));
}

/** The derived value at `p` with `key` moved by `delta`, or null when derive throws there. */
function derivedNudged(part, p, key, delta) {
  const r = attempt(() => resolveDerived(part, { ...p, [key]: p[key] + delta }));
  return r.error ? null : (r.v ?? {});
}

export const HANDLE_RULES = [
  {
    id: "handle-unknown-param",
    run: ({ part }) => {
      const defaults = isPlainObject(part?.defaults) ? part.defaults : {};
      const out = [];
      for (const [name, h] of handleEntries(part)) {
        if (isGeneric(h) && DRAGS.includes(h.drag ?? "point") && h.params !== undefined && !Array.isArray(h.params)) {
          out.push(err("handle-unknown-param", `handle "${name}" has \`params\` that is not an array of parameter names`,
            "`params` lists the numeric parameters the drag may write: `params: [\"driveAngle\"]`.", `handles.${name}.params`));
        }
        for (const [pname, path] of paramRefs(name, h)) {
          const v = typeof pname === "string" ? defaults[pname] : undefined;
          if (typeof v === "number" && Number.isFinite(v)) continue;
          // A lock is only read for truthiness, so a checkbox's boolean default suits it.
          if (path.endsWith(".lock") && typeof v === "boolean") continue;
          out.push(err("handle-unknown-param", `handle "${name}" lists parameter ${JSON.stringify(pname)}, which is not a numeric entry in \`defaults\``,
            "Every parameter a handle drives or seeds must be a key of `defaults` whose default is a finite number; a lock's may also be a boolean.",
            path.endsWith(".params.position") || path.endsWith(".params.aim") ? path.replace(/\.(position|aim)$/, "") : path));
        }
      }
      return out;
    },
  },
  {
    id: "handle-param-count",
    run: ({ part }) => {
      const out = [];
      for (const [name, h] of handleEntries(part)) {
        if (h.drag !== "goal" || !isPlainObject(h.params)) continue;
        const { position, aim } = h.params;
        if (!Array.isArray(position) || position.length !== 3) {
          out.push(err("handle-param-count", `handle "${name}" needs params.position to name exactly 3 parameters (x, y, z)`,
            "Declare `params: { position: [\"x\", \"y\", \"z\"] }` — one parameter per axis.", `handles.${name}.params`));
        }
        if (aim !== undefined && (!Array.isArray(aim) || (aim.length !== 2 && aim.length !== 3))) {
          out.push(err("handle-param-count", `handle "${name}" needs params.aim to name 2 or 3 parameters`,
            "`aim` is optional; give it two parameters (pitch, yaw in degrees) or three (pitch, yaw, roll in degrees), the angles aimFromAngles reads.", `handles.${name}.params`));
        }
      }
      return out;
    },
  },
  {
    id: "handle-aim-toward",
    run: ({ part }) => handleEntries(part)
      .filter(([, h]) => h.drag === "goal" && isPlainObject(h.params) && h.params.aim !== undefined && !isDirection(h.toward))
      .map(([name]) => err("handle-aim-toward", `handle "${name}" has an aim but no rest \`toward\``,
        "Set `toward: [x, y, z]` on the handle: the direction zero pitch and yaw point, the same `toward` the part passes aimFromAngles. Pose mode's rotate rings turn about axes built from it.",
        `handles.${name}.toward`)),
  },
  {
    id: "handle-unknown-joint",
    run: ({ part, d }) => {
      const out = [];
      for (const [name, h] of limbHandleEntries(part)) {
        if (h.drag !== "goal" || h.at === undefined || h.at === "tip" || !isLimb(d, h.on)) continue;
        let joints;
        try { joints = d[h.on].ikInfo().joints.map((j) => j.name); } catch { continue; }
        if (joints.includes(h.at)) continue;
        out.push(err("handle-unknown-joint", `handle "${name}" has at ${JSON.stringify(h.at)}, which is not a joint of limb "${h.on}"`,
          `\`at\` must be "tip" or one of the limb's joint names: ${joints.join(", ")}.`, `handles.${name}.at`));
      }
      // `joints` (an angles handle's joint rings): each key a joint of the handle's limb or
      // "<limb>.<joint>" of another posed limb, each entry the shape its joint takes.
      for (const [name, h] of limbHandleEntries(part)) {
        if (h.joints === undefined) continue;
        const base = `handles.${name}.joints`;
        if (h.drag !== "angles" || !isPlainObject(h.joints)) {
          out.push(err("handle-unknown-joint", `handle "${name}" has \`joints\` that Pose mode cannot read`,
            "`joints` is an angles handle's object `{ \"<joint>\" | \"<limb>.<joint>\": \"<param>\" }`; a goal handle gets its joint rings from `seed`.", base));
          continue;
        }
        for (const [key, entry] of Object.entries(h.joints)) {
          const { limb, joint } = splitJointKey(key);
          const limbKey = limb ?? h.on;
          if (!isLimb(d, limbKey)) {
            if (limb === null && !isLimb(d, h.on)) continue; // handle-unknown-source already says so
            out.push(err("handle-unknown-joint", `handle "${name}" maps joints ${JSON.stringify(key)}, but derive() returns no posed limb ${JSON.stringify(limbKey)}`,
              "A `joints` key is a joint of the handle's limb, or \"<limb>.<joint>\" where <limb> is a key of derive's result holding a posed limb.", `${base}.${key}`));
            continue;
          }
          let joints;
          try { joints = d[limbKey].ikInfo().joints; } catch { continue; }
          const j = joints.find((x) => x.name === joint);
          if (!j) {
            out.push(err("handle-unknown-joint", `handle "${name}" maps joints ${JSON.stringify(key)}, which is not a joint of limb "${limbKey}"`,
              `Name one of the limb's joints: ${joints.map((x) => x.name).join(", ")}.`, `${base}.${key}`));
            continue;
          }
          const problem = jointEntryProblem(entry, j);
          if (problem) {
            out.push(err("handle-unknown-joint", `handle "${name}" maps joints ${JSON.stringify(key)}, which ${problem}`,
              "A hinge maps to the parameter that drives it in degrees (\"<param>\", or { param, scale } when the joint turns scale × param); a ball to { bend?, spread?, twist? }.", `${base}.${key}`));
          }
        }
      }
      return out;
    },
  },
  {
    id: "handle-no-source",
    run: ({ part }) => handleEntries(part)
      .filter(([, h]) => (h.on != null) === (h.point != null))
      .map(([name, h]) => err("handle-no-source", h.on == null ? `handle "${name}" says nothing about where it is` : `handle "${name}" has both on and point`,
        "Give each handle exactly one source: `on` (a key of derive's result: a point source with `at`, or a posed limb) or `point: (p, d) => [x, y, z]`.", `handles.${name}`)),
  },
  {
    id: "handle-unknown-source",
    run: ({ part, d, deriveError }) => {
      if (deriveError) return []; // derive-throws already says so; `d` is empty
      const out = [];
      for (const [name, h] of limbHandleEntries(part)) {
        if (h.on == null || isLimb(d, h.on)) continue;
        out.push(err("handle-unknown-source", `handle "${name}" drags by ${h.drag}, but on ${JSON.stringify(h.on)} is not a posed limb in derive()`,
          `A "goal" or "angles" handle's \`on\` must be a key of the object \`derive\` returns, holding the result of \`limb(...).pose(...)\` from partforge/kinematics.`,
          `handles.${name}.on`));
      }
      for (const [name, h] of genericEntries(part)) {
        if (h.on == null) continue;
        const r = sourceProblem(name, h, d);
        if (r.finding) out.push(r.finding);
      }
      return out;
    },
  },
  {
    id: "handle-bad-drag",
    run: ({ part, p, d, deriveError }) => {
      const out = [];
      for (const [name, h] of handleEntries(part)) {
        if (h.on == null && h.point == null) continue; // handle-no-source
        const base = `handles.${name}`;
        if (h.drag === undefined && h.on != null && isLimb(d, h.on)) {
          out.push(err("handle-bad-drag", `handle "${name}" is on the posed limb ${JSON.stringify(h.on)} but sets no drag`,
            'A handle on a limb sets `drag: "goal"` (drag a point; params: { position, aim? }) or `drag: "angles"` (drag joint values directly; params: [names]); "point", "axis", "plane" and "rotary" drag one of its points like any source\'s.', `${base}.drag`));
          continue;
        }
        const drag = h.drag === undefined ? "point" : h.drag;
        if (!DRAGS.includes(drag)) {
          out.push(err("handle-bad-drag", `handle "${name}" has drag ${JSON.stringify(h.drag)}`,
            `\`drag\` is one of ${DRAGS.map((x) => `"${x}"`).join(", ")} (default "point"; "goal" and "angles" on a posed limb only).`, `${base}.drag`));
          continue;
        }
        if (isLimbDrag(h)) {
          if (h.on == null) {
            out.push(err("handle-bad-drag", `handle "${name}" drags by ${drag}, which needs \`on\` naming a posed limb`,
              `"goal" and "angles" pose a limb: set \`on\` to the derive key of a posed limb, or use a geometric drag ("point", "axis", "plane", "rotary") with \`point\`.`, `${base}.drag`));
          }
          continue;
        }
        if (drag === "point" || deriveError) continue;
        const field = drag === "axis" ? "direction" : drag === "plane" ? "normal" : "axis";
        if (drag === "rotary") {
          const given = attempt(() => resolveGeom(h.axis, p, d));
          if (given.error) continue; // handle-point-throws reports the throwing axis function
          if (isPlainObject(given.v) && isVec3(given.v.origin) && isDir3(given.v.direction)) continue;
          let fromSource = false;
          if (h.on != null && !sourceProblem(name, h, d).info) continue; // the source itself is the finding
          if (h.on != null) {
            const ax = attempt(() => sourceInfo(d, h.on)?.axes?.[String(h.at).split(".")[0]]).v;
            fromSource = isPlainObject(ax) && isVec3(ax.origin) && isDir3(ax.direction);
          }
          if (!fromSource) {
            out.push(err("handle-bad-drag", `handle "${name}" turns about an axis, but has none it can find`,
              "A rotary handle needs `axis: { origin: [x, y, z], direction: [x, y, z] }` (or a `(p, d) => ...` returning it), or an `on` source whose `axes` has an entry for the prefix of `at`.", `${base}.axis`));
          }
          continue;
        }
        const v = attempt(() => resolveGeom(h[field], p, d));
        if (v.error) continue;
        if (drag === "axis" && !isDir3(v.v) && h.on != null) {
          if (!sourceProblem(name, h, d).info) continue; // the source itself is the finding
          const ax = attempt(() => sourceInfo(d, h.on)?.axes?.[String(h.at).split(".")[0]]).v;
          if (isPlainObject(ax) && isDir3(ax.direction)) continue; // the source's axis gives the direction
        }
        if (!isDir3(v.v)) {
          out.push(err("handle-bad-drag", `handle "${name}" drags by ${drag} but has no usable \`${field}\``,
            `\`${field}\` is a non-zero [x, y, z] in part coordinates, or a \`(p, d) => [x, y, z]\` function${drag === "axis" ? " (an \`on\` source whose \`axes\` has an entry for the prefix of \`at\` supplies it)" : ""}.`, `${base}.${field}`));
        }
      }
      return out;
    },
  },
  {
    id: "handle-point-throws",
    run: ({ part, p, d, deriveError }) => {
      if (deriveError) return [];
      const out = [];
      for (const [name, h] of genericEntries(part)) {
        const base = `handles.${name}`;
        if (h.on != null && !sourceProblem(name, h, d).info) continue; // handle-unknown-source / handle-bad-drag
        const at = attempt(() => locateHandle(part, p, d, h));
        if (at.error) {
          out.push(err("handle-point-throws", `handle "${name}" has no readable point at the defaults: ${at.error}`,
            "`point` must be a pure `(p, d) => [x, y, z]` returning three finite numbers for every parameter set the drag reaches; `on` + `at` must name a point whose value is [x, y, z].", h.point != null ? `${base}.point` : `${base}.at`));
          continue;
        }
        if (h.drag === "rotary" && typeof h.axis === "function") {
          const ax = attempt(() => h.axis(p, d));
          if (ax.error) {
            out.push(err("handle-point-throws", `handle "${name}": its axis function throws at the defaults: ${ax.error}`,
              "`axis` as a function must return { origin, direction } for every parameter set.", `${base}.axis`));
          }
        }
        for (const field of ["direction", "normal"]) {
          if (typeof h[field] !== "function") continue;
          const r = attempt(() => h[field](p, d));
          if (r.error) {
            out.push(err("handle-point-throws", `handle "${name}": its ${field} function throws at the defaults: ${r.error}`,
              `\`${field}\` as a function must return an [x, y, z] for every parameter set.`, `${base}.${field}`));
          }
        }
      }
      return out;
    },
  },
  {
    id: "handle-inert",
    run: ({ part, p, d, deriveError }) => {
      if (deriveError) return [];
      const out = [];
      for (const [name, h] of genericEntries(part)) {
        if (h.on != null && !sourceProblem(name, h, d).info) continue;
        const here = attempt(() => locateHandle(part, p, d, h));
        if (here.error) continue; // handle-point-throws
        const keys = listedNumeric(part, h);
        const listed = Array.isArray(h.params) ? h.params.length : 0;
        if (listed > 0 && keys.length === 0) continue; // handle-unknown-param
        let moved = false;
        for (const key of keys) {
          const d2 = derivedNudged(part, p, key, nudgeFor(part, key));
          const there = d2 && attempt(() => locateHandle(part, { ...p, [key]: p[key] + nudgeFor(part, key) }, d2, h));
          if (!there || there.error || Math.hypot(...there.v.map((c, i) => c - here.v[i])) >= NUDGE_MM) { moved = true; break; }
        }
        if (!moved) {
          out.push(warn("handle-inert", `handle "${name}" does nothing at the defaults: ${keys.length ? `nudging each of ${keys.map((k) => JSON.stringify(k)).join(", ")} by one step moves its point less than ${NUDGE_MM} mm` : "it lists no `params` to drive"}`,
            "List the numeric parameters that move the handle's point in `params`, and make sure `derive` / `point` read them; a handle whose point ignores its params cannot be dragged.", `handles.${name}.params`));
        }
      }
      return out;
    },
  },
  {
    id: "handle-axis-moves",
    run: ({ part, p, d, deriveError }) => {
      if (deriveError) return [];
      const out = [];
      for (const [name, h] of genericEntries(part)) {
        if (h.drag !== "rotary") continue;
        if (h.on != null && !sourceProblem(name, h, d).info) continue;
        const a0 = attempt(() => handleAxis(h, p, d));
        if (a0.error || !a0.v) continue;
        for (const key of listedNumeric(part, h)) {
          const delta = nudgeFor(part, key);
          const d2 = derivedNudged(part, p, key, delta);
          const a1 = d2 && attempt(() => handleAxis(h, { ...p, [key]: p[key] + delta }, d2));
          if (!a1 || a1.error || !a1.v) continue;
          const origin = Math.hypot(...a1.v.origin.map((c, i) => c - a0.v.origin[i]));
          const u = a0.v.direction, w = a1.v.direction;
          const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
          const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
          if (origin > NUDGE_MM || angle > NUDGE_DEG) {
            out.push(warn("handle-axis-moves", `handle "${name}" turns about an axis that moves when its own parameter ${JSON.stringify(key)} changes`,
              "A rotary handle's axis must stay put while the handle's `params` change (a gear's centre does not turn with the gear). Make `axis` / the source's `axes` depend on other parameters only.", `handles.${name}.axis`));
            break;
          }
        }
      }
      return out;
    },
  },
];

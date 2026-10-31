// Group — `handles`: draggable inverse-kinematics points a part declares over a limb
// (partforge/kinematics). Every rule reads only the declaration, `defaults` and the
// resolved `d`, and never throws on a malformed one.
import { err } from "./finding.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const handleEntries = (part) => (isPlainObject(part?.handles) ? Object.entries(part.handles).filter(([, h]) => isPlainObject(h)) : []);
const MODES = ["goal", "angles"];

// The parameter names a handle lists, each with the path it was found at.
function paramRefs(name, h) {
  const base = `handles.${name}`;
  const refs = [];
  const add = (list, path) => { if (Array.isArray(list)) list.forEach((n) => refs.push([n, path])); };
  if (h.mode === "goal") {
    if (isPlainObject(h.params)) {
      add(h.params.position, `${base}.params.position`);
      add(h.params.aim, `${base}.params.aim`);
    }
    add(h.seed, `${base}.seed`);
  } else if (h.mode === "angles") {
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

export const HANDLE_RULES = [
  {
    id: "handle-bad-mode",
    run: ({ part }) => handleEntries(part)
      .filter(([, h]) => !MODES.includes(h.mode))
      .map(([name, h]) => err("handle-bad-mode", `handle "${name}" has mode ${JSON.stringify(h.mode)}`,
        'Set `mode` to "goal" (drag a point; params: { position, aim? }) or "angles" (drag joint values directly; params: [names]).',
        `handles.${name}.mode`)),
  },
  {
    id: "handle-unknown-limb",
    run: ({ part, d }) => handleEntries(part)
      .filter(([, h]) => !isLimb(d, h.limb))
      .map(([name, h]) => err("handle-unknown-limb", `handle "${name}" names limb ${JSON.stringify(h.limb)}, which derive() does not return as a posed limb`,
        "`limb` must be a key of the object `derive` returns, holding the result of `limb(...).pose(...)` from partforge/kinematics.",
        `handles.${name}.limb`)),
  },
  {
    id: "handle-unknown-param",
    run: ({ part }) => {
      const defaults = isPlainObject(part?.defaults) ? part.defaults : {};
      const out = [];
      for (const [name, h] of handleEntries(part)) {
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
        if (h.mode !== "goal" || !isPlainObject(h.params)) continue;
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
      .filter(([, h]) => h.mode === "goal" && isPlainObject(h.params) && h.params.aim !== undefined && !isDirection(h.toward))
      .map(([name]) => err("handle-aim-toward", `handle "${name}" has an aim but no rest \`toward\``,
        "Set `toward: [x, y, z]` on the handle: the direction zero pitch and yaw point, the same `toward` the part passes aimFromAngles. Pose mode's rotate rings turn about axes built from it.",
        `handles.${name}.toward`)),
  },
  {
    id: "handle-unknown-joint",
    run: ({ part, d }) => {
      const out = [];
      for (const [name, h] of handleEntries(part)) {
        if (h.mode !== "goal" || h.at === undefined || h.at === "tip" || !isLimb(d, h.limb)) continue;
        let joints;
        try { joints = d[h.limb].ikInfo().joints.map((j) => j.name); } catch { continue; }
        if (joints.includes(h.at)) continue;
        out.push(err("handle-unknown-joint", `handle "${name}" has at ${JSON.stringify(h.at)}, which is not a joint of limb "${h.limb}"`,
          `\`at\` must be "tip" or one of the limb's joint names: ${joints.join(", ")}.`, `handles.${name}.at`));
      }
      // `joints` (an angles handle's joint rings): each key a joint of the handle's limb or
      // "<limb>.<joint>" of another posed limb, each entry the shape its joint takes.
      for (const [name, h] of handleEntries(part)) {
        if (h.joints === undefined) continue;
        const base = `handles.${name}.joints`;
        if (h.mode !== "angles" || !isPlainObject(h.joints)) {
          out.push(err("handle-unknown-joint", `handle "${name}" has \`joints\` that Pose mode cannot read`,
            "`joints` is an angles handle's object `{ \"<joint>\" | \"<limb>.<joint>\": \"<param>\" }`; a goal handle gets its joint rings from `seed`.", base));
          continue;
        }
        for (const [key, entry] of Object.entries(h.joints)) {
          const { limb, joint } = splitJointKey(key);
          const limbKey = limb ?? h.limb;
          if (!isLimb(d, limbKey)) {
            if (limb === null && !isLimb(d, h.limb)) continue; // handle-unknown-limb already says so
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
];

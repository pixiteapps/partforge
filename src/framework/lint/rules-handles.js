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
  }
  return refs;
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
          out.push(err("handle-unknown-param", `handle "${name}" lists parameter ${JSON.stringify(pname)}, which is not a numeric entry in \`defaults\``,
            "Every parameter a handle drives, seeds or locks must be a key of `defaults` whose default is a finite number.",
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
      return out;
    },
  },
];

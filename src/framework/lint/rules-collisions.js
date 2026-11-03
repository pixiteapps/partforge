// Group — `collisions`: the block a part declares to say what may touch. Reads only the
// declaration and the sub-part names, and never throws on a malformed one. Imports
// finding.js alone, so the lint closure never reaches the BVH or the native core.
import { err } from "./finding.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export const COLLISION_RULES = [
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

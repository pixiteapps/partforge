// Group — `lines`: the ropes and cables a part declares in its top-level `lines` block
// (lines/read.js). Derive only: a line is read out of `derive`'s output, never built, so
// nothing here reaches the kernel, the BVH or an oracle module. Never throws on a malformed
// block: what cannot be read is reported, or skipped.
import { err, warn } from "./finding.js";
import { normalizeLines, readLine } from "../lines/read.js";
import { resolveParams } from "../part-model.js";
import { rangesOf } from "../pose/param-solve.js";
import { continuousKeys, coveredParams, readSweeps } from "../collide/motion-coverage.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// How far a line's points must move for the line to count as moving with a param (mm).
const POINT_EPS = 1e-6;
// Where along each continuous control's range a param is sampled (fractions of the range).
const SAMPLES = [0, 0.5, 1];

const BLOCK_SHAPE = "Declare each line as `lines: { rope: { on: \"drive\" } }`: `on` names a key of `derive`'s output whose value has `lineInfo()` (a `capstan` from `partforge/mechanisms`), `line` picks one of its lines (default: the entry's own name), `views` (optional) lists the views it shows in, and `display: { color: 0xRRGGBB }` (optional) sets its colour.";

const show = (v) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

/** Whether two point lists differ by more than POINT_EPS in any coordinate (or in count). */
function pointsDiffer(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    if (!Array.isArray(p) || !Array.isArray(q) || p.length !== q.length) return true;
    for (let j = 0; j < p.length; j++) if (!(Math.abs(p[j] - q[j]) <= POINT_EPS)) return true;
  }
  return false;
}

function badSource({ part, d, deriveError }) {
  const block = part?.lines;
  if (block === undefined) return [];
  if (!isPlainObject(block)) {
    return [err("line-bad-source", "`lines` is not an object of named line declarations", BLOCK_SHAPE, "lines")];
  }
  const views = isPlainObject(part?.views) ? part.views : {};
  const out = [];
  const read = new Map(normalizeLines(part).map((e) => [e.name, e]));
  for (const [name, e] of Object.entries(block)) {
    const path = `lines.${name}`;
    if (!isPlainObject(e) || typeof e.on !== "string" || !e.on) {
      const on = isPlainObject(e) ? e.on : undefined;
      out.push(err("line-bad-source", `lines.${name} ${on === undefined ? "names no source (`on`)" : `has \`on: ${show(on)}\`, not the name of a key of derive's output`}`,
        BLOCK_SHAPE, path));
      continue;
    }
    if (e.views !== undefined) {
      if (!Array.isArray(e.views)) {
        out.push(err("line-bad-source", `lines.${name}.views is not an array of view names`,
          `List the views the line shows in by their keys of \`views\`: \`views: [${Object.keys(views).map((v) => JSON.stringify(v)).join(", ")}]\`, or leave \`views\` out to show it in every view.`, path));
      } else if (!e.views.length) {
        out.push(err("line-bad-source", `lines.${name}.views is empty, so the line is shown in no view`,
          `List the views the line shows in (${Object.keys(views).map((x) => JSON.stringify(x)).join(", ") || "none declared"}), or leave \`views\` out to show it in every view; remove the entry if the line is not needed.`, path));
      } else {
        for (const v of e.views) {
          if (typeof v === "string" && Object.hasOwn(views, v)) continue;
          out.push(err("line-bad-source", `lines.${name}.views names ${show(v)}, which is not a key of \`views\``,
            `Every name in a line's \`views\` must be a key of \`views\` (${Object.keys(views).map((x) => JSON.stringify(x)).join(", ") || "none declared"}); fix the spelling or remove it.`, path));
        }
      }
    }
    if (e.display !== undefined && (!isPlainObject(e.display) || (e.display.color !== undefined && !(Number.isInteger(e.display.color) && e.display.color >= 0 && e.display.color <= 0xffffff)))) {
      out.push(err("line-bad-source", `lines.${name}.display is not \`{ color: 0xRRGGBB }\``,
        "`display` (optional) is an object whose `color` is an integer from 0 to 0xffffff, e.g. `display: { color: 0xff0000 }`; leave it out for the default rope colour.", path));
    }
    // a derive that throws is derive-throws' to report: d is then {} and every source reads as missing
    if (deriveError) continue;
    const decl = read.get(name);
    if (!decl) continue;
    try {
      readLine(d, decl);
    } catch (ex) {
      out.push(err("line-bad-source", `${ex?.message || String(ex)} at the defaults`,
        `\`on\` must name a key of \`derive\`'s output whose value has \`lineInfo()\` returning \`{ kind: "partforge.lines", lines: { <name>: { length, points, … } } }\`, and \`line\` (default: the entry's name, "${name}") one of those lines. Fix the name, or the source so it reads at the defaults.`, path));
    }
  }
  return out;
}

/**
 * The continuous params each readable line moves with: name → [param], each param's line
 * sampled at SAMPLES of its range with the others at `p`, against its points at `p`.
 * A sample whose derive or line read throws is skipped (verify reports it along a sweep).
 */
function movingParams(part, p, d, lines) {
  const base = new Map();
  for (const decl of lines) {
    try { base.set(decl.name, readLine(d, decl).points); } catch { /* line-bad-source */ }
  }
  const out = new Map([...base.keys()].map((n) => [n, []]));
  if (!base.size) return out;
  const continuous = continuousKeys(part);
  if (!continuous) return out;
  for (const [param, r] of rangesOf(part)) {
    if (!continuous.has(param) || !isNum(r.min) || !isNum(r.max) || !(r.max > r.min)) continue;
    const ds = [];
    for (const f of SAMPLES) {
      try { ds.push(resolveParams(part, { ...p, [param]: r.min + (r.max - r.min) * f }).d); } catch { /* skipped */ }
    }
    for (const decl of lines) {
      if (!base.has(decl.name)) continue;
      const moves = ds.some((ds1) => {
        try { return pointsDiffer(readLine(ds1, decl).points, base.get(decl.name)); } catch { return false; }
      });
      if (moves) out.get(decl.name).push(param);
    }
  }
  return out;
}

function unswept({ part, p, d, deriveError }) {
  if (deriveError || !isPlainObject(part?.views)) return [];
  const lines = normalizeLines(part);
  if (!lines.length) return [];
  const moving = movingParams(part, p, d, lines);
  const viewNames = Object.keys(part.views);
  const reads = readSweeps(part, p);
  const covered = new Map();
  const coveredIn = (view) => {
    if (!covered.has(view)) covered.set(view, coveredParams(part, view, p, reads));
    return covered.get(view);
  };
  const out = [];
  for (const decl of lines) {
    const shown = viewNames.filter((v) => decl.views == null || decl.views.includes(v));
    for (const param of moving.get(decl.name) ?? []) {
      const view = shown.find((v) => !coveredIn(v).has(param));
      if (view === undefined) continue;
      const key = /^[A-Za-z_$][\w$]*$/.test(param) ? param : JSON.stringify(param);
      out.push(warn("line-unswept",
        `line "${decl.name}" moves with "${param}" in view "${view}" and no sweep reads it along that motion`,
        `Add verify.sweeps: { ${key}: { param: ${JSON.stringify(param)} } } and verify.expect._view: { lineDrift: "<=0.2" }, so the line's length is read along the motion and a rope that goes slack fails.`,
        "verify.sweeps"));
    }
  }
  return out;
}

export const LINE_RULES = [
  { id: "line-bad-source", run: badSource },
  // A warning, never an error: a moving line with no sweep is unchecked, not broken.
  { id: "line-unswept", run: unswept },
];

// sweepRanges: which poses of a part do not build (spec 2026-11-24 cage authoring tools,
// section 4). `partforge measure <part> [view] --ranges` prints it.
//
// The poses, in order: the defaults; every ranged control at its min and at its max with
// the others at their defaults; every ranged control at min at once, and at max at once;
// then `random` poses from a seeded generator, so the same seed gives the same poses. A
// ranged control is one with a finite min and max. Every other control keeps its default.
//
// Each pose builds the view through the same buildView call measure makes, then frees the
// kernel's objects. A pose that throws is listed with its error. Build warnings are not
// failures. Nothing here runs lint, verify or measure.
//
// DOM-free, three-free and node:-free like the rest of the oracle.

import { buildView } from "./build.js";
import { desugar } from "../panel/legacy.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const firstLine = (e) => String(e?.message ?? e).split("\n")[0];

// mulberry32: a small seeded generator in [0, 1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The part's ranged controls, in panel order, one per key: `{ key, min, max, step }`. Hidden controls are left out. */
function rangedControls(part) {
  const out = [];
  const seen = new Set();
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || n.hidden) continue;
      if (Array.isArray(n.children)) walk(n.children);
      if (n.kind !== "control" || typeof n.key !== "string" || seen.has(n.key)) continue;
      if (!isNum(n.min) || !isNum(n.max) || n.max < n.min) continue;
      seen.add(n.key);
      out.push({ key: n.key, min: n.min, max: n.max, step: isNum(n.step) && n.step > 0 ? n.step : null });
    }
  };
  walk(desugar(part?.parameters));
  return out;
}

// A random value on the control's step grid (as a slider would give it), inside its range.
function randomValue(c, r) {
  const v = c.min + r * (c.max - c.min);
  if (!c.step) return Math.round(v * 1000) / 1000;
  const snapped = c.min + Math.round((v - c.min) / c.step) * c.step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(c.step)) + 2);
  return Math.min(c.max, Math.max(c.min, Number(snapped.toFixed(decimals))));
}

/**
 * The poses `--ranges` builds.
 * @returns {Array<{ name: string, params: object }>} `params` holds only the keys that differ from the defaults
 */
export function rangePoses(part, { random = 24, seed = 1 } = {}) {
  const defaults = part?.defaults ?? {};
  const controls = rangedControls(part);
  const pose = (name, values) => ({
    name,
    params: Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== defaults[k])),
  });
  const poses = [pose("defaults", {})];
  if (!controls.length) return poses;
  for (const c of controls) {
    poses.push(pose(`${c.key}=min`, { [c.key]: c.min }));
    poses.push(pose(`${c.key}=max`, { [c.key]: c.max }));
  }
  poses.push(pose("all min", Object.fromEntries(controls.map((c) => [c.key, c.min]))));
  poses.push(pose("all max", Object.fromEntries(controls.map((c) => [c.key, c.max]))));
  const next = mulberry32(seed);
  for (let i = 1; i <= random; i++) {
    poses.push(pose(`random ${i}`, Object.fromEntries(controls.map((c) => [c.key, randomValue(c, next())]))));
  }
  return poses;
}

// The cage faces a subdiv self-intersection message names (subdiv/index.js's
// throughMessage): "… passes through itself between A and B; C and D; E folds through itself",
// or "…: E folds through itself". Each face once per message.
function facesNamed(message) {
  const m = /^subdiv: the body passes through itself(?: between |: )(.*)$/.exec(message);
  if (!m) return [];
  const ids = [];
  for (const piece of m[1].split("; ")) {
    const fold = /^(.+) folds through itself$/.exec(piece);
    if (fold) { ids.push(fold[1]); continue; }
    const pair = piece.split(" and ");
    if (pair.length === 2) ids.push(pair[0], pair[1]);
  }
  return [...new Set(ids)];
}

/**
 * Build `view` at every pose of rangePoses and report the ones that throw.
 * @returns {{ view: string, poses: number, failed: Array<{ name, params, error }>, faces: Array<{ id, count }> }}
 *   `faces`: the cage faces the errors name, most often first (each counted once per pose)
 */
export function sweepRanges(kernel, part, view = Object.keys(part.views)[0], { random, seed } = {}) {
  const poses = rangePoses(part, { random, seed });
  const failed = [];
  const counts = new Map();
  for (const { name, params } of poses) {
    try {
      buildView(kernel, part, view, params);
    } catch (e) {
      const error = firstLine(e);
      failed.push({ name, params, error });
      for (const id of facesNamed(error)) counts.set(id, (counts.get(id) ?? 0) + 1);
    } finally {
      kernel.cleanup?.();
    }
  }
  // Most often first; ties keep the order the faces were first named in.
  const faces = [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
  return { view, poses: poses.length, failed, faces };
}

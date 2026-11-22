// The cached preview's pose ladder: rung 1 only, with the FILE as the delivery. A
// preview GLB holds one view's meshes already posed at the params it was written at
// (the file params, which it carries since encoder 6); re-posing a mesh for other
// params needs no kernel when its place() is a rigid motion — the matrix that moves
// it is place(p, d) · place(file)⁻¹, the same relative-matrix rule the collision
// world's relativeMatsAt implements. A handle is place-only here exactly when every
// sub-part its params move has a trusted rigid placement (collide/place.js's
// placeMatrix); one whose placement is untrusted or non-rigid reads null and stays
// where the file put it.
//
// openingParams is the params a file's meshes sit at: in a file with a baked
// autoplay animation every tracked mesh decodes at that animation's first frame, so
// its t = 0 values win over the live params; a file that bakes none sits at the live
// params.
//
// Rules: matricesAt never derives (it takes a resolved p, d); apply never re-sends a
// matrix equal to the one last applied (pose-fast-path.js's setPose rule —
// setSubPose restarts the contact shadow) and never sends null.
//
// Pure: no DOM, no three.js, no node:. The oracle imports it in a Web Worker, so it
// imports only pure leaves — never collide/world.js, which carries the BVH and the
// native core.
import { placeMatrix } from "./collide/place.js";
import { invertRigid, mulMat4 } from "./geometry/pose.js";
import { resolveParams, viewSubParts } from "./part-model.js";
import { viewAnimations, evaluate } from "./animation.js";
import { buildIdentity } from "./preview-animation.js";
import { handlesShownInView } from "./pose/handle-views.js";
import { handleKeys } from "./pose/pose-collide.js";
import { rangesOf } from "./pose/param-solve.js";
import { probeSubPartPose } from "./pose-probe-core.js";
import { topologyKey } from "./geometry/subdiv/surface.js";

/**
 * The params a preview file's meshes sit at: the live params under the t = 0 values of
 * the animation the file BAKES. `anim` is that animation (normalized, as
 * samplePreviewAnimation returns it), or null when the file bakes none — then the live
 * params alone. Omitted (undefined), it is looked up as the view's autoplay animation.
 */
export function openingParams(part, view, params = {}, anim) {
  const live = { ...part.defaults, ...params };
  if (anim === undefined) {
    try { anim = viewAnimations(part).get(view)?.find((a) => a.autoplay) ?? null; } catch { anim = null; }
  }
  return anim ? { ...live, ...evaluate(anim, 0).values } : live;
}

const same = (a, b) => a === b || (a != null && b != null && a.every((v, i) => v === b[i]));

/**
 * Places a preview file's meshes at other params. `base` is each drawn sub-part's
 * placement at the file params (null: untrusted or non-rigid); a drawn name the part
 * lacks is left out.
 */
export function createFilePlacer(part, view, fileParams, drawnNames) {
  const has = (name) => Object.prototype.hasOwnProperty.call(part.parts ?? {}, name);
  const r0 = resolveParams(part, fileParams);
  const base = new Map();
  const inverses = new Map();
  for (const name of drawnNames) {
    if (!has(name)) continue;
    const m = placeMatrix(part.parts[name], view, r0.p, r0.d);
    base.set(name, m);
    inverses.set(name, m ? invertRigid(m) : null);
  }

  /** place(p, d) · base⁻¹ per name; null when either side is null or the name was never placed. */
  function matricesAt(p, d, names = drawnNames) {
    const out = new Map();
    for (const name of names) {
      const inv = inverses.get(name);
      if (!inv) { if (base.has(name)) out.set(name, null); continue; }
      const m = placeMatrix(part.parts[name], view, p, d);
      out.set(name, m ? mulMat4(m, inv) : null);
    }
    return out;
  }

  // What each mesh shows: the matrix at the file params to begin with (the identity,
  // computed the same way, so recomputing it there compares equal and is not sent).
  const shown = matricesAt(r0.p, r0.d);

  /** Pose the viewer's meshes at params; returns the names whose matrix was sent. */
  function apply(viewer, params) {
    const { p, d } = resolveParams(part, params);
    const sent = [];
    for (const [name, m] of matricesAt(p, d)) {
      if (m == null || same(shown.get(name), m)) continue;
      shown.set(name, m);
      viewer.setSubPose(name, m);
      sent.push(name);
    }
    return sent;
  }

  return { base, matricesAt, apply };
}

/** The fractions of a key's [min, max] range previewHandles probes. */
export const PREVIEW_HANDLE_SAMPLES = [0, 0.25, 0.5, 0.75, 1];

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Which of the editor's handles a kernel-free preview may show against its file: a
 * handle shows only when every param one drag of it can write moves pieces by
 * placement alone, proven geometry-free. Each key is sampled at
 * PREVIEW_HANDLE_SAMPLES of its range (the file value alone when the range is not
 * finite), the other params at the file values; at every sample the view's sub-part
 * set is unchanged, every drawn sub-part has a rigid placement, and every view
 * sub-part's build identity equals the file's. A one-function derive over-reports
 * reads, so identity across samples is the test, not reads. Fails closed.
 *
 * A tied cage body (encoder version 7, preview-cage.js) may change its build: `cageKeys`
 * maps such a sub-part to the topology key its file ties carry. Its build may differ from
 * the file's at a sample when the build probe there is trusted and cagePosable with one
 * cage of that key and the file's shapeHash (the build less the cage's points): the
 * editor's cage-base rule, so the change moves only cage points the ties can follow. A
 * sub-part the probe does not find re-posable AT THE FILE PARAMS is treated as untied.
 *
 * @param {Map<string, string>} [o.cageKeys]  tied sub-part -> its file's topology key;
 *   omitted (a version 6 file, or no cage body), every build must equal the file's
 * @returns {{ shown: string[], hidden: Record<string, string> }} shown keeps
 *   handlesShownInView's order; hidden maps a handle id to why it is hidden.
 */
export function previewHandles(part, view, fileParams, meshNames, opts) {
  const stepper = previewHandlesStepper(part, view, fileParams, meshNames, opts);
  while (!stepper.step());
  return stepper.result();
}

/**
 * previewHandles one handle at a time, for a caller that spreads the decision over
 * idle slices: each step() decides ONE candidate handle (the file side and the
 * per-(key, value) verdicts are memoized across steps) and returns true once every
 * handle is decided; result() is previewHandles' answer so far.
 */
export function previewHandlesStepper(part, view, fileParams, meshNames, { cageKeys = null } = {}) {
  const shown = [];
  const hidden = {};
  const result = () => ({ shown: [...shown], hidden: { ...hidden } });
  const handles = part?.handles;
  if (!handles || typeof handles !== "object") return { step: () => true, result };
  const file = { ...part.defaults, ...fileParams };
  const candidates = handlesShownInView(part, view, file);

  // The file side, computed once (lazily, so a throw lands on a handle).
  let fileSide;
  const fileFacts = () => {
    if (fileSide) return fileSide;
    const names = viewSubParts(part, view, file);
    const drawnSet = new Set(meshNames);
    const drawn = names.filter((n) => drawnSet.has(n));
    const r0 = resolveParams(part, file);
    let bad = null; // a reason every handle shares
    const ids = new Map();
    for (const n of names) {
      const id = buildIdentity(part, view, r0, n);
      if (id == null) { bad ??= `${n}'s build cannot be read`; continue; }
      ids.set(n, id);
    }
    for (const n of drawn) if (!bad && placeMatrix(part.parts[n], view, r0.p, r0.d) == null) bad = `${n} has no rigid placement`;
    // The tied cage bodies the file side confirms: drawn, and re-posable at the file params
    // with the file's key. Each keeps its shapeHash for the samples.
    const cages = new Map();
    for (const n of drawn) {
      const key = cageKeys?.get(n);
      if (typeof key !== "string") continue;
      const e = cageEntry(n, r0);
      if (e && topologyKey(e.cages[0]) === key) cages.set(n, { key, shapeHash: e.shapeHash });
    }
    fileSide = { key: names.join("\u0000"), names, drawn, ids, cages, bad };
    return fileSide;
  };
  // A sub-part's build-probe entry when it is the editor's cage base kind, else null.
  const cageEntry = (n, { p, d }) => {
    const e = probeSubPartPose(part.parts[n], { view, purpose: "display", p, d }, { scope: "build" });
    return e.trusted && e.cagePosable && e.cages?.length === 1 && e.shapeHash !== undefined ? e : null;
  };
  // Does a tied cage body's build at a sample move only its cage points?
  const cageFollows = (n, r, tied) => {
    const e = cageEntry(n, r);
    return !!e && e.shapeHash === tied.shapeHash && topologyKey(e.cages[0]) === tied.key;
  };

  // One verdict per (key, value): a reason, or null when place-only there.
  const verdicts = new Map();
  const verdictAt = (key, value) => {
    const memo = `${key}\u0000${value}`;
    if (verdicts.has(memo)) return verdicts.get(memo);
    const { key: setKey, drawn, names, ids, cages } = fileFacts();
    const params = { ...file, [key]: value };
    let reason = null;
    if (viewSubParts(part, view, params).join("\u0000") !== setKey) reason = `${key} changes which sub-parts the view shows`;
    else {
      const { p, d } = resolveParams(part, params);
      for (const n of drawn) {
        if (placeMatrix(part.parts[n], view, p, d) == null) { reason = `${n} has no rigid placement`; break; }
      }
      if (!reason) for (const n of names) {
        const id = buildIdentity(part, view, { p, d }, n);
        if (id == null) { reason = `${n}'s build cannot be read`; break; }
        if (id !== ids.get(n) && !(cages.has(n) && cageFollows(n, { p, d }, cages.get(n)))) { reason = `${key} rebuilds ${n}`; break; }
      }
    }
    verdicts.set(memo, reason);
    return reason;
  };

  const ranges = candidates.length ? rangesOf(part) : null;
  const all = Object.values(handles);
  let next = 0;
  function step() {
    if (next >= candidates.length) return true;
    const id = candidates[next++];
    let reason = null;
    try {
      reason = fileFacts().bad;
      if (!reason) {
        for (const key of handleKeys(handles[id], all, file)) {
          const r = ranges.get(key);
          const values = r && finite(r.min) && finite(r.max)
            ? [...new Set(PREVIEW_HANDLE_SAMPLES.map((f) => r.min + f * (r.max - r.min)))]
            : [file[key]];
          for (const v of values) if ((reason = verdictAt(key, v))) break;
          if (reason) break;
        }
      }
    } catch {
      reason = "the handle's point cannot be read";
    }
    if (reason) hidden[id] = reason; else shown.push(id);
    return next >= candidates.length;
  }
  return { step, result };
}

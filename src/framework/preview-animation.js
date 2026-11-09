// Bakeability + sampling for the preview GLB's animation. The cached
// preview stores one view's meshes posed at the default params; this module
// decides whether that view's AUTOPLAY animation can be carried in the same file
// faithfully, and if so samples the place() matrices along its timeline. Turning
// the samples into glTF channels is the encoder's job, not this module's.
//
// Rulings:
//   - Bakeable means EVERY tracked param is place-only for every shown sub-part:
//     the build reads none of them (`buildReads`, supplied by the caller, which
//     already holds the mesh cache's read sets), and at every sample the place
//     probe is trusted with a CANONICAL base hash — a rigid matrix over the mesh
//     the file already holds. A reshaping place() (scale/mirror/union) is not a
//     rigid motion, so a matrix track could not reproduce it.
//   - Reads over-report. A one-function derive has no per-key attribution, so a
//     build reading any d.* is recorded as reading every param derive read. A
//     tracked key in the reads is therefore a question, not a refusal: the build
//     probe answers it, as it does for the viewer's pose fast path. Trusted with
//     the same hash and the same trailing pose as the file's mesh means the mesh
//     is right at that sample. A querying build is never trusted, and a trailing
//     transform that moves is refused rather than composed. At most
//     BUILD_PROBE_SAMPLES samples are probed: a build costs far more than a
//     place(), and a sandbox job that times out loses the whole preview.
//   - The shown sub-part set must not change along the timeline: a mesh that
//     comes and goes with a tracked param (`enabled`) is not in the file to show.
//     Opacity fades are display-only and ride the samples beside the poses.
//   - Fail CLOSED: unknown build reads (null), any failed check and any throw
//     return null — the preview then simply has no animation. Never throws.
//   - The output always passes the encoder's own refusals (checkAnimation in
//     gltf/encode-preview.js): a finite, positive duration (and finite step
//     durations and starts), finite sample times, and every pose rigid by the
//     same isRigid test. Anything else is
//     null here, so an odd animation costs the preview its motion, never the
//     whole file (an encoder throw would leave the forge with no preview).
//   - Sample times are normalized t in [0, 1]: both ends, every step boundary,
//     every track and opacity keyframe mapped to global t, plus a
//     PREVIEW_SAMPLE_HZ grid over the real duration. Over PREVIEW_SAMPLE_CAP the
//     GRID thins; keyframe and boundary times are never dropped, since they are
//     where the motion turns.
//
// Imports only the pure framework leaves below, so the partforge/oracle entry's
// closure stays DOM-, three- and node:-free (test/oracle-entry.test.js).
import { viewAnimations, evaluate } from "./animation.js";
import { viewSubParts, resolveParams } from "./part-model.js";
import { placeMatrix } from "./collide/place.js";
import { probeSubPartPose } from "./pose-probe-core.js";

export const PREVIEW_SAMPLE_HZ = 30;
export const PREVIEW_SAMPLE_CAP = 600;
const BUILD_PROBE_SAMPLES = 32;

const EPS = 1e-9;

// Sorted, deduped normalized sample times for one animation.
function sampleTimes(anim) {
  const fixed = [0, 1, ...anim.stepStarts];
  anim.steps.forEach((step, i) => {
    const start = anim.stepStarts[i], span = step.duration / anim.totalDuration;
    for (const field of ["tracks", "opacity"]) {
      for (const kf of Object.values(step[field] ?? {})) {
        if (!Array.isArray(kf)) continue;
        for (const frame of kf) {
          const u = Array.isArray(frame) ? Number(frame[0]) : NaN;
          if (Number.isFinite(u)) fixed.push(Math.min(1, Math.max(0, start + u * span)));
        }
      }
    }
  });
  const keep = dedupe(fixed);
  // Interior grid points j/n, 0 < j < n; thinned so the total fits the cap.
  let n = Math.round(anim.totalDuration * PREVIEW_SAMPLE_HZ);
  n = Math.max(1, Math.min(n, PREVIEW_SAMPLE_CAP - keep.length + 1));
  const grid = [];
  for (let j = 1; j < n; j++) grid.push(j / n);
  return dedupe([...keep, ...grid]);
}

function dedupe(times) {
  const out = [];
  for (const t of [...times].sort((a, b) => a - b)) if (!out.length || t - out.at(-1) > EPS) out.push(t);
  // Both ends stay exact: a near-duplicate must not displace 0 or 1.
  out[0] = 0;
  out[out.length - 1] = 1;
  return out;
}

// Place matrices for every shown sub-part, or null if any is not place-only.
function placePoses(part, view, { p, d }, shown) {
  const poses = {};
  for (const name of shown) {
    const m = placeMatrix(part.parts[name], view, p, d); // null: untrusted, reshaping or not rigid
    if (!m) return null;
    poses[name] = m;
  }
  return poses;
}

// One sub-part's build as the probe sees it, reduced to a comparable string, or
// null when the probe cannot be believed (a query, a function argument, a throw).
// Shared with preview-pose.js's previewHandles.
export function buildIdentity(part, view, { p, d }, name) {
  const probe = probeSubPartPose(part.parts[name], { view, purpose: "display", p, d }, { scope: "build" });
  return probe.trusted ? JSON.stringify([probe.baseHash, probe.pose]) : null;
}

const sameSet = (a, b) => a.length === b.length && a.every((name) => b.includes(name));

export function samplePreviewAnimation(part, view, params = {}, { buildReads } = {}) {
  try {
    const anim = viewAnimations(part).get(view)?.find((a) => a.autoplay) ?? null;
    if (!anim || typeof buildReads !== "function") return null;
    if (!(Number.isFinite(anim.totalDuration) && anim.totalDuration > 0)) return null;
    // A NaN step duration normalizes to a total of 1 (animation.js's `|| 1`),
    // so the steps are checked too: the file's step list must be real numbers.
    if (!anim.steps.every((s) => Number.isFinite(s.duration) && s.duration >= 0)) return null;
    if (!anim.stepStarts.every(Number.isFinite)) return null;
    // Layered over the defaults here (not only inside the probe) so `enabled`
    // sees the same params the build and place() do.
    const p0 = { ...part.defaults, ...params };
    const shown = viewSubParts(part, view, p0);
    const r0 = resolveParams(part, p0);
    const base = placePoses(part, view, r0, shown);
    if (!base) return null;
    const unchecked = new Map(); // sub-part -> the file's build identity, for reads naming a tracked key
    for (const name of shown) {
      const reads = buildReads(name);
      if (!reads) return null;
      if (!anim.trackedKeys.some((key) => reads.has(key))) continue;
      const identity = buildIdentity(part, view, r0, name);
      if (!identity) return null;
      unchecked.set(name, identity);
    }
    const samples = [];
    const times = sampleTimes(anim);
    if (!times.every(Number.isFinite)) return null;
    const probeEvery = Math.ceil(times.length / BUILD_PROBE_SAMPLES);
    for (const [i, t] of times.entries()) {
      const { values, opacity } = evaluate(anim, t);
      const p = { ...p0, ...values };
      if (!sameSet(viewSubParts(part, view, p), shown)) return null;
      const resolved = resolveParams(part, p);
      const poses = placePoses(part, view, resolved, shown);
      if (!poses) return null;
      if (i % probeEvery === 0 || i === times.length - 1) {
        for (const [name, identity] of unchecked) {
          if (buildIdentity(part, view, resolved, name) !== identity) return null;
        }
      }
      samples.push({ t, poses, opacity });
    }
    return { anim, samples, base };
  } catch {
    return null;
  }
}

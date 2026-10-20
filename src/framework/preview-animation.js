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
import { probePoses } from "./pose-probe.js";
import { CANONICAL } from "./pose-probe-core.js";
import { viewSubParts } from "./part-model.js";
import { composePose, isRigid } from "./geometry/pose.js";

export const PREVIEW_SAMPLE_HZ = 30;
export const PREVIEW_SAMPLE_CAP = 600;

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
function placePoses(part, view, p, shown) {
  const probes = probePoses(part, view, p, { scope: "place" });
  const poses = {};
  for (const name of shown) {
    const entry = probes.get(name);
    if (!entry?.trusted || entry.baseHash !== CANONICAL) return null;
    const m = Array.from(composePose(entry.pose));
    if (!isRigid(m)) return null; // e.g. a rotate about a zero-length axis
    poses[name] = m;
  }
  return poses;
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
    const base = placePoses(part, view, p0, shown);
    if (!base) return null;
    for (const name of shown) {
      const reads = buildReads(name);
      if (!reads) return null;
      if (anim.trackedKeys.some((key) => reads.has(key))) return null;
    }
    const samples = [];
    const times = sampleTimes(anim);
    if (!times.every(Number.isFinite)) return null;
    for (const t of times) {
      const { values, opacity } = evaluate(anim, t);
      const p = { ...p0, ...values };
      if (!sameSet(viewSubParts(part, view, p), shown)) return null;
      const poses = placePoses(part, view, p, shown);
      if (!poses) return null;
      samples.push({ t, poses, opacity });
    }
    return { anim, samples, base };
  } catch {
    return null;
  }
}

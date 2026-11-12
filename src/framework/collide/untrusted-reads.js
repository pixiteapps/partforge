// Whether a sub-part's build rebuilds along a motion when the geometry-free probe cannot
// TRUST its build (it queried its solid, or passed a function): the one rule the sweep
// engine's motion scan (sweep-targets.js scanMotion) and motion coverage
// (motion-coverage.js) share, so a motion coverage calls rigid is swept rigidly.
//
// A build is a function of its inputs, so one that never reads a param the motion changes
// (directly or through the `derive` outputs it reads) cannot rebuild as the motion runs. Its
// reads are recorded on the probe kernel (geometry/probe.js answers queries with
// stand-ins), so, like param-deps.js's prediction, they miss a param read only inside a
// branch the real query result would take. A build that throws there, or runs away on the
// stand-ins, cannot be read, and rebuilds.
//
// A BVH-free leaf: the probe kernel and the read recorder only, never the collision world or
// the native core (test/worker-layering.test.js).
import { resolveParamsAttributed, recordedParams } from "../part-model.js";
import { newReadSink, expandReads } from "../read-recorder.js";
import { createValidatingProbe, MAX_PROBE_OPS } from "../geometry/probe.js";

/**
 * One sub-part's build reads at params q, recorded on the probe kernel (derive reads
 * expanded), or null when the build throws there.
 *
 * The re-run is capped at MAX_PROBE_OPS kernel calls, the pose probe's cap: a loop that
 * ends only on a real query answer (`while (s.volume() < v) s = s.union(…)`) never ends on
 * the probe's stand-ins, and its runaway reads as null, like a throw. Like the pose probe,
 * a pure-JS loop that makes no kernel call cannot be capped from here.
 */
export function untrustedBuildReads(part, name, q) {
  try {
    const resolved = resolveParamsAttributed(part, q);
    const sink = newReadSink();
    sink.attribution = resolved.attribution;
    const rec = recordedParams(resolved, sink);
    part.parts[name].build(createValidatingProbe({ maxOps: MAX_PROBE_OPS }).kernel, rec.p, rec.d);
    return new Set(expandReads(sink));
  } catch {
    return null;
  }
}

/**
 * Whether an untrusted build of `name` at q rebuilds when the params in `changed` (an
 * iterable of keys) move: it reads one of them, or its reads cannot be obtained.
 */
export function untrustedRebuilds(part, name, q, changed) {
  const reads = untrustedBuildReads(part, name, q);
  if (!reads) return true;
  for (const k of changed) if (reads.has(k)) return true;
  return false;
}

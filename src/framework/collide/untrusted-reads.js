// Whether a sub-part's build rebuilds along a motion when the geometry-free probe cannot
// TRUST its build (it queried its solid, or passed a function): the one rule the sweep
// engine's motion scan (sweep-targets.js scanMotion) and motion coverage
// (motion-coverage.js) share, so a motion coverage calls rigid is swept rigidly.
//
// A build is a function of its inputs, so one that never reads a param the motion changes
// (directly or through the `derive` outputs it reads) cannot rebuild as the motion runs. Its
// reads are recorded on the probe kernel (geometry/probe.js answers queries with
// stand-ins). A build whose reads cannot be obtained rebuilds: one that throws on the
// stand-ins, one that runs past MAX_PROBE_OPS kernel calls, and one that hands a kernel op a
// FUNCTION (an edge selector, a per-point callback), which the probe never calls, so a read
// inside it is invisible.
//
// The blind spots that remain, in one place:
// - a read inside a branch the real query result would take and the stand-in does not
//   (`if (s.volume() > 100) … p.open …`), as param-deps.js's prediction misses it too;
// - a pure-JS loop that makes no kernel call, which the op cap cannot stop (it hangs the
//   probe, as it would the pose probe).
//
// A BVH-free leaf: the probe kernel and the read recorder only, never the collision world or
// the native core (test/worker-layering.test.js).
import { resolveParamsAttributed, recordedParams } from "../part-model.js";
import { newReadSink, expandReads } from "../read-recorder.js";
import { createValidatingProbe, MAX_PROBE_OPS } from "../geometry/probe.js";

/**
 * One sub-part's build reads at params q, recorded on the probe kernel (derive reads
 * expanded), or null when they cannot be obtained: the build throws there, or passes a
 * function to a kernel op.
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
    const probe = createValidatingProbe({ maxOps: MAX_PROBE_OPS });
    part.parts[name].build(probe.kernel, rec.p, rec.d);
    if (probe.passedFunction()) return null; // a callback's reads are never seen
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

// Refuses a boolean whose RESULT is geometrically impossible — after the op ran.
//
// The failure this exists for (measured on real parts, and independently in the
// 2026-09 ModelRift CadQuery/OpenSCAD study): an exact B-rep kernel's boolean
// does not throw when it fails. It returns one operand instead of the union, an
// empty solid instead of the cut, or a negative-volume shape that its own
// validity check still calls valid — and every one of those ships as a STEP
// file, a preview, or a `measure` report that looks like a part. The
// coincidence guard (occt-coincidence.js) refuses the one degenerate
// CONSTRUCTION it can recognise before the op runs; this gate is the other
// half, judging the result by the one property no boolean may violate: its
// volume relative to its inputs.
//
//   union      ≥ every operand        (a union contains its inputs)
//   cut        ≤ its body             (a cut only removes)
//   intersect  ≤ its smallest operand (an intersection lies inside each input)
//   any        ≥ 0
//
// The inequalities are cheap — one volume read per solid, memoized by the
// backends — and each carries a slack of 1% of the operand it is compared
// AGAINST (floored at 1e-6 mm³), so B-spline volume integration noise can never
// fire them. Scaling the slack to the largest operand instead would switch the
// cut and intersect rules off whenever the tool is the big one, which the
// "overcut your tools" guidance makes routine. What the inequalities cannot
// catch is the exact documented signature of a dropped operand: a thin thread
// ridge unioned onto a core comes back as the core alone, which is LARGER than
// the ridge and so passes `union ≥ every operand`. That signature — the
// result's volume equals one operand's to float precision — is the one place
// the gate asks for more: first a bounding-box enclosure test (an operand whose
// box lies inside the other's cannot have lost material; free, and it settles
// the legitimate "boss buried in the plate" union without a boolean), then an
// overlap volume (`operands[i] ∩ operands[j]`, supplied lazily by the backend
// so the extra boolean only ever runs on this signature). If the other operand
// has material outside the equal one, the union lost it — judged against that
// operand's OWN size, so a thin ridge is not hidden behind the core's slack.
// The same probe decides a cut that came back EMPTY: impossible unless the
// tools covered the whole body. A probe that throws is inconclusive, never a
// refusal; so is a negative OPERAND, which is broken input rather than this
// boolean's doing (the backends latch orientation where they know to).
//
// This module is pure and backend-neutral on purpose: both kernels call it from
// inside their cached boolean closures (a cache hit is never re-judged), and
// test/boolean-gate.test.js pins every rule with plain numbers — the
// malfunctions it exists for have no deterministic fixture, since the
// reproducible one is now refused up front by the coincidence guard. Mesh CSG
// is exact arithmetic and is expected never to trip it; measured, the reads
// cost nothing there (~0.4% on a hundred-cut chain), and a mesh-class refusal
// would be a kernel bug worth seeing.
//
// A refusal THROWS rather than warning. The warnings channel is for honest
// degradation (a skipped fillet leaves a correct part minus a feature); a union
// that lost its core is wrong, not degraded, and the two existing precedents for
// provably wrong geometry — an empty Shape2D reaching `extrude`, and the
// coincidence guard — both throw with coaching. In the cloud app that throw lands
// in the export dialog's "Ask the assistant to fix it" path with the message
// forwarded verbatim, and a live preview keeps its last good mesh on screen.
// A refusal that reaches a boolean INSIDE a degrading feature (the mesh fillet's
// own cutters and fillers, a B-rep safeOp) is caught there and reported as that
// feature's skip, message included — the feature is what failed, and the part
// minus it is still honest.
import { BooleanResultError } from "./errors.js";

export const BOOLEAN_RESULT_INVALID = "BOOLEAN_RESULT_INVALID";

// Slack on the inequalities, relative to the operand being compared against and
// floored absolutely. 1% is far above any volume-integration error either kernel
// produces (OCCT's GProp on spline faces; Manifold's exact triangle sum) and far
// below any real failure (the measured cases were 30% and 100% off).
const REL_TOL = 1e-2;
const ABS_TOL = 1e-6; // mm³
const tolOf = (v) => Math.max(ABS_TOL, REL_TOL * v);
// "Equals one operand exactly": a returned-unchanged operand reports the identical
// number; a genuine union that added less than this is physically nothing.
const EQUAL_REL = 1e-9;

const fmt = (v) => Number(v.toPrecision(6)).toString();

const IMPOSSIBLE_COACHING =
  "The kernel's boolean returned broken geometry without reporting an error, so the build was " +
  "refused rather than shipping it. This happens on an exact B-rep kernel when operands touch " +
  "tangentially or a swept operand nearly touches itself; give the surfaces genuine overlap or " +
  "genuine clearance (0.05 or more) instead of an exact contact, overcut tools past the faces " +
  "they pierce, and build threads in the periodic screwSweep form or with k.tappedBore. " +
  "See ERROR-PATTERNS.md#boolean-impossible-result.";

const DROPPED_COACHING =
  "The kernel's boolean returned one input instead of the union, without reporting an error — " +
  "usually a thin or near-self-touching swept operand (a sub-pitch thread ridge riding a core). " +
  "Give the operands genuine overlap instead of a tangent contact; build a thread in the periodic " +
  "screwSweep form so it needs no union, or a tapped hole with k.tappedBore. " +
  "See ERROR-PATTERNS.md#boolean-dropped-operand.";

const impossible = (label, detail) =>
  new BooleanResultError(`boolean result invalid: ${label} produced an impossible result — ${detail} ${IMPOSSIBLE_COACHING}`);
const dropped = (label, detail) =>
  new BooleanResultError(`boolean result invalid: ${label} dropped an operand — ${detail} ${DROPPED_COACHING}`);

// Probe `operands[i] ∩ operands[j]`'s volume through the backend's thunk; null when
// the probe itself fails (an inconclusive answer must not become a refusal).
function overlapOf(overlap, i, j) {
  try {
    const v = overlap(i, j);
    return Number.isFinite(v) ? Math.max(0, v) : null;
  } catch {
    return null;
  }
}

// Cheap enclosure pre-test: true only when the backend can say from bounding
// boxes alone that operand j lies inside operand i. Absent or throwing = unknown.
function enclosedBy(encloses, i, j) {
  try { return encloses?.(i, j) === true; } catch { return false; }
}

/**
 * Judge a boolean's result by volume.
 *
 * @param {"union"|"cut"|"cutAll"|"intersect"} op
 * @param {number[]} operands  volumes; for cut/cutAll index 0 is the body, the rest tools
 * @param {number} result      the result's volume
 * @param {{ overlap: (i: number, j: number) => number, encloses?: (i: number, j: number) => boolean }} probes
 *   `overlap` lazily computes the volume of `operands[i] ∩ operands[j]`; consulted only
 *   on the two signatures the inequalities cannot decide, and allowed to throw (treated
 *   as inconclusive). `encloses(i, j)` answers "does operand i's bounding box contain
 *   operand j's" — when true the overlap is never asked for.
 * @param {string} [label=op]  how the message names the op — a backend that fuses
 *   cutAll's tools before cutting judges that fuse as a `union` labelled `cutAll (tools)`
 * @returns {BooleanResultError|null}
 */
export function checkBooleanResult(op, operands, result, probes, label = op) {
  if (operands.length < 2) return null;
  if (!Number.isFinite(result) || !operands.every(Number.isFinite)) return null;
  if (operands.some((v) => v < 0)) return null; // broken input, not this boolean's result
  const { overlap, encloses } = probes ?? {};
  const largest = Math.max(...operands);

  if (result < -tolOf(largest)) {
    return impossible(label, `a negative volume (${fmt(result)} mm³).`);
  }

  if (op === "union") {
    if (result < largest - tolOf(largest)) {
      return impossible(label, `a union smaller than its largest operand (${fmt(result)} mm³ vs ${fmt(largest)} mm³).`);
    }
    // The dropped-operand signature: the result IS one operand. Every other operand
    // with volume must then lie inside it, or the union lost material.
    const i = operands.findIndex((v) => v > ABS_TOL && Math.abs(result - v) <= EQUAL_REL * v);
    if (i < 0) return null;
    for (let j = 0; j < operands.length; j++) {
      const vj = operands[j];
      if (j === i || vj <= ABS_TOL || enclosedBy(encloses, i, j)) continue;
      const inside = overlapOf(overlap, i, j);
      if (inside === null) continue;
      const outside = vj - inside;
      if (outside > tolOf(vj)) {
        return dropped(label,
          `the result's volume (${fmt(result)} mm³) equals operand ${i}'s exactly, but operand ${j} ` +
          `(${fmt(vj)} mm³) has ${fmt(outside)} mm³ of material outside it that the union lost.`);
      }
    }
    return null;
  }

  if (op === "cut" || op === "cutAll") {
    const body = operands[0];
    const tol = tolOf(body);
    if (result > body + tol) {
      return impossible(label, `a cut larger than its body (${fmt(result)} mm³ vs ${fmt(body)} mm³).`);
    }
    if (result <= tol && body > tol) {
      // Empty result: only possible when the tools covered the whole body. A tool
      // whose box encloses the body's settles it; otherwise each tool's overlap is
      // summed — an OVER-estimate of coverage (tools may overlap each other), so
      // this refuses only when even that cannot reach the body's volume.
      let covered = 0;
      for (let j = 1; j < operands.length; j++) {
        if (operands[j] <= ABS_TOL) continue;
        if (enclosedBy(encloses, j, 0)) return null;
        const inside = overlapOf(overlap, 0, j);
        if (inside === null) return null; // inconclusive
        covered += inside;
      }
      if (covered < body - tol) {
        return impossible(label,
          `a cut that emptied its body although the tools cover at most ${fmt(covered)} mm³ of its ${fmt(body)} mm³.`);
      }
    }
    return null;
  }

  if (op === "intersect") {
    const smallest = Math.min(...operands);
    if (result > smallest + tolOf(smallest)) {
      return impossible(label, `an intersection larger than its smallest operand (${fmt(result)} mm³ vs ${fmt(smallest)} mm³).`);
    }
    return null;
  }

  return null;
}

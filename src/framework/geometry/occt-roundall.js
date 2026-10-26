// B-rep side of roundAll: dilate(+r), erode(-2r), dilate(+r) via raw OCCT
// BRepOffsetAPI_MakeOffsetShape (replicad has no solid-offset wrapper). Each
// step runs a variant cascade — the design spike showed no single parameter
// combo survives all shapes: plain solids dilate with Arc/Intersection=false,
// the chained erosion only succeeds with Arc/Intersection=true, and concave
// post-boolean solids only dilate with the Intersection join (morphologically
// fine: the FINAL Arc dilation supplies the convex rounding).
//
// A candidate is accepted only if IsDone, non-null, closed (mesh check),
// finite positive volume, AND volume-monotonic (dilation must not shrink,
// erosion must not grow). The monotonic gate is load-bearing: OCCT offsets
// return BRepCheck-valid garbage — the spike saw an erosion "succeed" at 0.4%
// of the input volume, and a sealed hole come back as an 11% crater. A gated
// failure skips the WHOLE op (warn + clone), mirroring safeOp's fillet policy
// and for the same reason: OCCT offset failures are not monotonic in r, so
// searching for a "largest working radius" would converge on garbage.
// Feature-consuming radii (r at/above the smallest feature) are the expected
// skip trigger — true consumption is mesh-class-only (docs/roundall-design.md).
//
// Every WASM object made here is freed, same convention as occt-repair.js, so
// OCCT's heap doesn't grow across regenerates: up to twelve offset builders and
// progress ranges, every rejected candidate, and each superseded intermediate.
// The one thing never freed is the caller's `shape` — it belongs to the caller,
// and the skip path hands back a clone of it.
import { isClosedSolid } from "./occt-repair.js";

const VARIANTS = [
  { join: "arc", inter: false },
  { join: "arc", inter: true },
  { join: "int", inter: false },
  { join: "int", inter: true },
];

// One gated offset step: the variant cascade above, each candidate held to the
// IsDone / closed / positive-volume / volume-monotonic gate. Returns
// { solid, vol } or null when no variant survives. `variants` is the cascade
// order. Never frees `topoOwner` — the caller owns it.
function offsetStep(replicad, topoOwner, off, vol, variants = VARIANTS) {
  const oc = replicad.getOC();
  const tryOffset = (topo, offset, v) => {
    const progress = new oc.Message_ProgressRange_1();
    const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
    try {
      mk.PerformByJoin(topo, offset, 1e-6,
        oc.BRepOffset_Mode.BRepOffset_Skin, v.inter, false,
        v.join === "arc" ? oc.GeomAbs_JoinType.GeomAbs_Arc : oc.GeomAbs_JoinType.GeomAbs_Intersection,
        false, progress);
      if (!mk.IsDone()) return null;
      const s = mk.Shape();
      // Wrap BEFORE the finally frees the builder — replicad's own idiom for this
      // very algorithm (its `offset()` does `cast(offsetBuilder.Shape()); offsetBuilder.delete()`).
      // The wrapper carries its own TopoDS_Shape handle, so the result outlives `mk`.
      return s.IsNull() ? null : new replicad.Solid(s);
    } catch {
      return null;
    } finally {
      mk.delete?.();
      progress.delete?.();
    }
  };
  for (const v of variants) {
    const cand = tryOffset(topoOwner.wrapped, off, v);
    if (!cand) continue;
    let cvol;
    try { cvol = replicad.measureVolume(cand); } catch { cand.delete?.(); continue; }
    if (!Number.isFinite(cvol) || cvol <= 0) { cand.delete?.(); continue; }
    if (off > 0 && cvol < vol * 0.999) { cand.delete?.(); continue; } // dilation shrank: garbage
    if (off < 0 && cvol > vol * 1.001) { cand.delete?.(); continue; } // erosion grew: garbage
    // isClosedSolid meshes the candidate, and meshing OCCT offset garbage can
    // throw — that is just another rejected candidate, not an escape hatch out
    // of "roundAll never throws for geometry".
    try { if (!isClosedSolid(cand)) { cand.delete?.(); continue; } }
    catch { cand.delete?.(); continue; }
    return { solid: cand, vol: cvol };
  }
  return null;
}

export function occtRoundAll(replicad, shape, r, warn = (msg) => console.warn(`partforge: ${msg}`)) {
  if (!Number.isFinite(r) || r <= 0) throw new Error("roundAll: r must be a finite number > 0 (r = 0 is handled as the identity by the caller)");
  let vol;
  try {
    vol = replicad.measureVolume(shape);
  } catch (e) {
    // Can't gate what can't be measured — skip rather than run the cascade blind.
    warn(`roundall-skipped: the input solid's volume could not be measured (${e?.message || e}); returning the un-rounded solid`);
    return shape.clone(); // if the clone throws too, the caller's shape is unusable — let it propagate
  }
  let cur = shape;
  for (const off of [r, -2 * r, r]) {
    const next = offsetStep(replicad, cur, off, vol);
    if (cur !== shape) cur.delete?.(); // superseded intermediate; never the caller's shape
    if (!next) {
      warn(`roundall-skipped: offset step ${off} produced no valid solid — r=${r} is likely at/above the smallest feature size; returning the un-rounded solid`);
      return shape.clone();
    }
    cur = next.solid;
    vol = next.vol;
  }
  return cur;
}

// Solid.offset on the B-rep class: ONE gated offset step, Arc join first so the
// corners match the mesh class's ball offset (convex edges round on a grow,
// concave on a shrink). Unlike roundAll this never skips: an un-offset solid
// handed back as an offset is silently wrong geometry (a skin cut from it comes
// out empty), so a step no variant survives THROWS, with a greppable message
// (docs/ERROR-PATTERNS.md "offset-failed"). The usual trigger is an erode at or
// past half the thinnest wall — the B-rep offset cannot change topology, which
// the mesh class's Minkowski does.
export function occtOffset(replicad, shape, d) {
  if (!Number.isFinite(d) || d === 0) throw new Error("offset: d must be a finite non-zero number (d = 0 is handled as the identity by the caller)");
  let vol;
  try {
    vol = replicad.measureVolume(shape);
  } catch (e) {
    throw new Error(`offset-failed: offset(${d}) could not measure the input solid on the OCCT backend (${e?.message || e})`);
  }
  const next = offsetStep(replicad, shape, d, vol);
  if (!next) {
    throw new Error(`offset-failed: offset(${d}) produced no valid solid on the OCCT backend — |d| is likely at/above half the thinnest wall, or the shape has faces OCCT cannot offset; the Manifold backend's offset handles both (meta.backend: "manifold")`);
  }
  return next.solid;
}

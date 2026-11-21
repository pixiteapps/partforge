// The three OCCT booleans, for operands with a freeform face.
//
// replicad's cut / fuse / intersect each end with SimplifyResult(true, true, 1e-3),
// which merges same-domain edges AND faces. The face half grinds without end on a
// result where a swept surface meets a cylinder it crosses (feedback: a tapped hole
// that breaks through a collar's dowel bore). Measured on that part: the boolean
// itself builds in 2.6 s and is valid; the face merge had not returned after
// 4.6 minutes; the edge merge alone returns at once. Keeping the freeform faces out
// of the merge (ShapeUpgrade_UnifySameDomain.KeepShape) did not help, and the WASM
// build cannot abort a running call, so there is nothing to time out.
//
// So a boolean with a freeform face on either operand merges edges only. Nothing is
// lost that was measured: on blind and through tapped holes and on a thread cut into
// a block, the face and edge counts are the same with and without the face merge.
// Operands with analytic faces only still go through replicad, face merge included.

const ALGO = { cut: "BRepAlgoAPI_Cut_3", fuse: "BRepAlgoAPI_Fuse_3", intersect: "BRepAlgoAPI_Common_3" };
const ANALYTIC = ["GeomAbs_Plane", "GeomAbs_Cylinder", "GeomAbs_Cone", "GeomAbs_Sphere", "GeomAbs_Torus"];

// True when any face of the shape is not a plane, cylinder, cone, sphere or torus.
export function hasFreeformFace(oc, topo) {
  const analytic = ANALYTIC.map((name) => oc.GeomAbs_SurfaceType[name]);
  const isAnalytic = (type) => analytic.some((a) => a === type || (a?.value !== undefined && a.value === type?.value));
  const explorer = new oc.TopExp_Explorer_2(topo, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let found = false;
  for (; explorer.More() && !found; explorer.Next()) {
    const adaptor = new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(explorer.Current()), true);
    found = !isAnalytic(adaptor.GetType());
    adaptor.delete();
  }
  explorer.delete();
  return found;
}

// `a` and `b` are replicad shapes; neither is consumed. Returns a replicad shape.
export function edgeMergedBoolean(replicad, kind, a, b) {
  const oc = replicad.getOC();
  const [r, gc] = replicad.localGC();
  try {
    // Clones, because the algorithm may adjust its inputs' tolerances.
    const left = r(a.clone()), right = r(b.clone());
    const progress = r(new oc.Message_ProgressRange_1());
    const op = r(new oc[ALGO[kind]](left.wrapped, right.wrapped, progress));
    op.Build(progress);
    op.SimplifyResult(true, false, 1e-3);
    const result = replicad.cast(op.Shape());
    if (typeof result?.fuse !== "function") throw new Error(`Could not ${kind} as a 3d shape`);
    return result;
  } finally {
    gc();
  }
}

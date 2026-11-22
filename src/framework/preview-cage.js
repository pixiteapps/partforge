// Re-posing a cage body on a cached preview (docs/superpowers/specs/2026-11-22-cage-pose-
// drag-design.md, "Part 4"). A preview file of encoder version 7 carries, per k.subdiv
// sub-part, the ties of each decoded vertex to the cage's smooth surface (decode-preview.js's
// `ties`). The cage itself is not in the file: it is rebuilt by running the part's build
// through the build probe at the params the file was written at (version 6's file params),
// the editor's rule (skin-drag.js's cage base): a trusted, cagePosable entry with one cage
// whose topology key is the file's. The placement and the validity check are the editor's
// (skin/cage-deform.js); this module only owns the preview's lifecycle around them.
//
// How it differs from the editor's skin controller, because a preview has no worker:
//  - No exact build follows a drag. A pose the deform cannot follow (an untrusted entry, a
//    cage of another topology or shape, a build that threw) is INVALID here, never "leave it
//    to the exact build": nothing wrong or stale is drawn, and a handle drag stops (guard).
//  - The release leaves the last drawn valid pose on screen. The drag state (the plan, the
//    scratch) is built when a drag needs it and dropped when the drag ends (endDrag); only a
//    copy of the file's positions and normals stays while the sub-part shows a deformed pose,
//    so a later move back to the file's pose can put the exact file mesh back.
//  - The file's positions are quantized (14 bits over the mesh's widest extent) and its
//    weights clamped to [0, 1] and rounded to 1/65535, so the agreement check between the
//    rebuilt plan and the ties (cage-deform.js's tiesAgree) runs with tiesHold's
//    `quantized` rule and a tolerance derived from the file's own step (previewTieTolerance).
//
// Frames: the ties were made in the cage's frame; `ties.pose` maps it onto the positions
// the file decodes to. The plan is built in the cage's frame, from the probe's own snapshot:
// its quad diagonals are picked from the points, and a rotated copy of an exactly symmetric
// quad can pick the other one, which reorders the triangles the ties name (measured on the
// hand: a 30° turn moved 1 mm of the rest surface). So the agreement check takes the
// decoded positions back into the cage's frame, and each deform is moved by the pose into
// the decoded frame, where the viewer's mesh lives (the file placer's matrices pose it on
// top, as for any other mesh). A pose that is not rigid is refused, and so is a sub-part the
// file animates: its decoded mesh sits at the animation's opening pose, which the player
// re-poses.
//
// Fails closed: a sub-part with malformed or disagreeing ties is simply not re-posable (its
// handles stay hidden through previewHandlesStepper, as for a version 6 file), and anything
// that throws holds the pose. Pure apart from the injected viewer: no DOM, no kernel.
import { probePoses } from "./pose-probe.js";
import { viewSubParts } from "./part-model.js";
import { makeCageBase, tiesFitCage, tiesAgree, deformCage, cagePoseValidity } from "./skin/cage-deform.js";
import { TIE_TOLERANCE, TIE_WEIGHTS } from "./geometry/subdiv/ties.js";

// How far, per axis, a decoded position may sit from its true place, in quantization steps:
// half a step of rounding plus up to about 0.19 of a step from gltf-transform's bit
// replication (a 13-bit value stored in 16 bits as v << 2 | v >> 11), rounded up.
export const PREVIEW_AXIS_STEPS = 0.75;

/** The agreement check's distance tolerance (mm) for ties read from a file with position step `step`. */
export const previewTieTolerance = (step) => TIE_TOLERANCE + PREVIEW_AXIS_STEPS * Math.sqrt(3) * (Number.isFinite(step) && step > 0 ? step : 0);

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (m) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);
// A column-major rigid motion: orthonormal columns, a positive determinant, an affine last row.
function isRigid(m) {
  if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite)) return false;
  if (Math.abs(m[3]) > 1e-9 || Math.abs(m[7]) > 1e-9 || Math.abs(m[11]) > 1e-9 || Math.abs(m[15] - 1) > 1e-9) return false;
  const col = (j) => [m[4 * j], m[4 * j + 1], m[4 * j + 2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c = [col(0), col(1), col(2)];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(dot(c[i], c[j]) - (i === j ? 1 : 0)) > 1e-6) return false;
  const det = c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1]) - c[1][0] * (c[0][1] * c[2][2] - c[0][2] * c[2][1]) + c[2][0] * (c[0][1] * c[1][2] - c[0][2] * c[1][1]);
  return det > 0;
}
// Move 3-vectors by the rigid `m`, in place; `point` adds its translation.
function moveBy(m, arr, point) {
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i + 1], z = arr[i + 2];
    arr[i] = m[0] * x + m[4] * y + m[8] * z + (point ? m[12] : 0);
    arr[i + 1] = m[1] * x + m[5] * y + m[9] * z + (point ? m[13] : 0);
    arr[i + 2] = m[2] * x + m[6] * y + m[10] * z + (point ? m[14] : 0);
  }
  return arr;
}
// The inverse of a rigid column-major matrix (the transpose of its rotation).
function invertRigid(m) {
  const t = [m[12], m[13], m[14]];
  return [
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1,
  ];
}
// The editor's cage-base entry rule (skin-drag.js's cagePosableEntry).
const cagePosableEntry = (e) => !!(e && e.trusted && e.cagePosable && Array.isArray(e.cages) && e.cages.length === 1 && e.shapeHash !== undefined);

// Ties a reader may use at all: one tie per vertex, a whole number triangle index per
// vertex (tri is a Uint32Array), finite weights, a rigid pose. The triangle bound needs the
// plan (makeCageBase checks it).
function wellFormed(mesh) {
  const t = mesh.ties;
  if (!t || !(t.tri instanceof Uint32Array) || !(t.w instanceof Float32Array)) return false;
  if (!mesh.positions || !mesh.normals || mesh.positions.length !== 3 * t.tri.length || mesh.normals.length !== mesh.positions.length) return false;
  if (t.w.length !== TIE_WEIGHTS * t.tri.length) return false;
  for (let i = 0; i < t.w.length; i++) if (!Number.isFinite(t.w[i])) return false;
  return isRigid(t.pose);
}

/**
 * The cage bodies of a decoded preview that a drag may re-pose.
 * @param {object} part  the part module the file was written from
 * @param {string} view  the file's view
 * @param {object} fileParams  the params the file's meshes sit at
 * @param {object[]} meshes  decodePreviewGlb's payloads (the viewer draws these arrays)
 * @param {object} [o]
 * @param {Iterable<string>} [o.animated]  sub-parts the file's baked animation moves (refused)
 * @param {Function} [o.probe]  probePoses (a test may count calls)
 */
export function createPreviewCages(part, view, fileParams, meshes, { animated = [], probe = probePoses } = {}) {
  const moving = new Set(animated);
  const records = new Map(); // name -> record (see accept)
  let fileMap = null;
  try { fileMap = probe(part, view, fileParams, { scope: "build" }); } catch { fileMap = null; }
  for (const mesh of meshes) {
    try { accept(mesh); } catch { records.delete(mesh?.name); }
  }

  function accept(mesh) {
    const { name } = mesh;
    if (!fileMap || !Object.hasOwn(part.parts ?? {}, name) || moving.has(name) || records.has(name) || !wellFormed(mesh)) return;
    const e = fileMap.get(name);
    if (!cagePosableEntry(e)) return;
    const pose = isIdentity(mesh.ties.pose) ? null : mesh.ties.pose.slice();
    const snapshot = e.cages[0];
    if (!tiesFitCage(snapshot, mesh.ties)) return; // the file's key is not this cage's topology
    records.set(name, {
      name, pose, snapshot, ties: mesh.ties,
      shapeHash: e.shapeHash, baseHash: e.baseHash,
      // The arrays the viewer was handed: nothing has written into them until a drag.
      file: { positions: mesh.positions, normals: mesh.normals },
      tolerance: previewTieTolerance(mesh.ties.step),
      verified: false,
      copy: null,      // the file's own positions and normals, copied before the first write
      drag: null,      // { cage, scratch } while a drag needs it
      deformed: false, // the viewer shows a deformed pose
    });
  }

  // The plan, checked against the ties; null (forgetting the sub-part) when they disagree.
  function prepare(rec) {
    if (rec.drag) return rec.drag;
    const exact = rec.copy ?? rec.file;
    const cage = makeCageBase(rec.snapshot, rec.ties);
    // The file's positions in the cage's frame (a copy, only for a posed file).
    const rest = rec.pose ? moveBy(invertRigid(rec.pose), Float32Array.from(exact.positions), true) : exact.positions;
    if (!cage || !tiesAgree(cage, rest, { tolerance: rec.tolerance, quantized: true })) {
      records.delete(rec.name);
      return null;
    }
    rec.verified = true;
    rec.copy ??= { positions: rec.file.positions.slice(), normals: rec.file.normals.slice() };
    const n = rec.file.positions.length;
    rec.drag = { cage, scratch: { positions: new Float32Array(n), normals: new Float32Array(n) } };
    return rec.drag;
  }

  // The live probe at `params`, its cage points moved into the decoded frame. One memo: a
  // handle frame checks a pose (isClear) and then shows it.
  let last = null; // { params, map, verdicts: Map }
  const sameParams = (a, b) => {
    for (const k of Object.keys(a)) if (!Object.is(a[k], b[k])) return false;
    for (const k of Object.keys(b)) if (!(k in a)) return false;
    return true;
  };
  function liveAt(params) {
    if (last && sameParams(last.params, params)) return last;
    let map = null;
    try { map = probe(part, view, params, { scope: "build" }); } catch { map = null; }
    last = { params: { ...params }, map, verdicts: new Map() };
    return last;
  }

  // "base" (the file's own build: show the file's mesh), "draw", or "invalid".
  function verdict(rec, live) {
    if (live.verdicts.has(rec.name)) return live.verdicts.get(rec.name);
    let v = "invalid";
    try {
      const e = live.map?.get(rec.name);
      if (!e?.trusted) v = "invalid";
      else if (e.baseHash !== undefined && e.baseHash === rec.baseHash) v = "base";
      else if (cagePosableEntry(e) && e.shapeHash === rec.shapeHash) {
        const drag = prepare(rec);
        // undefined: another topology (the plan cannot follow it); { message }: the pose fails.
        if (drag && cagePoseValidity(drag.cage, e.cages[0]) === null) v = "draw";
      }
    } catch { v = "invalid"; }
    live.verdicts.set(rec.name, v);
    return v;
  }

  // The records the view shows at `params` that the viewer draws.
  const inView = (viewer, params) => {
    if (records.size === 0) return [];
    let names;
    try { names = viewSubParts(part, view, params); } catch { return null; }
    return names.filter((n) => records.has(n) && viewer.hasSubMesh(n)).map((n) => records.get(n));
  };

  function restore(viewer, rec) {
    if (!rec.deformed) return;
    rec.deformed = false;
    try { viewer.setSubVertices(rec.name, rec.copy, { deformed: false }); } catch { records.delete(rec.name); }
  }

  function isClear(viewer, params) {
    const recs = inView(viewer, params);
    if (!recs) return false;
    const live = liveAt(params);
    return recs.every((rec) => verdict(rec, live) !== "invalid");
  }

  return {
    /** The re-posable sub-parts and their file topology keys (previewHandlesStepper's `cageKeys`). */
    keys: () => new Map([...records.values()].map((r) => [r.name, r.ties.key])),
    names: () => [...records.keys()],
    /**
     * Prove one unverified sub-part's ties against its rebuilt plan (the drag's own check, run
     * ahead in idle time so a file whose ties disagree keeps its handles hidden). The plan is
     * dropped again. Returns false once every record is verified.
     */
    verifyNext() {
      const rec = [...records.values()].find((r) => !r.verified);
      if (!rec) return false;
      if (prepare(rec) && !rec.deformed) { rec.drag = null; rec.copy = null; }
      return true;
    },
    /** Whether every re-posable sub-part in view can be drawn at `params` (the file's pose, or a valid deform). */
    isClear,
    /**
     * Show `params`: the file's mesh where the file's build stands, a deformed pose where it
     * is valid, and what is on screen otherwise (held). Returns whether anything was held.
     */
    show(viewer, params) {
      const recs = inView(viewer, params);
      if (!recs) return records.size > 0;
      const live = liveAt(params);
      let held = false;
      for (const rec of recs) {
        const v = verdict(rec, live);
        if (v === "base") { restore(viewer, rec); continue; }
        if (v !== "draw") { held = true; continue; }
        const e = live.map.get(rec.name);
        const { cage, scratch } = rec.drag;
        let ok = false;
        try {
          ok = deformCage(cage, e.cages[0], scratch.positions, scratch.normals);
          if (ok && rec.pose) { moveBy(rec.pose, scratch.positions, true); moveBy(rec.pose, scratch.normals, false); }
          ok = ok && viewer.setSubVertices(rec.name, scratch, { deformed: true }) !== false;
        } catch { ok = false; }
        if (ok) rec.deformed = true; else held = true;
      }
      return held;
    },
    /** The drag is over: drop every plan and scratch; keep the file's copy only where a deformed pose stays drawn. */
    endDrag() {
      for (const rec of records.values()) {
        rec.drag = null;
        if (!rec.deformed) rec.copy = null;
      }
      last = null;
    },
    /** Is the sub-part showing a deformed pose? */
    isDeformed: (name) => records.get(name)?.deformed === true,
    /** Is a drag's plan held now (a test hook for the memory rule)? */
    holdsDragState: () => [...records.values()].some((r) => r.drag !== null),
    /**
     * A Pose-mode drag guard (pose-session.js's COLLISIONS contract) that refuses a pose a
     * re-posable sub-part in view cannot draw, wrapping `inner` (the collision guard, or
     * null); `inner` itself when none is in view. A refused settle stays at `from`.
     */
    guard(viewer, params, inner) {
      if (!inView(viewer, params)?.length) return inner;
      const clear = (p) => isClear(viewer, p);
      return {
        settle(from, to, opts) {
          const s = inner ? inner.settle(from, to, opts) : { params: { ...to }, blocked: null };
          return clear({ ...from, ...s.params }) ? s : { params: { ...from }, blocked: null };
        },
        isClear: (p) => (inner ? inner.isClear(p) : true) && clear(p),
        release: () => inner?.release?.(),
      };
    },
  };
}

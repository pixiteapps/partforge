// A part's declared lines in the live viewer: one tube mesh per line, named `line:<name>`,
// parented with the sub-part meshes (so the pivot, the per-view recentring and the cutaway
// apply as they do to a sub-part) and re-meshed from derive on every update. Main-thread
// only (three.js); the worker never loads it. A line is a display mesh like a sub-part's,
// so it is NOT hidden from captures; it is not a sub-part either (no export, no picking).
import * as THREE from "three";
import { RENDER_STYLES } from "../renderStyles.js";
import { buildCadMaterial } from "../materials/physical.js";
import { lineMeshes } from "./meshes.js";

/** The colour a line takes past a limit: its bend ratio under the rope's minimum, or a limit setLimit turned on. */
export const LINE_LIMIT_COLOR = 0xe5484d;

/**
 * `{ update(view, d), readings(), setLimit(name, on), dispose() }` for `part`'s lines in
 * `viewer`. `update` re-meshes every line of `view` from derive's output `d` (the old
 * geometry disposed), hides the lines not in the view or not readable, and asks for a
 * render. `readings()` maps each line of the last view drawn to its reading, or null when
 * it could not be read. A line is tinted LINE_LIMIT_COLOR while its bend is past the
 * rope's limit OR setLimit holds it on.
 */
export function createLineScene(viewer, part) {
  const group = new THREE.Group();
  group.name = "lines";
  const recs = new Map(); // decl name -> { mesh, color, limit, bent, unregister }
  let current = new Map();
  let attached = false;
  let disposed = false;

  // The sub-part meshes' shared parent (partsGroup) exists only once a delivery has landed:
  // until then the group waits, and the next update tries again.
  function ensureAttached() {
    if (attached) return true;
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent;
    if (!parent) return false;
    parent.add(group);
    attached = true;
    return true;
  }

  const base = new THREE.MeshStandardMaterial({
    color: RENDER_STYLES.cad.material.color,
    metalness: RENDER_STYLES.cad.material.metalness,
    roughness: RENDER_STYLES.cad.material.roughness,
  });

  function recFor(name, display) {
    let rec = recs.get(name);
    if (rec) return rec;
    const material = buildCadMaterial(display, base);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.name = `line:${name}`;
    mesh.visible = false;
    group.add(mesh);
    const unregister = viewer.registerCutawayMaterial?.(material) ?? (() => {});
    rec = { mesh, color: material.color.getHex(), limit: false, bent: false, unregister };
    recs.set(name, rec);
    return rec;
  }

  function paint(rec) {
    rec.mesh.material.color.setHex(rec.limit || rec.bent ? LINE_LIMIT_COLOR : rec.color);
  }

  function geometryOf(mesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    return g;
  }

  function update(view, d) {
    if (disposed) return;
    ensureAttached();
    const next = new Map();
    for (const entry of lineMeshes(part, view, d)) {
      const rec = recFor(entry.line, entry.display);
      rec.mesh.geometry.dispose();
      const drawable = entry.mesh && entry.mesh.positions.length > 0;
      rec.mesh.geometry = drawable ? geometryOf(entry.mesh) : new THREE.BufferGeometry();
      rec.mesh.visible = !!drawable;
      const r = entry.reading;
      rec.bent = r != null && r.bendRatio != null && r.minBendRatio != null && r.bendRatio < r.minBendRatio;
      paint(rec);
      next.set(entry.line, entry.reading);
    }
    for (const [name, rec] of recs) if (!next.has(name)) rec.mesh.visible = false;
    current = next;
    viewer.requestRender?.();
  }

  function setLimit(name, on) {
    const rec = recs.get(name);
    if (!rec || disposed || rec.limit === !!on) return;
    rec.limit = !!on;
    paint(rec);
    viewer.requestRender?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const rec of recs.values()) {
      rec.unregister();
      rec.mesh.geometry.dispose();
      rec.mesh.material.dispose();
    }
    recs.clear();
    current = new Map();
    base.dispose();
    group.removeFromParent();
    group.clear();
    if (attached) viewer.requestRender?.();
  }

  return { update, readings: () => new Map(current), setLimit, dispose };
}

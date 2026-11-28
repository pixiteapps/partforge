// A part's declared lines in the live viewer: one tube mesh per line, named `line:<name>`,
// handed to the viewer as a display object (viewer.addDisplayObject: parented with the
// sub-part meshes, so the pivot, the per-view recentring and the cutaway apply as they do
// to a sub-part, and counted in the framing and depth bounds) and re-meshed from derive on
// every update. Main-thread only (three.js); the worker never loads it. A line is a display
// mesh like a sub-part's, so it is NOT hidden from captures; it is not a sub-part either
// (no export, no picking). It lives outside lines/, which stays pure and three-free.
// Its look follows the viewer's: CAD's standard material in CAD and realistic (lit there by
// the environment, like a matte plastic), and in cel a band material toned from its colour,
// on CEL_LAYER so the ink outlines it.
import * as THREE from "three";
import { RENDER_STYLES } from "./renderStyles.js";
import { buildCadMaterial } from "./materials/physical.js";
import { buildCelMaterial } from "./cel/cel-material.js";
import { CEL_LAYER } from "./cel/cel-ink.js";
import { lineMeshes } from "./lines/meshes.js";

/** The colour a line takes past a limit: its bend ratio under the rope's minimum, or a limit setLimit turned on. */
export const LINE_LIMIT_COLOR = 0xe5484d;

/**
 * `{ update(view, d), readings(), readout, dragLimits, setLimit(name, on), hide(), dispose() }` for `part`'s lines in
 * `viewer`. `update` re-meshes every line of `view` from derive's output `d` (the old
 * geometry disposed), hides the lines not in the view or not readable, and asks for a
 * render. `readings()` maps each line of the last view drawn to its reading, or null when
 * it could not be read. A line is tinted LINE_LIMIT_COLOR while its bend is past the
 * rope's limit OR setLimit holds it on (a setLimit before the line's first update is kept
 * and applied when it is built). `hide()` hides every line until the next update.
 * While posing: `readout(pressReadings)` is one drag readout item per line readable now and
 * at the press (`pressReadings`, name -> reading or null), and `dragLimits(pressReadings,
 * bound)` tints through setLimit each line whose length has moved by more than `bound` mm
 * since the press (none for a null bound).
 */
export function createLineScene(viewer, part) {
  const group = new THREE.Group();
  group.name = "lines";
  const recs = new Map(); // decl name -> { mesh, cad, cel, celHex, color, limit, bent, unregister, unregisterCel }
  const pendingLimits = new Set(); // setLimit(name, true) for a line not built yet
  let current = new Map();
  let disposed = false;
  let look = "cad"; // the viewer's render mode, told through onLook

  // The cel band material for the colour the line shows now, built on demand and rebuilt
  // when the tint changes (its tones are baked from one colour).
  function celOf(rec) {
    const hex = shownHex(rec);
    if (rec.cel && rec.celHex === hex) return rec.cel;
    dropCel(rec);
    rec.cel = buildCelMaterial({ color: hex });
    rec.celHex = hex;
    rec.unregisterCel = viewer.registerCutawayMaterial?.(rec.cel) ?? (() => {});
    return rec.cel;
  }
  function dropCel(rec) {
    if (!rec.cel) return;
    rec.unregisterCel();
    rec.cel.dispose();
    rec.cel = null;
    rec.celHex = null;
  }
  function applyLook(rec) {
    const cel = look === "cel";
    rec.mesh.material = cel ? celOf(rec) : rec.cad;
    if (cel) rec.mesh.layers.enable(CEL_LAYER); else rec.mesh.layers.disable(CEL_LAYER);
  }
  function onLook(mode) {
    if (disposed) return;
    look = mode;
    for (const rec of recs.values()) applyLook(rec);
  }
  const removeObject = viewer.addDisplayObject?.(group, { onLook }) ?? (() => {});

  const base = new THREE.MeshStandardMaterial({
    color: RENDER_STYLES.cad.material.color,
    metalness: RENDER_STYLES.cad.material.metalness,
    roughness: RENDER_STYLES.cad.material.roughness,
  });

  function recFor(name, display) {
    let rec = recs.get(name);
    if (rec) return rec;
    const cad = buildCadMaterial(display, base);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), cad);
    mesh.name = `line:${name}`;
    mesh.visible = false;
    group.add(mesh);
    const unregister = viewer.registerCutawayMaterial?.(cad) ?? (() => {});
    rec = { mesh, cad, cel: null, celHex: null, color: cad.color.getHex(), limit: pendingLimits.has(name), bent: false, unregister, unregisterCel: () => {} };
    pendingLimits.delete(name);
    recs.set(name, rec);
    applyLook(rec);
    return rec;
  }

  const shownHex = (rec) => (rec.limit || rec.bent ? LINE_LIMIT_COLOR : rec.color);
  function paint(rec) {
    rec.cad.color.setHex(shownHex(rec));
    if (look === "cel") applyLook(rec); // a new tint is a new band material
  }

  function geometryOf(mesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingBox(); // the viewer's framing and depth bounds read it
    g.computeBoundingSphere();
    return g;
  }

  function update(view, d) {
    if (disposed) return;
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
    if (disposed) return;
    const rec = recs.get(name);
    if (!rec) {
      if (on) pendingLimits.add(name); else pendingLimits.delete(name);
      return;
    }
    if (rec.limit === !!on) return;
    rec.limit = !!on;
    paint(rec);
    viewer.requestRender?.();
  }

  // Every line hidden (the view on screen is waiting for its sub-parts); the next update
  // shows the view's lines again.
  function hide() {
    if (disposed) return;
    let changed = false;
    for (const rec of recs.values()) {
      if (rec.mesh.visible) changed = true;
      rec.mesh.visible = false;
    }
    if (changed) viewer.requestRender?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const rec of recs.values()) {
      rec.unregister();
      dropCel(rec);
      rec.mesh.geometry.dispose();
      rec.cad.dispose();
    }
    recs.clear();
    pendingLimits.clear();
    current = new Map();
    base.dispose();
    removeObject();
    group.removeFromParent();
    group.clear();
    viewer.requestRender?.();
  }

  // Each line of the last update readable now and in `pressReadings` (name -> reading or
  // null, at the drag's press), with its drift: now less at the press.
  function drifts(pressReadings) {
    const out = [];
    for (const [name, r] of current) {
      const at = pressReadings?.get(name);
      if (!r || !Number.isFinite(r.length) || !Number.isFinite(at?.length)) continue;
      out.push({ name, length: r.length, drift: r.length - at.length });
    }
    return out;
  }

  // A drag readout item per line: its length now, and its drift since the press, 2 dp.
  function readout(pressReadings) {
    return drifts(pressReadings).map(({ name, length, drift }) => {
      const d = drift.toFixed(2);
      const signed = Number(d) === 0 ? "+0.00" : drift > 0 ? `+${d}` : d;
      return { key: `line:${name}`, label: name, unit: "mm", value: length, text: `${length.toFixed(2)} (${signed})` };
    });
  }

  // The drift tint: a line whose |drift| since the press passes `bound` is held tinted, every
  // other line of the scene let go (all of them for a null bound).
  function dragLimits(pressReadings, bound) {
    const past = new Set();
    if (bound != null) for (const { name, drift } of drifts(pressReadings)) if (Math.abs(drift) > bound) past.add(name);
    for (const name of recs.keys()) setLimit(name, past.has(name));
  }

  return { update, readings: () => new Map(current), readout, dragLimits, setLimit, hide, dispose };
}

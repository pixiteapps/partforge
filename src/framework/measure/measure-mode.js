// Measurement-mode orchestrator: the one measure module that touches both
// three.js and the DOM. Owns mode state and the two-click model:
//
//   hover        raycast -> snaps.findSnap -> snap-marker (draws NO dimension)
//   first click  the snap becomes the start point; a reading (readings.js
//                firstReading) when the target has one, flashing matching params
//   second click one distance (readings.spanSpec) from the start point
//   third click  starts over
//
// Touch has no hover, so a tap stands in for it: a tap SHOWS the snap (marker
// and label) and commits nothing; a second tap on that snap, or a drag that
// starts on it and lifts, commits it. A drag that starts anywhere else orbits.
//
// Dimensions are real scene objects parented under the meshes' shared group,
// so they ride the pivot rotation, the pose fast path and animations for free.
// The clicked points and readings are stored in each sub-part's GEOMETRY frame
// and posed by mesh.matrix whenever they are drawn, so a pose-only change moves
// them; a geometry change, a hidden sub-part or a view change clears them.
// `Clear` (chrome) and leaving the mode clear them too.
import * as THREE from "three";
import { raycastViewer } from "../selection/raycast.js";
import { createDragTracker, DRAG_THRESHOLD_SQUARED } from "../selection/drag-tracker.js";
import { subPartParamKeys } from "../param-deps.js";
import { classifyFeature, bboxSpec, unionBounds } from "./feature-dims.js";
import { paramMatches } from "./param-link.js";
import { evaluateChoices, choicesEqual, placeDims, specSig, laneCounts } from "./dim3-place.js";
import { createDimScene, worldPerPx, orthoWorldPerPx } from "./dim3-scene.js";
import { buildSnapIndex, findSnap, SNAP_PX } from "./snaps.js";
import { firstReading, spanSpec, frameAxesFor } from "./readings.js";
import { createSnapMarker } from "./snap-marker.js";

// How many distinct placements the cache holds. An orbit sweeps a bounded set
// of side choices; anything past that is ground the user has moved on from.
// Entries are plain drawing records (numbers, no GL objects), so the ceiling is
// about retention hygiene on a memory-tight device, not about a runaway.
const PLACEMENT_CACHE_LIMIT = 32;

// The word the snap label uses for each SnapTarget kind on a named feature.
const KIND_WORD = { corner: "corner", midpoint: "midpoint", circle: "centre", edge: "edge", face: "face" };

// Bounded LRU. A Map iterates in insertion order, so re-inserting on a hit
// moves the entry to the back and the oldest key is always the first one out.
function keyedCache(limit) {
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > limit) entries.delete(entries.keys().next().value);
      return value;
    },
    clear() { entries.clear(); },
  };
}

export function createMeasureMode(viewer, { part, getContext, revealParams, getReads, stage, schedule = (cb) => requestAnimationFrame(cb) }) {
  const pinListeners = new Set();
  const notifyPins = () => { for (const cb of [...pinListeners]) cb(); };
  const modeListeners = new Set();
  // Every listener hears every transition: the host application registers its
  // relay AFTER mount.js's own listeners, so a throw in one of ours must not
  // end the loop before the host is told — and must never escape setEnabled,
  // which send() calls after the ink is already discarded.
  const notifyMode = () => {
    for (const cb of [...modeListeners]) {
      try { cb(); } catch (err) { console.error("mode listener failed", err); }
    }
  };

  let enabled = false;
  let units = "mm";            // display only; values stay mm internally
  let straight = false;        // the chrome's toggle; Shift does the same per click
  let scene = null;            // created on first enable, kept across toggles
  let marker = null;           // the hover snap marker + the start-point dot
  let detached = false;

  // ---- the two clicks ------------------------------------------------------
  // Each: { subPart, mesh, geometry, view, pointGeom, target, spec, normal }.
  //   pointGeom  the snap point, geometry frame
  //   spec       the first click's reading (geometry frame) or null
  //   normal     a named plane face's normal (geometry frame) or null — the
  //              parallel-faces gap rule in spanSpec
  // `second` also carries `straight`, decided at its click.
  let first = null;
  let second = null;
  let hoverMesh = null;        // the mesh the snap marker currently marks
  let hoverGeometry = null;
  // A touch tap's snap, shown by the marker and not yet committed. It shares
  // the marker with mouse hover, so every path that drops the marker drops it.
  let touchPreview = null;

  const pinCount = () => (second ? 2 : first ? 1 : 0);

  // ---- per-geometry caches -------------------------------------------------
  // WeakMaps: identity lookup only, and old geometries (with their typed
  // arrays) drop out on their own once no mesh references them anymore.
  const specCache = new WeakMap(); // geometry -> Map(featureId -> spec|null)
  function featureSpec(mesh, featureId) {
    let byId = specCache.get(mesh.geometry);
    if (!byId) { byId = new Map(); specCache.set(mesh.geometry, byId); }
    if (!byId.has(featureId)) {
      const { featureIds } = mesh.geometry.userData;
      const positions = mesh.geometry.getAttribute("position").array;
      const indices = mesh.geometry.getIndex()?.array;
      byId.set(featureId, featureIds
        ? classifyFeature({ positions, indices, featureIds }, featureId)
        : null);
    }
    return byId.get(featureId);
  }
  const snapCache = new WeakMap(); // geometry -> SnapIndex
  function snapIndex(geometry) {
    let index = snapCache.get(geometry);
    if (!index) {
      const { featureIds, edgePositions } = geometry.userData;
      index = buildSnapIndex({
        positions: geometry.getAttribute("position").array,
        indices: geometry.getIndex()?.array,
        featureIds,
        edgePositions,
      });
      snapCache.set(geometry, index);
    }
    return index;
  }

  // ---- spec frames ---------------------------------------------------------
  // Readings come out of classifyFeature/firstReading in the MESH's own
  // geometry frame; dim3-place works entirely in the PARTS frame (the meshes'
  // shared parent), so compose the mesh's local matrix — which carries the
  // viewer's fast-path pose — into every anchor before handing a spec over.
  const _m3 = new THREE.Matrix3();
  const _tv = new THREE.Vector3();
  const isIdentity = (matrix) => matrix.determinant() === 1 && matrix.elements[12] === 0
    && matrix.elements[13] === 0 && matrix.elements[14] === 0 && matrix.elements[0] === 1
    && matrix.elements[5] === 1 && matrix.elements[10] === 1;
  const posePoint = (p, matrix) => _tv.set(p[0], p[1], p[2]).applyMatrix4(matrix).toArray();
  // directions take the matrix's linear part only — exact here because
  // setSubPose poses are rigid (rotation + translation, no shear or scale).
  const poseDir = (d, matrix) => _tv.set(d[0], d[1], d[2]).applyMatrix3(_m3.setFromMatrix4(matrix)).normalize().toArray();
  function transformSpec(spec, matrix) {
    if (isIdentity(matrix)) return spec; // poses are identity outside animations
    const pt = (p) => posePoint(p, matrix);
    const dir = (d) => poseDir(d, matrix);
    if (spec.kind === "plane") {
      return { ...spec, anchors: {
        width: { a: pt(spec.anchors.width.a), b: pt(spec.anchors.width.b) },
        height: { a: pt(spec.anchors.height.a), b: pt(spec.anchors.height.b) },
        normal: dir(spec.anchors.normal),
      } };
    }
    if (spec.kind === "cylinder") {
      return { ...spec, anchors: {
        center: pt(spec.anchors.center), axis: dir(spec.anchors.axis),
        top: pt(spec.anchors.top), bottom: pt(spec.anchors.bottom),
        rimDir: spec.anchors.rimDir ? dir(spec.anchors.rimDir) : undefined,
      } };
    }
    if (spec.kind === "edge") {
      return { ...spec, anchors: { a: pt(spec.anchors.a), b: pt(spec.anchors.b) } };
    }
    return spec;
  }

  const visibleMeshes = () => Object.entries(viewer._subMeshes)
    .filter(([, m]) => m.visible && m.geometry.getAttribute("position")?.count);

  // ---- param linking (scoped like selection/resolve.js scopeParams) --------
  function readKeysFor(subPart) {
    const { view, params } = getContext();
    return subPartParamKeys(part, view, params, getReads, subPart);
  }
  // A reading flashes the controls whose value ACTUALLY matches one of its
  // values (within the display quantum; radius-style params match a diameter
  // at value*2), scoped to the sub-part's read keys so an unrelated part's
  // coincidental value can't light up. One match also takes keyboard focus;
  // several flash without a focus steal; none flashes nothing.
  function revealRelevant(subParts, values) {
    if (!values) return;
    const keySet = new Set();
    for (const sp of subParts ?? []) for (const k of readKeysFor(sp)) keySet.add(k);
    if (!keySet.size) return;
    const matches = paramMatches([...keySet], getContext().params, values);
    if (!matches.length) return;
    revealParams?.(matches, matches.length === 1 ? matches[0] : null);
  }

  // ---- what is drawn ---------------------------------------------------------
  // The span between the two clicks, built from POSED points (and posed face
  // normals), squared to the shared frame of both sub-parts. Not posed again.
  function currentSpan() {
    if (!first || !second) return null;
    const pa = posePoint(first.pointGeom, first.mesh.matrix);
    const pb = posePoint(second.pointGeom, second.mesh.matrix);
    const axes = frameAxesFor(first.subPart, second.subPart, (name) => viewer._subMeshes[name]?.matrix);
    const faceNormals = [
      first.normal ? poseDir(first.normal, first.mesh.matrix) : null,
      second.normal ? poseDir(second.normal, second.mesh.matrix) : null,
    ];
    return spanSpec(pa, pb, { axes, straight: second.straight, faceNormals });
  }

  // Items handed to dim3-place: every spec already in the parts frame, and
  // `meshes` indexing into the meshData built alongside.
  function buildItems() {
    const items = [];
    const meshes = visibleMeshes();
    if (meshes.length === 0) return { items, meshes };
    // always-on overall bounds (posed, like viewer.frameTo)
    const boundsList = meshes.map(([, m]) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    });
    const u = unionBounds(boundsList);
    items.push({
      id: "overall", tier: "static", spec: bboxSpec(u.min, u.max),
      meshes: meshes.map((_, i) => i),
      subParts: meshes.map(([n]) => n),
    });
    const indexOf = (name) => meshes.findIndex(([n]) => n === name);
    if (second) {
      // a distance replaces the reading on screen: one number at a time
      const spec = currentSpan();
      if (spec) {
        items.push({
          id: "span", tier: "pinned", pinned: true, spec,
          meshes: [indexOf(first.subPart), indexOf(second.subPart)].filter((i) => i >= 0),
          subParts: [first.subPart, second.subPart],
        });
      }
    } else if (first?.spec) {
      const i = indexOf(first.subPart);
      items.push({
        id: "first", tier: "pinned", pinned: true,
        spec: transformSpec(first.spec, first.mesh.matrix),
        meshes: i >= 0 ? [i] : [],
        subParts: [first.subPart],
      });
    }
    return { items, meshes, bounds: u };
  }

  // ---- placement environment + rebuild -------------------------------------
  let choices = {};
  let lastItems = [];          // for label-pick resolution + cheap re-scoring
  let lastBounds = null;
  let themeEpoch = 0;
  // placeBox scans every vertex of the meshes it covers (tens of ms on a big
  // part), so placements are cached, KEYED and bounded: an orbit sweeps back
  // and forth over the same handful of side choices (~15 flips per 360° turn),
  // and keyed, it places each distinct choice once.
  const placeCache = keyedCache(PLACEMENT_CACHE_LIMIT);
  // The drawing list currently on screen, held by IDENTITY: scene.update()
  // rebuilds every child object (and repaints every label texture), so a list
  // the cache just handed back unchanged must not reach it.
  let painted = null;
  const _rc = new THREE.Raycaster();
  const _origin = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _camLocal = new THREE.Vector3();

  function partsParent(meshes) { return meshes[0]?.[1].parent ?? null; }

  // Everything dim3-place needs from the live scene, expressed in the parts
  // frame: raw vertex arrays + their pose matrices, a surface raycast (parts
  // frame in, parts frame out) and the camera position.
  function buildEnv(meshes) {
    const parent = partsParent(meshes);
    parent?.updateWorldMatrix(true, false);
    const meshData = meshes.map(([, m]) => ({
      positions: m.geometry.getAttribute("position").array,
      matrix: m.matrix,
    }));
    const hittable = meshes.map(([, m]) => m);
    for (const m of hittable) m.updateWorldMatrix(true, false);
    const surfaceHit = (origin, dir) => {
      if (!parent) return null;
      _origin.copy(origin).applyMatrix4(parent.matrixWorld);
      _dir.copy(dir).transformDirection(parent.matrixWorld);
      _rc.set(_origin, _dir);
      const hit = _rc.intersectObjects(hittable, false)[0];
      return hit ? parent.worldToLocal(hit.point.clone()) : null;
    };
    const camPos = parent
      ? _camLocal.copy(viewer.camera.position).applyMatrix4(parent.matrixWorld.clone().invert()).toArray()
      : viewer.camera.position.toArray();
    return { meshData, surfaceHit, camPos };
  }

  const centerOf = (bounds) => [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];

  // The side choices of one group of items (by id prefix), as a key fragment.
  function choiceKey(isMine) {
    let key = "";
    for (const ck of Object.keys(choices)) {
      if (!isMine(ck)) continue;
      const c = choices[ck];
      key += `|${ck}=${c.key ?? ""}${c.du ? `,${c.du.map((n) => n.toFixed(4))}` : ""}`;
    }
    return key;
  }
  const isMeasureChoice = (ck) => ck.startsWith("first|") || ck.startsWith("span|");

  // Two cached passes, like the old base/hover split: the overall dims, which
  // only a mesh, unit, theme or camera-side change moves, and the one
  // measurement on top. A click therefore places one item; the overall's
  // vertex scan never re-runs for it.
  //   base key:  mesh signature (geometry, poses, visibility, view), units,
  //              theme, the overall's side choices
  //   paint key: the base key + the measurement's spec (the ids "first" and
  //              "span" are reused by every measurement, so the spec is its
  //              identity) + its side choices
  function rebuild() {
    if (!enabled || !scene) return;
    const { items, meshes, bounds } = buildItems();
    lastItems = items;
    lastBounds = bounds ?? null;
    if (!items.length || !bounds) { scene.clear(); painted = null; return; }
    const env = buildEnv(meshes);
    choices = evaluateChoices(items, { camPos: env.camPos, center: centerOf(bounds), prev: choices });
    const place = (list, suppress, lanes) =>
      placeDims(list, { meshData: env.meshData, surfaceHit: env.surfaceHit, bounds, suppress, lanes, units }, choices);
    const base = items.filter((i) => i.id === "overall");
    const extra = items.filter((i) => i.id !== "overall");
    const baseKey = `${units}|${meshSig()}|t${themeEpoch}${choiceKey((ck) => !isMeasureChoice(ck))}`;
    let baseDrawings = placeCache.get(baseKey);
    if (!baseDrawings) baseDrawings = placeCache.set(baseKey, place(base));
    let drawings = baseDrawings;
    if (extra.length) {
      const paintKey = `m|${baseKey}|${extra.map((i) => `${i.id}:${specSig(i.spec)}`).join("|")}${choiceKey(isMeasureChoice)}`;
      drawings = placeCache.get(paintKey);
      if (!drawings) {
        // the measurement takes the lanes after the overall's, and a reading
        // identical to an overall dim is not drawn twice
        drawings = placeCache.set(paintKey, baseDrawings.concat(place(
          extra, new Set(base.map((i) => specSig(i.spec))), laneCounts(baseDrawings),
        )));
      }
    }
    if (painted !== drawings) { painted = drawings; scene.update(drawings); }
  }

  // ---- state transitions -----------------------------------------------------
  // Drop the side choices of the measurement that just went away, so the next
  // one starts from a fresh camera-based choice rather than inheriting the old
  // one's hysteresis under the reused item id.
  function forgetChoices() {
    for (const ck of Object.keys(choices)) {
      if (ck.startsWith("first|") || ck.startsWith("span|")) delete choices[ck];
    }
  }

  function syncStart() {
    // The start point is marked whenever the first click gave no reading.
    if (first && !first.spec) marker?.setStart(first.pointGeom, first.mesh);
    else marker?.setStart(null);
  }

  // Back to idle. Every clear path tells pin listeners (the Clear button's
  // visibility, the host's relay), even when nothing was showing, and drops
  // the hover snap too: a snap that outlives the clear (say a view change over
  // the same mesh) would stay on screen until the next pointer move.
  function clearState({ redraw = true } = {}) {
    clearHover();
    first = null;
    second = null;
    forgetChoices();
    marker?.setStart(null);
    notifyPins();
    if (redraw) rebuild();
  }

  function clearHover() {
    hoverMesh = null;
    hoverGeometry = null;
    touchPreview = null;
    marker?.clear();
  }

  // ---- frame dirty check ---------------------------------------------------
  // The camera is deliberately NOT part of the signature: the dims live in the
  // scene, so an orbit re-renders them for free. All a camera move can change
  // is WHICH side each dim is drawn on — cheap to re-score every frame
  // (dot products + hysteresis), and only a genuine flip costs a rebuild.
  let lastSig = "";
  // Seeded with the ACTIVE VIEW: a view switch clears, even when the visible
  // mesh set is byte-identical. The pose is hashed as its full rotation basis +
  // translation, not just the two diagonal terms — θ and −θ about X share
  // cos θ on the diagonal.
  function meshSig() {
    let sig = getContext().view;
    for (const [name, m] of Object.entries(viewer._subMeshes)) {
      const e = m.matrix.elements;
      sig += `|${name}:${m.visible ? 1 : 0}:${m.geometry.id}:${e[0]},${e[1]},${e[2]},${e[4]},${e[5]},${e[6]},${e[12]},${e[13]},${e[14]}`;
    }
    return sig;
  }
  // A click no longer refers to live geometry: its mesh is gone, hidden or
  // regenerated, or the view changed. A pose change alone keeps it.
  function isStale(click, view) {
    if (!click) return false;
    const m = viewer._subMeshes[click.subPart];
    return !m || m !== click.mesh || !m.visible || m.geometry !== click.geometry || click.view !== view;
  }
  const offFrame = viewer.onFrame(() => {
    if (!enabled || !scene) return;
    const sig = meshSig();
    if (sig !== lastSig) {
      lastSig = sig;
      // the snap marker points into a specific geometry: drop it with that geometry
      if (hoverMesh && (viewer._subMeshes[hoverMesh.name] !== hoverMesh || !hoverMesh.visible
          || hoverMesh.geometry !== hoverGeometry)) clearHover();
      const view = getContext().view;
      if (isStale(first, view) || isStale(second, view)) clearState({ redraw: false });
      rebuild();
    } else if (lastItems.length) {
      // cheap per-frame: has a side choice flipped?
      const meshes = visibleMeshes();
      const parent = partsParent(meshes);
      if (parent && lastBounds) {
        parent.updateWorldMatrix(true, false);
        const camPos = viewer.camera.position.clone()
          .applyMatrix4(parent.matrixWorld.clone().invert()).toArray();
        const next = evaluateChoices(lastItems, { camPos, center: centerOf(lastBounds), prev: choices });
        if (!choicesEqual(next, choices)) { choices = next; rebuild(); }
      }
    }
    scene.tick();
  });

  // ---- snapping ------------------------------------------------------------
  const _sp = new THREE.Vector3();
  const _ws = new THREE.Vector3();
  // A geometry-frame point of `mesh` in client px.
  function projectToClient(p, mesh, rect = viewer.domElement.getBoundingClientRect()) {
    _sp.set(p[0], p[1], p[2]).applyMatrix4(mesh.matrixWorld).project(viewer.camera);
    return [rect.left + ((_sp.x + 1) / 2) * rect.width, rect.top + ((1 - _sp.y) / 2) * rect.height];
  }
  // The snap a pointer at client (x, y) would grab, or null over empty space.
  function snapAt(x, y) {
    const hit = raycastViewer(viewer, x, y);
    if (!hit) return null;
    const { mesh } = hit;
    const rect = viewer.domElement.getBoundingClientRect();
    mesh.updateWorldMatrix(true, false);
    const hitPoint = mesh.worldToLocal(hit.pointWorld.clone()).toArray();
    // SNAP_PX pixels at the hit's depth, in world units, then in geometry units
    const cam = viewer.camera;
    const wpp = cam.isOrthographicCamera
      ? orthoWorldPerPx(cam.top, cam.bottom, cam.zoom, rect.height || 1)
      : worldPerPx(cam.position.distanceTo(hit.pointWorld), cam.fov ?? 45, rect.height || 1);
    const scale = mesh.getWorldScale(_ws).x || 1;
    const project = (p) => projectToClient(p, mesh, rect);
    const featureId = hit.feature?.id ?? 0;
    const fSpec = featureId > 0 ? featureSpec(mesh, featureId) : null;
    const target = findSnap(snapIndex(mesh.geometry), {
      hitPoint,
      hitFeatureId: featureId,
      featureSpec: fSpec,
      project,
      pointerPx: [x, y],
      radiusWorld: (SNAP_PX * wpp) / scale,
      snapPx: SNAP_PX,
    });
    if (!target) return null;
    return { target, mesh, subPart: hit.subPart, featureSpec: fSpec, featureLabel: hit.feature?.label ?? null };
  }

  function snapText(snap) {
    const { target, featureLabel } = snap;
    if (!(target.featureId > 0)) return target.kind === "corner" ? "corner" : "point";
    return `${featureLabel} · ${KIND_WORD[target.kind] ?? target.kind}`;
  }

  // ---- pointer handling (drag threshold: the click-picker idiom) -----------
  const drag = createDragTracker(); // same shared threshold as selection/pick.js
  let pendingMove = null;
  let moveScheduled = false;
  let suppressed = false; // cutaway gizmo drag in progress

  // Mirrors hover.js's own subscription: a cutaway handle drag takes over the
  // pointer, so drop any pending hover and stop reacting to moves until it lets go.
  const unsubscribeHandleHover = viewer.onCutawayHandleHover?.((handle) => {
    suppressed = handle != null;
    if (!suppressed) return;
    pendingMove = null;
    clearHover();
  }) ?? (() => {});

  function showSnap(snap) {
    hoverMesh = snap.mesh;
    hoverGeometry = snap.mesh.geometry;
    marker.show(snap.target, snap.mesh, snapText(snap));
  }

  // ---- touch ---------------------------------------------------------------
  // A press that starts within SNAP_PX of the previewed snap belongs to that
  // snap: it is taken from every later listener on the canvas (OrbitControls
  // included, so the camera stays put), moves the preview while it drags past
  // the shared drag threshold, and commits whatever is shown when it lifts. A
  // lift that never moved is the "second tap" and commits the snap unchanged.
  let adjust = null;         // { pointerId, x, y, moved } while a press owns the snap
  let swallowClick = false;  // the click a committing lift trails is not a tap
  let lastDownType = "";     // Safari's click after a tap carries no pointerType
  let pendingAdjust = null;
  let adjustScheduled = false;

  function endAdjust() {
    if (!adjust) return;
    try { dom.releasePointerCapture?.(adjust.pointerId); } catch { /* already released */ }
    adjust = null;
    pendingAdjust = null;
  }

  // Capture phase, so it runs before OrbitControls' own pointerdown on the canvas.
  function onDownCapture(ev) {
    lastDownType = ev.pointerType ?? "";
    swallowClick = false;
    if (ev.pointerType !== "touch") return;
    // a second finger while one owns the snap is a pinch: let it go, commit nothing
    if (adjust) { endAdjust(); return; }
    if (!enabled || suppressed || ev.defaultPrevented || ev.isPrimary === false || !touchPreview) return;
    const { target, mesh } = touchPreview;
    mesh.updateWorldMatrix(true, false);
    const [px, py] = projectToClient(target.point, mesh); // fresh: the camera may have moved
    if (Math.hypot(ev.clientX - px, ev.clientY - py) > SNAP_PX) return; // an orbit, as today
    ev.stopImmediatePropagation();
    ev.preventDefault();
    adjust = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
    try { dom.setPointerCapture?.(ev.pointerId); } catch { /* best effort */ }
  }

  function onAdjustMove(ev) {
    if (!adjust.moved) {
      const dx = ev.clientX - adjust.x, dy = ev.clientY - adjust.y;
      if (dx * dx + dy * dy <= DRAG_THRESHOLD_SQUARED) return; // still a tap
      adjust.moved = true;
    }
    pendingAdjust = { x: ev.clientX, y: ev.clientY };
    if (adjustScheduled) return;
    adjustScheduled = true;
    schedule(() => {
      adjustScheduled = false;
      const p = pendingAdjust;
      pendingAdjust = null;
      if (!enabled || detached || !p || !adjust) return;
      const snap = snapAt(p.x, p.y);
      if (!snap) { clearHover(); return; } // off the part: a lift here commits nothing
      showSnap(snap);
      touchPreview = snap;
    });
  }

  function onUpCapture(ev) {
    if (!adjust || ev.pointerId !== adjust.pointerId) return;
    // a move still waiting for its frame is where the finger lifted
    if (pendingAdjust) {
      const snap = snapAt(pendingAdjust.x, pendingAdjust.y);
      if (snap) touchPreview = snap; else clearHover();
    }
    endAdjust();
    const snap = touchPreview;
    clearHover();
    swallowClick = true;
    if (snap && enabled) commit(snap, false);
  }

  function onCancelCapture(ev) {
    if (adjust && ev.pointerId === adjust.pointerId) endAdjust();
  }

  // Hover never places a dimension: it moves the snap marker, nothing else.
  function onMove(ev) {
    if (adjust && ev.pointerId === adjust.pointerId) { onAdjustMove(ev); return; }
    if (!enabled || suppressed) return;
    drag.onMove(ev); // touch too: an orbit drag must not read as a tap
    if (ev.pointerType === "touch") return;
    pendingMove = { x: ev.clientX, y: ev.clientY };
    if (moveScheduled) return;
    moveScheduled = true;
    schedule(() => {
      moveScheduled = false;
      const p = pendingMove;
      pendingMove = null;
      if (!enabled || detached || !p || suppressed) return;
      touchPreview = null; // the mouse took the marker over
      // Over a dim label, a click flashes that label's controls rather than
      // grabbing the geometry behind it — so the marker (which promises what a
      // click grabs) steps aside. The pointer cursor is the label's affordance.
      if (scene?.pickLabel(p.x, p.y)) {
        dom.style.cursor = "pointer";
        clearHover();
        return;
      }
      dom.style.cursor = "";
      const snap = snapAt(p.x, p.y);
      if (!snap) { clearHover(); return; }
      showSnap(snap);
    });
  }
  // A touch pointer leaves after every lift; that must not drop a tap's preview.
  const onLeave = (ev) => {
    if (ev?.pointerType === "touch") return;
    clearHover();
    dom.style.cursor = "";
  };

  function clickRecord(snap) {
    const { target, mesh, subPart, featureSpec: fSpec } = snap;
    return {
      subPart,
      mesh,
      geometry: mesh.geometry,
      view: getContext().view,
      pointGeom: target.point,
      target,
      spec: firstReading(target, fSpec),
      normal: target.kind === "face" && fSpec?.kind === "plane" ? fSpec.anchors.normal : null,
    };
  }

  // Label pick first, then geometry: a dimension's text plane is a real object
  // in the scene, so clicking it must not fall through to the surface behind.
  function onClick(ev) {
    const wasDragged = drag.consumeClick();
    if (swallowClick) { swallowClick = false; return; }
    if (!enabled || wasDragged) return;
    const isTouch = (ev.pointerType || lastDownType) === "touch";
    const picked = scene?.pickLabel(ev.clientX, ev.clientY);
    if (picked) {
      // A reading's label (and the overall's) flashes the controls that hold
      // its value. Distances never flash. Nothing else changes.
      if (picked.itemId === "span") return;
      const item = lastItems.find((i) => i.id === picked.itemId);
      if (item) revealRelevant(item.subParts, { value: picked.value });
      return;
    }
    const snap = snapAt(ev.clientX, ev.clientY);
    if (isTouch) {
      // a tap shows what it would grab; a background tap drops the preview
      if (!snap) { clearHover(); return; }
      showSnap(snap);
      touchPreview = snap;
      return;
    }
    if (!snap) return; // background: the reading stays
    commit(snap, ev.shiftKey);
  }

  // One click's worth of state change: the first point, the distance, or a
  // fresh start after a distance. `shiftKey` asks for straight-line.
  function commit(snap, shiftKey) {
    const click = clickRecord(snap);
    if (first && !second) {
      const candidate = { ...click, straight: shiftKey || straight };
      second = candidate;
      if (!currentSpan()) { second = null; return; } // the same point again: nothing
      forgetChoices();
      syncStart();
      notifyPins();
      rebuild();
      return;
    }
    // idle, or a distance showing (the third click starts over)
    first = click;
    second = null;
    forgetChoices();
    syncStart();
    if (click.spec) revealRelevant([click.subPart], click.spec.values);
    notifyPins();
    rebuild();
  }

  const dom = viewer.domElement;
  dom.addEventListener("pointerdown", onDownCapture, { capture: true });
  dom.addEventListener("pointerup", onUpCapture, { capture: true });
  dom.addEventListener("pointercancel", onCancelCapture, { capture: true });
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", drag.onDown);
  dom.addEventListener("pointerup", drag.onUp);
  dom.addEventListener("pointercancel", drag.onCancel);
  dom.addEventListener("pointerleave", onLeave);
  dom.addEventListener("click", onClick);

  const offTheme = viewer.onThemeChange?.((mode) => {
    themeEpoch++; // drop the cached drawings so the repaint is unconditional
    scene?.setTheme(mode);
    rebuild();
  }) ?? (() => {});

  function setEnabled(on) {
    if (detached || on === enabled) return;
    enabled = !!on;
    if (enabled) {
      scene ??= createDimScene(viewer);
      marker ??= createSnapMarker(viewer, { stage });
      rebuild();
      // Adopt the signature this placement was built from, so the very next
      // frame doesn't read as "changed" and redo the whole vertex scan.
      lastSig = meshSig();
    } else {
      endAdjust();
      clearHover();
      clearState({ redraw: false });
      scene?.clear();
      lastItems = [];
      lastBounds = null;
      placeCache.clear();
      painted = null;
      dom.style.cursor = "";
    }
    notifyMode();
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    clearPins() { clearState(); },
    pinCount,
    getUnits: () => units,
    setUnits(next) {
      if (next === units || !(next in { mm: 1, in: 1 })) return;
      units = next;
      rebuild(); // labels re-render in the new unit; the cache key carries it
    },
    // Internal (the chrome's straight-line toggle); mount.js does not expose
    // these to hosts. It sets the kind of the next distance and re-draws the
    // one on screen in that kind, so after a switch the drawn distance matches
    // the toggle. Shift is per click: a Shift-click draws a straight line while
    // the toggle stays off, until the toggle is next switched.
    setStraight(on) {
      straight = !!on;
      if (second && second.straight !== straight) {
        second = { ...second, straight };
        // the commit path's guard: a span under MIN_SPAN_MM in its new kind
        // draws nothing, so it must not be counted either
        if (!currentSpan()) { clearState(); return; }
        forgetChoices();
        rebuild();
      }
    },
    isStraight: () => straight,
    onPinsChange: (cb) => { pinListeners.add(cb); return () => pinListeners.delete(cb); },
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    detach() {
      if (detached) return;
      detached = true;
      enabled = false;
      offFrame();
      unsubscribeHandleHover();
      offTheme();
      endAdjust();
      dom.removeEventListener("pointerdown", onDownCapture, { capture: true });
      dom.removeEventListener("pointerup", onUpCapture, { capture: true });
      dom.removeEventListener("pointercancel", onCancelCapture, { capture: true });
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", drag.onDown);
      dom.removeEventListener("pointerup", drag.onUp);
      dom.removeEventListener("pointercancel", drag.onCancel);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("click", onClick);
      marker?.dispose();
      scene?.dispose();
      pinListeners.clear();
      modeListeners.clear();
    },
  };
}

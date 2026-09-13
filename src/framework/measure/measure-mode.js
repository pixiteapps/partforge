// Measurement-mode orchestrator: the one measure module that touches both
// three.js and the DOM. Owns mode state and drives the pipeline
//   raycast hit -> feature-dims spec -> param-link -> dim3-place -> dim3-scene
// with a per-frame dirty check. Dimensions are real scene objects parented
// under the meshes' shared group, so they ride the pivot rotation, the pose
// fast path and animations for free; the frame loop only has to notice mesh
// regenerates/visibility flips (rebuild) and camera moves that flip a side
// choice (re-score, rebuild only if a choice actually changed). Pins live in
// the pure pin store, per view, and survive mode toggles; `Clear` (chrome) is
// the only thing that empties them.
import * as THREE from "three";
import { raycastViewer } from "../selection/raycast.js";
import { createFeatureHighlight } from "../selection/feature-highlight.js";
import { createDragTracker } from "../selection/drag-tracker.js";
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";
import { byteAwareReplacer } from "../geometry/solid-hash.js";
import { classifyFeature, bboxSpec, unionBounds } from "./feature-dims.js";
import { paramMatches } from "./param-link.js";
import { createPinStore, occurrenceOf } from "./pins.js";
import { evaluateChoices, choicesEqual, placeDims, specSig, laneCounts } from "./dim3-place.js";
import { createDimScene } from "./dim3-scene.js";

// How many distinct placements each cache holds. An orbit sweeps a bounded set
// of side choices, and a session hovers a bounded set of features; anything
// past that is ground the user has moved on from. Entries are plain drawing
// records (numbers, no GL objects), so the ceiling is about retention hygiene
// on a memory-tight device, not about a runaway.
const PLACEMENT_CACHE_LIMIT = 32;

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

export function createMeasureMode(viewer, { part, getContext, revealParams, getParamsVersion, schedule = (cb) => requestAnimationFrame(cb) }) {
  const pins = createPinStore();
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
  let scene = null;            // created on first enable, kept across toggles
  let highlight = null;
  let hover = null;            // { item, key } for the currently hovered spec
  let detached = false;

  // ---- spec cache: (geometry instance, featureId) -> core spec -------------
  // WeakMap: identity lookup only, and old geometries (with their typed
  // arrays) drop out on their own once no mesh references them anymore —
  // nothing here needs to clear it on detach.
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

  // ---- spec frames ---------------------------------------------------------
  // Feature/bbox specs come out of classifyFeature in the MESH's own geometry
  // frame; dim3-place works entirely in the PARTS frame (the meshes' shared
  // parent), so compose the mesh's local matrix — which carries the viewer's
  // fast-path pose — into every anchor before handing a spec over.
  const _m3 = new THREE.Matrix3();
  const _tv = new THREE.Vector3();
  function transformSpec(spec, matrix) {
    // identity fast path: poses are identity outside animations
    if (matrix.determinant() === 1 && matrix.elements[12] === 0 && matrix.elements[13] === 0
        && matrix.elements[14] === 0 && matrix.elements[0] === 1 && matrix.elements[5] === 1
        && matrix.elements[10] === 1) return spec;
    const pt = (p) => _tv.set(p[0], p[1], p[2]).applyMatrix4(matrix).toArray();
    // directions take the matrix's linear part only — exact here because
    // setSubPose poses are rigid (rotation + translation, no shear or scale).
    const dir = (d) => _tv.set(d[0], d[1], d[2]).applyMatrix3(_m3.setFromMatrix4(matrix)).normalize().toArray();
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
    if (spec.kind === "bbox") {
      const b = new THREE.Box3(
        new THREE.Vector3(...spec.anchors.min), new THREE.Vector3(...spec.anchors.max),
      ).applyMatrix4(matrix); // AABB of the posed box, same as viewer.frameTo
      return bboxSpec(b.min.toArray(), b.max.toArray());
    }
    return spec;
  }

  const visibleMeshes = () => Object.entries(viewer._subMeshes)
    .filter(([, m]) => m.visible && m.geometry.getAttribute("position")?.count);

  // ---- param linking (scoped like selection/resolve.js scopeParams) --------
  // Memoize the per-sub-part read-key map: subPartReadKeys runs probe builds
  // (see mesh-cache.js's readsFor), so it must run once per (view, params)
  // change, not once per pinned item per frame. mount's getContext() returns
  // the SAME live params object every call (mutated in place on every edit),
  // so identity is stable across edits and can't key the memo the way
  // mesh-cache.js's paramsVersion getter does. mount hands in the SAME
  // late-bound version thunk it gives createMeshCache/createPoseFastPath
  // (`() => loop.version()`) so this keys on the cheap integer instead of
  // hashing the whole params object every call; a caller that omits it (or a
  // direct test) falls back to the content hash.
  let readsKey = null, readsMap = null;
  function readsFor(view, params) {
    const key = `${view}|${getParamsVersion ? getParamsVersion() : JSON.stringify(params, byteAwareReplacer)}`;
    if (readsKey !== key) {
      readsKey = key;
      try { readsMap = subPartReadKeys(part, view, params); } catch { readsMap = null; }
    }
    return readsMap;
  }
  function readKeysFor(subPart) {
    const { view, params } = getContext();
    const reads = readsFor(view, params);
    if (!reads) return Object.keys(params);
    return reads === RELEVANT_ALL
      ? Object.keys(params)
      : [...(reads.get(subPart) ?? Object.keys(params))];
  }
  // Clicking a measurement flashes the controls whose value ACTUALLY matches
  // it (within the display quantum; radius-style params match a diameter at
  // value*2), scoped to the spanned sub-parts' read keys so an unrelated
  // part's coincidental value can't light up. One match also takes keyboard
  // focus; several flash without a focus steal; none flashes nothing — a
  // sub-part's whole read set proved far too coarse (a single build function
  // reads every param, so even the drainage toggle lit up for a width click).
  // Truthful derived-value attribution (which params MOVE this value) would
  // need a per-param sensitivity probe in the worker — deliberately not done.
  function revealRelevant(subParts, value) {
    if (value == null) return;
    const keySet = new Set();
    for (const sp of subParts ?? []) for (const k of readKeysFor(sp)) keySet.add(k);
    if (!keySet.size) return;
    const matches = paramMatches([...keySet], getContext().params, { value });
    if (!matches.length) return;
    revealParams?.(matches, matches.length === 1 ? matches[0] : null);
  }

  // ---- pin resolution: stable key -> a live spec + its mesh ----------------
  function resolvePin(key) {
    const mesh = viewer._subMeshes[key.subPart];
    if (!mesh || !mesh.visible) return null;
    if (key.featureLabel == null) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const { min, max } = mesh.geometry.boundingBox;
      return { spec: bboxSpec([min.x, min.y, min.z], [max.x, max.y, max.z]), mesh };
    }
    const { features = [], featureIds } = mesh.geometry.userData;
    if (!featureIds) return null;
    // find the (occurrence+1)-th feature id carrying this label — dormant when gone
    let seen = 0;
    for (let i = 0; i < features.length; i++) {
      if (features[i] !== key.featureLabel) continue;
      if (seen === key.occurrence) {
        const spec = featureSpec(mesh, i + 1);
        return spec ? { spec, mesh } : null;
      }
      seen++;
    }
    return null;
  }

  // Items handed to dim3-place: every spec already in the parts frame, and
  // `meshes` indexing into the meshData built alongside (so a feature dim
  // scans only its own sub-part). `_key` rides along for un-pinning by label
  // pick; dim3-place ignores unknown fields.
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
    const { view } = getContext();
    pins.list(view).forEach((key) => {
      const live = resolvePin(key);
      if (!live) return; // dormant
      const meshIndex = meshes.findIndex(([n]) => n === key.subPart);
      items.push({
        id: `pin:${key.subPart}:${key.featureLabel ?? "bbox"}:${key.occurrence}`,
        tier: "pinned", pinned: true,
        spec: transformSpec(live.spec, live.mesh.matrix),
        meshes: meshIndex >= 0 ? [meshIndex] : [],
        subParts: [key.subPart], _key: key,
      });
    });
    if (hover) {
      const meshIndex = meshes.findIndex(([n]) => n === hover.subPart);
      items.push({
        ...hover.item,
        spec: transformSpec(hover.item.spec, hover.mesh.matrix),
        meshes: meshIndex >= 0 ? [meshIndex] : [],
      });
    }
    return { items, meshes, bounds: u };
  }

  // ---- placement environment + rebuild -------------------------------------
  let choices = {};
  let lastItems = [];          // for label-pick resolution + cheap re-scoring
  let lastBounds = null;
  let themeEpoch = 0;
  // The always-on + pinned dims, which change rarely, cached apart from the
  // hover dim, which changes on every pointer move. placeBox scans every
  // vertex of the meshes it covers (tens of ms on a big part), so re-placing
  // the whole set per hover frame is the one path that must not exist.
  //
  // Both caches are KEYED and bounded rather than one slot each. A one-slot
  // cache is right for a monotonic sequence and wrong for an orbit, which
  // sweeps back and forth over the same handful of side choices — measured at
  // ~15 flips per 360° turn, every one of them a full re-place of ground
  // already covered. Keyed, an orbit places each distinct choice once.
  const baseCache = keyedCache(PLACEMENT_CACHE_LIMIT);
  // ...and the PAINTED list — base plus the hover dim — cached the same way, on
  // the base key plus everything the hover pass alone depends on. The hover
  // spec is identical for every pointer position over one feature, so without
  // this a pointer resting on a face re-ran that item's vertex scan and its
  // surface raycasts on every single rAF.
  const paintCache = keyedCache(PLACEMENT_CACHE_LIMIT);
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

  // Everything the base drawings depend on, in one string: the mesh signature
  // (geometry, poses, visibility, active view), the theme, which items are in
  // the base set and what they link to, and the side choices scored for them.
  // The hover item's own choice entries are skipped — they come and go with
  // the pointer and must not evict the cache.
  function baseCacheKey(sig, baseItems) {
    let key = `${sig}|t${themeEpoch}`;
    for (const item of baseItems) key += `|${item.id}`;
    for (const ck of Object.keys(choices)) {
      if (ck.startsWith("hover|")) continue;
      const c = choices[ck];
      key += `|${ck}=${c.key ?? ""}${c.du ? `,${c.du.map((n) => n.toFixed(4))}` : ""}`;
    }
    return key;
  }

  // The hover half of the choice table, which baseCacheKey deliberately omits
  // (hover entries come and go with the pointer and must not evict the base).
  // A camera move that flips which side the hovered dim hangs off has to
  // re-place it, so the paint key carries them.
  function hoverChoiceKey() {
    let key = "";
    for (const ck of Object.keys(choices)) {
      if (!ck.startsWith("hover|")) continue;
      const c = choices[ck];
      key += `|${ck}=${c.key ?? ""}${c.du ? `,${c.du.map((n) => n.toFixed(4))}` : ""}`;
    }
    return key;
  }

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
    const hoverItem = items.find((i) => i.id === "hover");
    const baseItems = hoverItem ? items.filter((i) => i !== hoverItem) : items;
    const key = baseCacheKey(`${units}|${meshSig()}`, baseItems);
    let baseDrawings = baseCache.get(key);
    if (!baseDrawings) baseDrawings = baseCache.set(key, place(baseItems));
    // The hover pass can't see the base pass's items (they're cached), so it
    // hands over (a) their sigs as `suppress` — a hover duplicating an
    // already-drawn measurement (the sub-part bounds over the overall, a
    // hovered pin) draws nothing instead of doubling it — and (b) their lane
    // occupancy, so a hovered dim staggers into the SAME lane it will occupy
    // once pinned (pins append after the base items in the same order) and
    // clicking never moves it.
    const paintKey = hoverItem
      ? `h|${key}|${specSig(hoverItem.spec)}|${hoverChoiceKey()}`
      : `b|${key}`;
    let drawings = paintCache.get(paintKey);
    if (!drawings) {
      drawings = paintCache.set(paintKey, hoverItem
        ? baseDrawings.concat(place(
            [hoverItem],
            new Set(baseItems.map((i) => specSig(i.spec))),
            laneCounts(baseDrawings),
          ))
        : baseDrawings);
    }
    if (painted !== drawings) { painted = drawings; scene.update(drawings); }
  }

  // ---- frame dirty check ---------------------------------------------------
  // The camera is deliberately NOT part of the signature: the dims live in the
  // scene, so an orbit re-renders them for free. All a camera move can change
  // is WHICH side each dim is drawn on — cheap to re-score every frame
  // (dot products + hysteresis), and only a genuine flip costs a rebuild.
  let lastSig = "";
  // Seeded with the ACTIVE VIEW: pins are per view, so switching views changes
  // what must be drawn even when the visible mesh set is byte-identical (two
  // views over the same sub-parts). v1 caught that incidentally through its
  // camera hash; without the camera here it has to be explicit.
  // The pose is hashed as its full rotation basis + translation, not just the
  // two diagonal terms — θ and −θ about X share cos θ on the diagonal, and
  // there is no camera hash left to notice the difference.
  function meshSig() {
    let sig = getContext().view;
    for (const [name, m] of Object.entries(viewer._subMeshes)) {
      const e = m.matrix.elements;
      sig += `|${name}:${m.visible ? 1 : 0}:${m.geometry.id}:${e[0]},${e[1]},${e[2]},${e[4]},${e[5]},${e[6]},${e[12]},${e[13]},${e[14]}`;
    }
    return sig;
  }
  const offFrame = viewer.onFrame(() => {
    if (!enabled || !scene) return;
    const sig = meshSig();
    if (sig !== lastSig) {
      lastSig = sig;
      // geometry identity is part of the signature, so a regenerate lands here;
      // visibility (e.g. a cutaway/view toggle hiding the sub-part) is hashed
      // too but changes NOTHING else about the mesh, so the signature alone
      // can't tell "regenerated" from "still the same geometry, just hidden" —
      // check both explicitly. Either way the hovered mesh is no longer a
      // valid target: drop the stale hover (and its highlight) and re-render.
      const m = viewer._subMeshes[hover?.subPart];
      if (hover && (!m || !m.visible || hover.geometry !== m.geometry)) {
        hover = null;
        highlight?.clear();
      }
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
    hover = null;
    highlight?.clear();
    rebuild();
  }) ?? (() => {});

  function hitToHover(hit) {
    let spec, key;
    if (hit.feature) {
      spec = featureSpec(hit.mesh, hit.feature.id);
      const { features } = hit.mesh.geometry.userData;
      key = { subPart: hit.subPart, featureLabel: hit.feature.label,
        occurrence: occurrenceOf(features, hit.feature.id) };
    }
    if (!spec) {
      if (!hit.mesh.geometry.boundingBox) hit.mesh.geometry.computeBoundingBox();
      const { min, max } = hit.mesh.geometry.boundingBox;
      spec = bboxSpec([min.x, min.y, min.z], [max.x, max.y, max.z]);
      key = { subPart: hit.subPart, featureLabel: null, occurrence: 0 };
    }
    return {
      key,
      geometry: hit.mesh.geometry,
      subPart: hit.subPart,
      mesh: hit.mesh,
      // spec stays in the mesh's own frame here; buildItems poses it.
      item: { id: "hover", tier: "hover", spec, subParts: [hit.subPart] },
    };
  }

  function onMove(ev) {
    if (!enabled || ev.pointerType === "touch" || suppressed) return;
    drag.onMove(ev);
    pendingMove = { x: ev.clientX, y: ev.clientY };
    if (moveScheduled) return;
    moveScheduled = true;
    schedule(() => {
      moveScheduled = false;
      const p = pendingMove;
      pendingMove = null;
      if (!enabled || detached || !p || suppressed) return;
      // A pointer over any dim label parks the hover state: labels usually
      // float OFF the geometry, so re-raycasting here would clear the hover
      // (and its label) out from under a cursor travelling toward it — the
      // label must survive its own approach to be clickable. The pointer
      // cursor is the click affordance a canvas can give.
      if (scene?.pickLabel(p.x, p.y)) {
        dom.style.cursor = "pointer";
        return;
      }
      dom.style.cursor = "";
      const hit = raycastViewer(viewer, p.x, p.y);
      if (hit) {
        hover = hitToHover(hit);
        highlight.show(hit);
      } else {
        hover = null;
        highlight.clear();
      }
      rebuild();
    });
  }
  const onLeave = () => { hover = null; highlight?.clear(); dom.style.cursor = ""; rebuild(); };

  function togglePin(key, subParts, value) {
    const { view } = getContext();
    const added = pins.toggle(view, key);
    if (added) revealRelevant(subParts, value);
    notifyPins();
    rebuild();
  }

  // Label pick first, then geometry: a dimension's text plane is a real object
  // in the scene, so clicking it must un-pin (or pin the hovered dim) rather
  // than fall through to whatever surface sits behind it.
  function onClick(ev) {
    const wasDragged = drag.consumeClick();
    if (!enabled || wasDragged) return;
    const picked = scene?.pickLabel(ev.clientX, ev.clientY);
    if (picked) {
      // Every label is a button to the controls that drive its measurement:
      // clicking flashes them (focusing an exact value match). A hover label
      // also pins. Labels never unpin — that stays on re-clicking the
      // geometry, or Clear — so the one visible affordance always means the
      // same thing.
      if (picked.itemId === "hover") {
        if (hover) togglePin(hover.key, hover.item.subParts, picked.value);
        return;
      }
      const item = lastItems.find((i) => i.id === picked.itemId);
      if (item) revealRelevant(item.subParts, picked.value);
      return;
    }
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const h = hitToHover(hit);
    togglePin(h.key, h.item.subParts, null);
  }

  const dom = viewer.domElement;
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", drag.onDown);
  dom.addEventListener("pointerup", drag.onUp);
  dom.addEventListener("pointercancel", drag.onCancel);
  dom.addEventListener("pointerleave", onLeave);
  dom.addEventListener("click", onClick);

  const offTheme = viewer.onThemeChange?.((mode) => {
    themeEpoch++; // drop the cached base drawings so the repaint is unconditional
    scene?.setTheme(mode);
    rebuild();
  }) ?? (() => {});

  function setEnabled(on) {
    if (detached || on === enabled) return;
    enabled = !!on;
    if (enabled) {
      scene ??= createDimScene(viewer);
      highlight ??= createFeatureHighlight(viewer);
      rebuild();
      // Adopt the signature this placement was built from, so the very next
      // frame doesn't read as "changed" and redo the whole vertex scan.
      lastSig = meshSig();
    } else {
      hover = null;
      highlight?.clear();
      scene?.clear();
      lastItems = [];
      lastBounds = null;
      baseCache.clear();
      paintCache.clear();
      painted = null;
      dom.style.cursor = "";
    }
    notifyMode();
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    clearPins() {
      pins.clear(getContext().view);
      notifyPins();
      rebuild();
    },
    pinCount: () => pins.count(getContext().view),
    getUnits: () => units,
    setUnits(next) {
      if (next === units || !(next in { mm: 1, in: 1 })) return;
      units = next;
      rebuild(); // labels re-render in the new unit; cache key carries it
    },
    onPinsChange: (cb) => { pinListeners.add(cb); return () => pinListeners.delete(cb); },
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    detach() {
      if (detached) return;
      detached = true;
      enabled = false;
      offFrame();
      unsubscribeHandleHover();
      offTheme();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", drag.onDown);
      dom.removeEventListener("pointerup", drag.onUp);
      dom.removeEventListener("pointercancel", drag.onCancel);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("click", onClick);
      highlight?.dispose();
      scene?.dispose();
      pinListeners.clear();
      modeListeners.clear();
    },
  };
}

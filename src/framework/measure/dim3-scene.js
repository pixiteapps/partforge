// In-scene dimension renderer (spec v2 + amendments). Renders dim3-place's
// parametric drawings as three.js objects parented under the meshes' shared
// group, so the pivot rotation, per-view recentring and pose fast path apply
// for free. Placement discovers WHERE a dimension is anchored; this module
// assembles its final geometry every frame, because every display distance is
// SCREEN-constant — sized off one shared reference distance (camera to the
// model centre) so the whole drawing reads the same at any zoom, on any part
// size, uniformly across a view. Text is painted onto canvas textures by an
// injectable painter (tests inject a fake; happy-dom has no real 2d context).
// Dims draw over the model (depthTest:false), are never cutaway-clipped
// (materials deliberately NOT registered with the cutaway), and are hidden
// from canonical captures.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "../cutaway-render.js";

// Theme palettes for dimension ink. Deliberately hardcoded (not CSS vars):
// the scene renders to WebGL where var() can't reach, and these pair with the
// viewer THEME backgrounds. static = always-on overall dims; strong = hover +
// pinned.
export const DIM_THEME = {
  dark: {
    static: 0x7d93b8, strong: 0xa8c2ff,
    text: "#d6e2ff", halo: "rgba(8, 11, 16, 0.95)",
  },
  light: {
    // darker ink + a solid near-white halo: the first light palette washed
    // out against the pale background and the part's light-blue surfaces
    static: 0x5a6c8a, strong: 0x2c4a86,
    text: "#182a4e", halo: "rgba(255, 255, 255, 0.96)",
  },
};

// Above the cutaway-overlay tier (section caps, and the hover highlight,
// which renders at CUTAWAY_OVERLAY_RENDER_ORDER): a later-drawn transparent
// highlight would otherwise tint every dim pixel it covers. The cutaway
// GIZMO deliberately stays above the dims — it is an active drag control.
export const RENDER_ORDER_DIMS = CUTAWAY_OVERLAY_RENDER_ORDER + 2;
export const RENDER_ORDER_LABELS = CUTAWAY_OVERLAY_RENDER_ORDER + 3;

// Screen-constant sizes, CSS px, all sized off the same per-view reference
// distance. Uniform per view by design — a nearer dimension is NOT normalized
// to match a farther one; it just reads slightly larger under perspective
// like the rest of the scene.
export const LABEL_SCREEN_PX = 21;     // label text height
export const ARROW_SCREEN_PX = 10;     // arrowhead length
export const ARROW_HALF_W = 0.25;      // × arrow length — the narrow drafting ratio
export const OVERSHOOT_SCREEN_PX = 7;  // extension line past the dim line
export const GAP_SCREEN_PX = 4;        // extension line stands off the surface
export const STANDOFF_SCREEN_PX = 40;  // dim line stands off the part (× dim's standoffScale)
export const STAGGER_SCREEN_PX = 26;   // extra standoff per stacked lane
export const LEADER_SCREEN_PX = 36;    // R-leader length

// World units per CSS pixel for a point at `dist` from the camera.
export function worldPerPx(dist, fovDeg, viewportPx) {
  return (2 * dist * Math.tan((fovDeg * Math.PI) / 360)) / viewportPx;
}

// The orthographic twin of worldPerPx. An ortho camera's scale is a property of
// its frustum and zoom alone — distance does not enter — which is exactly why
// the perspective formula cannot be reused with a substituted fov.
export function orthoWorldPerPx(top, bottom, zoom, viewportPx) {
  return Math.abs(top - bottom) / Math.max(zoom, 1e-6) / Math.max(viewportPx, 1);
}

// Kept for compatibility with earlier callers/tests: the world height that
// renders as `targetPx` on screen.
export function labelWorldHeight(dist, fovDeg, viewportPx, targetPx = LABEL_SCREEN_PX) {
  return targetPx * worldPerPx(dist, fovDeg, viewportPx);
}

// Default label painter: returns a canvas whose aspect the caller turns into
// a plane. Pure DOM-canvas; swapped out in tests. Plain value text only —
// the old param pill misattributed a set-level link to every label in the
// set, so the dimension->control affordance is now the click itself (every
// label click flashes the controls that drive the measurement).
export function defaultPaintLabel({ text, palette }) {
  const font = "700 96px ui-monospace, Menlo, monospace";
  const c = document.createElement("canvas");
  let ctx = c.getContext("2d");
  ctx.font = font;
  const wText = Math.ceil(ctx.measureText(text).width);
  const PAD = 20;
  c.width = wText + PAD * 2;
  c.height = 128;
  ctx = c.getContext("2d");
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.font = font;
  ctx.strokeStyle = palette.halo; // halo so bare text reads on the part body
  ctx.lineWidth = 12;
  ctx.strokeText(text, PAD, c.height / 2);
  ctx.fillStyle = palette.text;
  ctx.fillText(text, PAD, c.height / 2);
  return c;
}

export function createDimScene(viewer, { paintLabel = defaultPaintLabel } = {}) {
  // Dims are scene objects edited in place, not through a viewer call, so they
  // ask for the frame themselves (the viewer draws on demand). tick() needs no
  // request: it only follows the camera, and a camera move is already a frame.
  const redraw = () => viewer.requestRender?.();
  const group = new THREE.Group();
  group.name = "pf-dims";
  let attached = false;
  let unregisterCapture = () => {};
  function ensureAttached() {
    if (attached) return true;
    const parent = Object.values(viewer._subMeshes)[0]?.parent;
    if (!parent) return false;
    parent.add(group);
    unregisterCapture = viewer.registerCanonicalCaptureHidden?.(group) ?? (() => {});
    attached = true;
    return true;
  }

  let theme = viewer.getTheme?.() ?? "dark";
  const lineMats = {
    static: new LineMaterial({ color: DIM_THEME[theme].static, linewidth: 1.5 }),
    strong: new LineMaterial({ color: DIM_THEME[theme].strong, linewidth: 1.5 }),
  };
  const fillMats = {
    static: new THREE.MeshBasicMaterial({ color: DIM_THEME[theme].static, side: THREE.DoubleSide }),
    strong: new THREE.MeshBasicMaterial({ color: DIM_THEME[theme].strong, side: THREE.DoubleSide }),
  };
  for (const m of [...Object.values(lineMats), ...Object.values(fillMats)]) {
    m.depthTest = false;
    m.depthWrite = false; // overlay ink must not pollute the depth buffer
    m.transparent = true; // draw in the late pass so depthTest:false lands on top
  }

  const matFor = (tier) => (tier === "static" ? "static" : "strong");

  // Shared unit arrowhead: tip at the origin pointing +X, the narrow drafting
  // ratio baked in; instances are oriented at build time (their in-plane basis
  // never changes) and positioned + scaled per frame.
  const unitArrowGeo = new THREE.BufferGeometry();
  unitArrowGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    0, 0, 0, 1, ARROW_HALF_W, 0, 1, -ARROW_HALF_W, 0,
  ]), 3));

  const quatFromBasis = (x, y) => {
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  };

  function makeArrow(key, x, y, position) {
    const mesh = new THREE.Mesh(unitArrowGeo, fillMats[key]);
    mesh.quaternion.copy(quatFromBasis(x, y));
    if (position) mesh.position.copy(position);
    mesh.renderOrder = RENDER_ORDER_DIMS;
    mesh.frustumCulled = false; // scaled/moved per frame; stale bounds must not cull it
    group.add(mesh);
    arrows.push(mesh);
    return mesh;
  }

  // A LineSegments2 whose positions this module rewrites in place each frame.
  function makeLine(key, segmentCount) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(new Array(segmentCount * 6).fill(0));
    const line = new LineSegments2(geo, lineMats[key]);
    line.renderOrder = RENDER_ORDER_DIMS;
    line.frustumCulled = false;
    group.add(line);
    return line;
  }

  function writeSegments(line, arr) {
    const data = line.geometry.attributes.instanceStart.data;
    data.array.set(arr);
    data.needsUpdate = true;
  }

  // ---- record bookkeeping ---------------------------------------------------
  // labels: [{ mesh, baseQuat, mirrored, flipped, itemId, text, param }] —
  // positions/scale are written per frame by the owning record in tick().
  let labels = [];
  let arrows = [];
  let dimRecs = [];    // parametric linear dims
  let diamRecs = [];   // ⌀ lines (static line, per-frame label anchor)
  let leaderRecs = []; // R leaders
  const textureCache = new Map(); // `${theme}|${text}` -> THREE.CanvasTexture

  function labelTexture(text) {
    const key = `${theme}|${text}`;
    let tex = textureCache.get(key);
    if (!tex) {
      const canvas = paintLabel({ text, palette: DIM_THEME[theme] });
      tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8; // keep glancing-angle text legible
      textureCache.set(key, tex);
    }
    return tex;
  }

  function buildLabel(l, itemId) {
    const tex = labelTexture(l.text);
    const img = tex.image;
    const aspect = img && img.height ? img.width / img.height : 4;
    // unit-height plane; tick() scales it to the screen-constant display height
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(aspect, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.renderOrder = RENDER_ORDER_LABELS;
    mesh.frustumCulled = false;
    const x = new THREE.Vector3(...l.x), y = new THREE.Vector3(...l.y);
    mesh.quaternion.copy(quatFromBasis(x, y));
    mesh.userData.pfDimItemId = itemId;
    mesh.userData.pfDimValue = l.value ?? null;
    group.add(mesh);
    const rec = {
      mesh, baseQuat: mesh.quaternion.clone(), mirrored: false, flipped: false,
      itemId, text: l.text,
    };
    labels.push(rec);
    return rec;
  }

  // ---- build / clear --------------------------------------------------------
  function disposeChildren() {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child.geometry !== unitArrowGeo) child.geometry?.dispose?.(); // the unit arrow is shared
      // label materials are per-mesh clones; textures live in the cache
      if (child.material && !Object.values(lineMats).includes(child.material)
          && !Object.values(fillMats).includes(child.material)) {
        child.material.dispose?.();
      }
    }
    labels = [];
    arrows = [];
    dimRecs = [];
    diamRecs = [];
    leaderRecs = [];
  }

  function update(drawings) {
    if (!ensureAttached()) return;
    redraw();
    disposeChildren();
    for (const d of drawings) {
      const key = matFor(d.tier);
      for (const dim of d.dims ?? []) {
        const dir = new THREE.Vector3(...dim.dir);
        const ext = new THREE.Vector3(...dim.ext);
        dimRecs.push({
          pA: new THREE.Vector3(...dim.pA), pB: new THREE.Vector3(...dim.pB),
          baseA: new THREE.Vector3(...dim.baseA), baseB: new THREE.Vector3(...dim.baseB),
          ext, dir, lane: dim.lane ?? 0, standoffScale: dim.standoffScale ?? 1,
          line: makeLine(key, 5), // ext A, ext B, dim line, tail A, tail B
          arrowA: makeArrow(key, dir, ext),
          arrowB: makeArrow(key, dir.clone().negate(), ext),
          labelRec: buildLabel(dim.label, d.itemId),
        });
      }
      for (const diam of d.diams ?? []) {
        const rimA = new THREE.Vector3(...diam.rimA);
        const rimB = new THREE.Vector3(...diam.rimB);
        const du = new THREE.Vector3(...diam.du);
        const dv = new THREE.Vector3(...diam.dv);
        const line = makeLine(key, 1);
        writeSegments(line, [rimA.x, rimA.y, rimA.z, rimB.x, rimB.y, rimB.z]); // static
        makeArrow(key, du.clone().negate(), dv, rimA);
        makeArrow(key, du, dv, rimB);
        diamRecs.push({ rimA, du, labelRec: buildLabel(diam.label, d.itemId) });
      }
      for (const leader of d.leaders ?? []) {
        const rim = new THREE.Vector3(...leader.rim);
        const dir = new THREE.Vector3(...leader.dir);
        const perp = new THREE.Vector3(...leader.perp);
        leaderRecs.push({
          rim, dir,
          line: makeLine(key, 1),
          arrow: makeArrow(key, dir, perp, rim),
          labelRec: buildLabel(leader.label, d.itemId),
        });
      }
    }
    sweepTextureCache();
  }

  // Bound the texture cache to labels actually in use: continuous param
  // dragging mints a fresh label text every frame, so without this the cache
  // (one CanvasTexture each) would grow unboundedly across a session. Drop
  // every entry not referenced by the labels just built; entries from a prior
  // theme become unreferenced the moment setTheme() repaints (it fetches a
  // new-theme texture on demand but doesn't dispose the old one, since it's
  // still live if setTheme fires again before the next update) and are swept
  // here on the next update(), never while still assigned to a live label.
  function sweepTextureCache() {
    const live = new Set(labels.map((L) => `${theme}|${L.text}`));
    for (const [key, tex] of textureCache) {
      if (live.has(key)) continue;
      tex.dispose();
      textureCache.delete(key);
    }
  }

  // ---- per-frame assembly + readability flips -------------------------------
  // Labels correct among four in-plane states so they never read mirrored or
  // upside down: Ry(π) fixes viewing the plane from behind, Rz(π) fixes the
  // reading direction. 0.08 deadband stops edge-on flicker.
  const QY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const QZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const _gq = new THREE.Quaternion();
  const _wq = new THREE.Quaternion();
  const _iq = new THREE.Quaternion();
  const _n = new THREE.Vector3();
  const _x = new THREE.Vector3();
  const _wp = new THREE.Vector3();
  const _toCam = new THREE.Vector3();
  const _gp = new THREE.Vector3();
  const _dA = new THREE.Vector3();
  const _dB = new THREE.Vector3();
  const _uA = new THREE.Vector3();
  const _uB = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _seg = new Float32Array(30);
  function tick() {
    if (!attached || !group.children.length) return;
    const el = viewer.domElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    lineMats.static.resolution.set(w, h);
    lineMats.strong.resolution.set(w, h);
    // One shared reference distance — camera to the dim group's origin (the
    // recentred model centre) — sizes the whole drawing.
    group.getWorldPosition(_gp);
    // `viewer.camera.fov ?? 45` was the bug this branch removes: under an ortho
    // camera fov is undefined, so the fallback produced a plausible-but-wrong
    // scale and every label, arrow and standoff drifted as the user dollied.
    // The ortho formula matches cutaway-gizmo.js:485's worldUnitsPerPixelAt.
    const cam = viewer.camera;
    const wpp = cam.isOrthographicCamera
      ? orthoWorldPerPx(cam.top, cam.bottom, cam.zoom, h)
      : worldPerPx(cam.position.distanceTo(_gp), cam.fov ?? 45, h);
    if (wpp > 0) {
      const hStar = LABEL_SCREEN_PX * wpp;
      const aw = ARROW_SCREEN_PX * wpp;
      const gap = GAP_SCREEN_PX * wpp;
      const tail = OVERSHOOT_SCREEN_PX * wpp;
      for (const R of dimRecs) {
        const off = (STANDOFF_SCREEN_PX * R.standoffScale + R.lane * STAGGER_SCREEN_PX) * wpp;
        _dA.copy(R.baseA).addScaledVector(R.ext, off);
        _dB.copy(R.baseB).addScaledVector(R.ext, off);
        _uA.copy(_dA).sub(R.pA);
        if (_uA.lengthSq() > 1e-12) _uA.normalize(); else _uA.copy(R.ext);
        _uB.copy(_dB).sub(R.pB);
        if (_uB.lengthSq() > 1e-12) _uB.normalize(); else _uB.copy(R.ext);
        let i = 0;
        _p.copy(R.pA).addScaledVector(_uA, gap);
        _seg[i++] = _p.x; _seg[i++] = _p.y; _seg[i++] = _p.z;
        _seg[i++] = _dA.x; _seg[i++] = _dA.y; _seg[i++] = _dA.z;
        _p.copy(R.pB).addScaledVector(_uB, gap);
        _seg[i++] = _p.x; _seg[i++] = _p.y; _seg[i++] = _p.z;
        _seg[i++] = _dB.x; _seg[i++] = _dB.y; _seg[i++] = _dB.z;
        _seg[i++] = _dA.x; _seg[i++] = _dA.y; _seg[i++] = _dA.z;
        _seg[i++] = _dB.x; _seg[i++] = _dB.y; _seg[i++] = _dB.z;
        _p.copy(_dA).addScaledVector(_uA, tail);
        _seg[i++] = _dA.x; _seg[i++] = _dA.y; _seg[i++] = _dA.z;
        _seg[i++] = _p.x; _seg[i++] = _p.y; _seg[i++] = _p.z;
        _p.copy(_dB).addScaledVector(_uB, tail);
        _seg[i++] = _dB.x; _seg[i++] = _dB.y; _seg[i++] = _dB.z;
        _seg[i++] = _p.x; _seg[i++] = _p.y; _seg[i++] = _p.z;
        writeSegments(R.line, _seg);
        R.arrowA.position.copy(_dA);
        R.arrowB.position.copy(_dB);
        R.labelRec.mesh.position
          .copy(_dA).add(_dB).multiplyScalar(0.5)
          .addScaledVector(R.ext, 0.85 * hStar);
      }
      for (const R of diamRecs) {
        R.labelRec.mesh.position.copy(R.rimA).addScaledVector(R.du, 0.85 * hStar);
      }
      for (const R of leaderRecs) {
        const len = LEADER_SCREEN_PX * wpp;
        _p.copy(R.rim).addScaledVector(R.dir, gap);
        _dA.copy(R.rim).addScaledVector(R.dir, gap + len);
        writeSegments(R.line, [_p.x, _p.y, _p.z, _dA.x, _dA.y, _dA.z]);
        R.labelRec.mesh.position.copy(_dA).addScaledVector(R.dir, 0.85 * hStar);
      }
      for (const a of arrows) a.scale.setScalar(aw);
      for (const L of labels) L.mesh.scale.setScalar(hStar);
    }
    group.getWorldQuaternion(_gq);
    _iq.copy(viewer.camera.quaternion).invert();
    for (const L of labels) {
      _wq.copy(_gq).multiply(L.baseQuat);
      if (L.mirrored) _wq.multiply(QY);
      if (L.flipped) _wq.multiply(QZ);
      L.mesh.getWorldPosition(_wp);
      _toCam.copy(viewer.camera.position).sub(_wp).normalize();
      _n.set(0, 0, 1).applyQuaternion(_wq);
      const facing = _n.dot(_toCam);
      if (Math.abs(facing) > 0.08 && facing < 0) {
        L.mirrored = !L.mirrored;
        _wq.multiply(QY);
      }
      _x.set(1, 0, 0).applyQuaternion(_wq).applyQuaternion(_iq);
      if (Math.abs(_x.x) > 0.08 && _x.x < 0) L.flipped = !L.flipped;
      L.mesh.quaternion.copy(L.baseQuat);
      if (L.mirrored) L.mesh.quaternion.multiply(QY);
      if (L.flipped) L.mesh.quaternion.multiply(QZ);
    }
  }

  // ---- label picking --------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  // Returns { itemId, value } for the label under the pointer (value = the
  // measured number the label shows, for exact-match control focusing), or
  // null when no label is hit.
  function pickLabel(clientX, clientY) {
    if (!attached || !labels.length) return null;
    const r = viewer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    raycaster.setFromCamera(_ndc, viewer.camera);
    const hit = raycaster.intersectObjects(labels.map((L) => L.mesh), false)[0];
    return hit ? { itemId: hit.object.userData.pfDimItemId, value: hit.object.userData.pfDimValue ?? null } : null;
  }

  // ---- theme ----------------------------------------------------------------
  function setTheme(mode) {
    if (!DIM_THEME[mode] || mode === theme) return;
    theme = mode;
    redraw();
    lineMats.static.color.set(DIM_THEME[theme].static);
    lineMats.strong.color.set(DIM_THEME[theme].strong);
    fillMats.static.color.set(DIM_THEME[theme].static);
    fillMats.strong.color.set(DIM_THEME[theme].strong);
    // repaint labels: new-theme textures come from the cache or a fresh paint
    for (const L of labels) {
      L.mesh.material.map = labelTexture(L.text);
      L.mesh.material.needsUpdate = true;
    }
  }

  function clear() { disposeChildren(); redraw(); }

  function dispose() {
    redraw();
    disposeChildren();
    unregisterCapture();
    if (attached) group.parent?.remove(group);
    attached = false;
    for (const m of [...Object.values(lineMats), ...Object.values(fillMats)]) m.dispose();
    unitArrowGeo.dispose();
    for (const t of textureCache.values()) t.dispose();
    textureCache.clear();
  }

  return { update, tick, pickLabel, setTheme, clear, group, dispose };
}

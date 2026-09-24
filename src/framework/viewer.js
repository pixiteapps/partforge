import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { UltraHDRLoader } from "three/addons/loaders/UltraHDRLoader.js";
import { buildCadMaterial, buildPhysicalMaterial } from "./materials/physical.js";
import { grainAxisFor, setGrainAxis } from "./materials/patterns.js";
import { ensureBoxUVs } from "./materials/uv.js";
import { loadEnvironmentRig } from "./materials/environment.js";
import { assetUrl } from "./materials/assets.js";
import { resolveEnvironmentId } from "./materials/resolve.js";
import { neutralToneMapToSrgb8 } from "./materials/tonemap-readback.js";
import { createCutaway } from "./cutaway.js";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "./cutaway-render.js";
import { flashWorldRadius, projectToScreen, anchorMoved } from "./pick-flash.js";
import { createCameraTween } from "./camera-tween.js";
import { orbitPose } from "./camera-orbit.js";
import { orthoFrustum, perspectiveDistance } from "./projection.js";
import { depthRangeFor } from "./depth-range.js";
import { addViewerLights, captureLightPoses, createCaptureLights, createHemisphereLight } from "./viewer-lighting.js";
import { makeCaptureCamera, recenteredView, captureDepthRange } from "./capture-frame.js";
import { CANONICAL_VIEWS, cameraPoseForView } from "./view-angles.js";
import { defaultFeatureLines, styleFor } from "./view-style-state.js";

// three renders into a render target in the LINEAR working colour space: as of r184
// WebGLRenderer only applies `outputColorSpace` on the canvas path (WebGLPrograms
// substitutes workingColorSpace whenever a render target is bound), so readback pixels
// are linear no matter what the target texture's colorSpace says. Writing them straight
// into a JPEG is what made captured views come back muddy and dark compared to the live
// canvas. Encode the transfer function ourselves. The 8-bit LUT loses precision only in
// the deepest shadows, which a quality-0.9 JPEG would not have preserved anyway.
const SRGB8 = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const l = i / 255;
    table[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
  }
  return table;
})();

// Linear RGBA bytes → sRGB, in place. Alpha is a coverage value, not a colour: untouched.
export function srgbEncodeInPlace(data) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = SRGB8[data[i]];
    data[i + 1] = SRGB8[data[i + 1]];
    data[i + 2] = SRGB8[data[i + 2]];
  }
  return data;
}

// Readback (a realistic capture's target) → linear floats: half-float bits,
// or linear bytes from the 8-bit fallback target.
function readbackToLinear(buf) {
  const out = new Float32Array(buf.length);
  if (buf instanceof Uint16Array) for (let i = 0; i < buf.length; i++) out[i] = THREE.DataUtils.fromHalfFloat(buf[i]);
  else for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 255;
  return out;
}

// Can a realistic capture render HDR into a half-float target and read it
// back? Both halves fail SILENTLY otherwise: three's readRenderTargetPixels
// logs and returns when the type is not readable, and gl.readPixels with
// RGBA/HALF_FLOAT raises an unseen INVALID_OPERATION unless that is the
// implementation's read type — either way the buffer stays zero and the
// capture is a valid, all-black JPEG. `readable` is three's
// capabilities.textureTypeReadable(HalfFloatType) (needs a colour-buffer
// float extension, which is also what makes the target renderable);
// `readType` is the implementation read type for a bound, complete
// half-float framebuffer, or null when no GL context was there to ask (a
// failed probe passes something that is not `halfFloat`).
export function halfFloatCaptureSupported({ readable, readType = null, halfFloat = null }) {
  if (readable !== true) return false;
  return readType === null || readType === halfFloat;
}

// Render a set of canonical views without disturbing the live camera/canvas.
// `renderer.renderOffscreen(pose)` does the GL work (temp camera → offscreen
// target → readback → JPEG data URL); injected so this is unit-testable without
// a GL context. The grid is hidden for the whole synchronous pass and restored.
export function captureViewsFromScene(viewNames, { renderer, liveCamera, grid, bounds, sceneBounds, hidden = [] }) {
  const views = (viewNames?.length ? viewNames : ["iso", "front", "top"])
    .filter((v) => CANONICAL_VIEWS.includes(v))
    .slice(0, CANONICAL_VIEWS.length);
  const before = liveCamera.position.clone();
  const gridWasVisible = grid?.visible;
  if (grid) grid.visible = false;
  const hiddenWas = hidden.map((o) => o.visible);
  for (const o of hidden) o.visible = false;
  try {
    return views.map((view) => {
      const pose = cameraPoseForView(view, bounds);
      // `bounds` frames (half the max extent, by cameraPoseForView's contract);
      // `sceneBounds` is the sphere the depth planes must hold. The grid is
      // hidden for this whole pass, so the part alone is in the second one.
      return { view, dataUrl: renderer.renderOffscreen(pose, { sceneBounds }) };
    });
  } finally {
    if (grid) grid.visible = gridWasVisible;
    hidden.forEach((o, i) => { o.visible = hiddenWas[i]; });
    liveCamera.position.copy(before); // belt-and-suspenders: never leak camera state
  }
}

// The off-loop thumbnail capture (renderMeshPayloads, behind the handle's
// captureView) renders a THROWAWAY scene, so it gets no background from the
// live scene's theme — and before this constant existed it set none at all,
// which meant every thumbnail came back on the renderer's default opaque
// black, in light mode as much as dark. One deliberately theme-INDEPENDENT
// colour is the right answer rather than either THEME entry below: a thumbnail
// is baked at capture time and displayed later under host chrome this renderer
// cannot know (partforge-cloud's card grid draws them on both). Near the
// perceptual midpoint of THEME.light.bg / THEME.dark.bg, so it commits to
// neither, and clear of both the part material (0x9fb4cc, lighter) and the
// feature-edge lines (0x1c232d, much darker).
//
// The near-ZERO chroma is the part that looks arbitrary and isn't: the default
// part material is blue-grey, so a blue-grey background of the same value
// (0x6b7280 was the first try) competes with it and the shaded side of a part
// half-disappears into the plate. A neutral grey separates by hue as well as
// value. Judged on real captures of demo.js and hinged-box.js — if this is
// ever retuned, retune it the same way and not by eye on the hex.
export const THUMBNAIL_BG = 0x6e6e73;

// Resolve renderMeshPayloads' `background` option to what Scene.background
// wants. Exported for its own sake: renderMeshPayloads needs a GL context and
// so is untestable directly, and this is the whole of the decision. `null` is
// a real escape hatch — the pre-existing no-background behaviour, clearing to
// the renderer's clear colour — so it is passed through rather than treated as
// "unset"; only `undefined` (an absent option) takes the default.
export function thumbnailBackground(background = THUMBNAIL_BG) {
  return background === null ? null : new THREE.Color(background);
}

// Render the LIVE camera's current framing offscreen, once, at a caller-chosen
// resolution — the showcase capture behind the runtime handle's captureCurrent.
// Same injected-renderer split as captureViewsFromScene so it runs without a GL
// context: pose comes from the live camera (never a canonical pose), the output
// long edge is `size` clamped into [256, maxTextureSize], and the short edge
// follows the live camera's aspect so the capture matches what the user framed.
//
// `recenter: true` (opt-in; the default keeps the exact viewport framing) renders
// the largest centred sub-window that still holds every visible vertex — a
// showcase image with the part in the middle and equal margins — and leaves the
// framing alone when the geometry runs off the frame, since a user who zoomed
// past the part's edge framed that crop on purpose. The extent is projected
// through the same camera the render uses (capture-frame.js), so it is exact;
// `meshes` are the visible sub-part meshes it reads.
export function captureCurrentFromScene(
  { size = 2048, hideGrid = true, quality = 0.9, recenter = false } = {},
  { renderer, liveCamera, target, grid, maxTextureSize, projection = "perspective", orthoHalfH, meshes, sceneBounds },
) {
  const MIN_SIZE = 256;
  // WebGL2 guarantees MAX_TEXTURE_SIZE >= 2048; only trust a larger reported cap.
  const long = Math.min(Math.max(Math.round(size) || MIN_SIZE, MIN_SIZE), maxTextureSize ?? 2048);
  // An OrthographicCamera has no `aspect` — its aspect lives in the frustum. Read
  // it there, or the capture comes back SQUARE from a wide viewport the moment the
  // user toggles to ortho: silent, and only wrong in the saved image.
  const aspect = liveCamera.aspect
    || (liveCamera.isOrthographicCamera
      ? (liveCamera.right - liveCamera.left) / (liveCamera.top - liveCamera.bottom)
      : 0)
    || 1;
  const width = aspect >= 1 ? long : Math.max(1, Math.round(long * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(long / aspect)) : long;
  const pose = { position: liveCamera.position.toArray(), up: liveCamera.up.toArray(), target };
  // fov is meaningless under an ortho camera; orthoHalfH replaces it. The
  // CANONICAL capture path deliberately never passes either — agent-facing
  // renders stay perspective regardless of what the user is looking at.
  const fov = liveCamera.fov ?? 45;
  // Null means "keep the viewport framing": part cropped by the viewport,
  // already centred, or nothing to measure.
  const frame = (recenter && recenteredView(pose, { aspect, fov, projection, orthoHalfH, meshes, long, sceneBounds }))
    || { width, height };
  const before = liveCamera.position.clone();
  const gridWasVisible = grid?.visible;
  if (grid && hideGrid) grid.visible = false;
  try {
    return renderer.renderOffscreen(pose, { ...frame, fov, quality, projection, orthoHalfH, sceneBounds });
  } finally {
    if (grid && hideGrid) grid.visible = gridWasVisible;
    liveCamera.position.copy(before); // belt-and-suspenders: never leak camera state
  }
}

export function createViewer(container, part) {
  const names = Object.keys(part.parts);

  // --- renderer / scene / camera --------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Declared up here, not beside setActive() below, because the initial resize()
  // runs during construction and reads it.
  let active = true;

  const scene = new THREE.Scene();

  // Light/dark scene palettes (the page chrome is themed separately, via CSS on the
  // host page). A part can override the dark background through meta.background.
  const THEME = {
    dark:  { bg: part.meta?.background ?? 0x15181d, grid: [0x2c333d, 0x222831], line: 0x1c232d },
    light: { bg: 0xe9edf2, grid: [0xc4ccd6, 0xd6dce4], line: 0x33414f },
  };
  scene.background = new THREE.Color(THEME.dark.bg);

  let currentTheme = "dark";
  const themeListeners = new Set();
  function onThemeChange(cb) { themeListeners.add(cb); return () => themeListeners.delete(cb); }

  // Two cameras, one active. The perspective camera stays the source of truth
  // for fov and aspect; the ortho camera borrows both through projection.js so
  // a toggle never changes the part's size on screen.
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(18, 12, 18);
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  orthoCamera.position.copy(camera.position);
  let activeCamera = camera;
  let projectionMode = "perspective";
  const projectionListeners = new Set();

  const controls = new OrbitControls(activeCamera, renderer.domElement);
  controls.enableDamping = true;

  // --- lights + grid --------------------------------------------------------
  const liveLights = addViewerLights(scene);
  // 1 cm grid (mm units): 300 mm wide, 30 divisions -> 10 mm (1 cm) squares.
  const GRID_SIZE = 300, GRID_DIVS = 30;
  let floorY = 0; // world Y of the grid plane; set to the part's bbox bottom in frameTo
  let grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVS, THEME.dark.grid[0], THEME.dark.grid[1]);
  scene.add(grid);

  // --- material + part groups -----------------------------------------------
  const material = new THREE.MeshStandardMaterial({
    color: 0x9fb4cc,
    metalness: 0.25,
    roughness: 0.55,
    flatShading: false,
    polygonOffset: true, // push the surface back so edge lines sit cleanly on top
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  // Sub-parts are meshed independently in a shared frame and cached, so any view
  // is composed from cached pieces. `pivot` stands the part's Z axis up (parts are
  // modelled Z-up; this faces the camera); `partsGroup` is recentred per view so
  // the visible assembly sits at the origin.
  const pivot = new THREE.Group();
  pivot.rotation.x = -Math.PI / 2; // model Z (CAD up) -> vertical
  scene.add(pivot);
  const partsGroup = new THREE.Group();
  pivot.add(partsGroup);

  // Per-sub-part CAD material: the shared default unless the sub-part declares
  // appearance in `display` (colour, opacity, or a library material flattened
  // for the CAD view — materials/resolve.js cadAppearance).
  function materialFor(name) {
    return buildCadMaterial(part.parts[name].display, material);
  }

  const subMesh = Object.fromEntries(
    names.map((n) => [n, new THREE.Mesh(new THREE.BufferGeometry(), materialFor(n))])
  );
  for (const [n, m] of Object.entries(subMesh)) {
    m.name = n;
    m.visible = false;
    partsGroup.add(m);
  }

  // CAD-style feature edge lines (anti-aliased "fat" lines), one per sub-part.
  const EDGE_ANGLE = 35; // deg — last-ditch threshold for payloads with no kernel edge data
  const lineMaterial = new LineMaterial({ color: THEME.dark.line, linewidth: 1.0 }); // ~10% lighter, 1 px
  lineMaterial.resolution.set(1, 1); // real size set by resize() below
  const subLines = Object.fromEntries(
    names.map((n) => [n, new LineSegments2(new LineSegmentsGeometry(), lineMaterial)])
  );
  for (const l of Object.values(subLines)) {
    l.visible = false;
    partsGroup.add(l);
  }

  // --- animated per-sub-part opacity (display-only) ---------------------------
  // Overrides from the animation driver (spec 2026-08-10-per-view-animations):
  // absent = normal, 0 = fully hidden (mesh AND lines), 0<v<1 = faded on cloned
  // materials. Never touches geometry, params, or exports — this is the display
  // half of "fade a part in, then animate it into place".
  const animOpacity = new Map();     // name -> value in [0, 1)
  const baseMats = Object.fromEntries(names.map((n) => [n, subMesh[n].material]));
  // baseMats is the CURRENT source material per sub-part, which realistic mode
  // re-points at a physical material; cadMats keeps the CAD ones for the way
  // back, and is what dispose() frees.
  const cadMats = { ...baseMats };
  const fadeMats = new Map();        // name -> lazily cloned MeshStandardMaterial
  const fadeLineMats = new Map();    // name -> lazily cloned LineMaterial
  const fadeUnregisters = new Map(); // fade material -> its cutaway unregister fn
  let lastShown = [];                // names last passed to showAssembly
  // The render mode's LOOK, read by applySubOpacity (feature lines follow the
  // per-style preference below, not the mode itself) and the depth range (the
  // realistic ground disc). Declared here, ahead of everything that reads it;
  // the mode itself lives in the realistic-mode block.
  let renderMode = "cad";
  let realisticRig = null;
  let shadowMovedAt = null;          // performance.now() of a pose change the contact shadow has not caught up with

  // three calls scene.onBeforeRender(renderer, scene, camera, target) at the
  // very start of WebGLRenderer.render — after scene/camera matrixWorld are
  // current, before objects are projected — so visibility set here applies to
  // THAT render with the camera actually doing it: the live canvas, an
  // offscreen capture (renderOffscreen reuses this same `scene`), and the
  // contact shadow's own depth pass (which renders `scene` from below with
  // its own camera, hiding every non-caster and restoring them in `finally`).
  // That restore is not exact for the print bed: if the bed group was already
  // hidden going in, the hook can set it visible for the shadow camera and
  // leave it that way after the pass. Harmless — the next render's hook
  // recomputes the flag for ITS camera before anything is drawn, and the
  // plate lies outside the shadow camera's frustum, so the depth pass never
  // draws it either way. No-op outside realistic mode or for a rig
  // whose environment has nothing to hide (the ground discs already cull by
  // their material's own side).
  const priorSceneOnBeforeRender = scene.onBeforeRender;
  scene.onBeforeRender = (r, s, camera, target) => {
    priorSceneOnBeforeRender?.(r, s, camera, target);
    if (renderMode === "realistic") realisticRig?.updateForCamera?.(camera);
  };

  const effectiveVisible = () => lastShown.filter((n) => (animOpacity.get(n) ?? 1) > 0);

  // A fade clone is a material the cutaway does not own, so it has to be told
  // about the clipping plane explicitly — otherwise a mid-fade part renders
  // un-sectioned while its stencil caps and cut-face outline keep drawing.
  // registerClippableMaterial syncs immediately, so a clone created while the
  // cutaway is already on picks up the current state.
  //
  // Known cosmetic remainder, accepted: the hatch cap keeps its full-strength
  // opacity while the surface above it fades, because the cap derives its
  // colour/opacity from the base material at refreshSourceMaterial time. A part
  // at opacity 0 drops out of the cutaway's visible set entirely, so the cap
  // only over-reads during the transient middle of a fade; re-deriving cap
  // opacity per frame would cost a material rebuild for a state that lasts
  // under a second.
  function fadeMatFor(name) {
    let m = fadeMats.get(name);
    if (!m) {
      m = baseMats[name].clone();
      m.transparent = true;
      m.depthWrite = false;
      fadeUnregisters.set(m, cutaway.registerClippableMaterial(m));
      fadeMats.set(name, m);
    }
    return m;
  }
  function fadeLineMatFor(name) {
    let m = fadeLineMats.get(name);
    if (!m) {
      m = lineMaterial.clone();
      m.transparent = true;
      m.resolution.copy(lineMaterial.resolution);
      fadeUnregisters.set(m, cutaway.registerClippableMaterial(m));
      fadeLineMats.set(name, m);
    }
    return m;
  }

  // Re-derive one sub-part's material + visibility from (shown, override).
  function applySubOpacity(name) {
    const mesh = subMesh[name], lines = subLines[name];
    if (!mesh) return;
    const shown = lastShown.includes(name);
    const v = animOpacity.get(name);
    if (v === undefined) {
      // Restore ONLY from our own fade clone. showAssembly runs on every regen
      // (mount.js's refreshView) without disabling the cutaway, and an enabled
      // cutaway has swapped these onto its clipped clones
      // (createSectionRenderSet.setEnabled) — an unconditional write here would
      // silently drop clipping on every sub-part on the next param edit.
      const hadFade = mesh.material === fadeMats.get(name);
      if (hadFade) mesh.material = baseMats[name];
      if (lines.material === fadeLineMats.get(name)) lines.material = lineMaterial;
      // We just took the mesh off our clone, so an enabled cutaway must get the
      // chance to re-claim it onto its clipped clone — the base material we
      // wrote above carries no plane, and nothing else would put it back until
      // the next cutaway toggle or theme change. Guarded on hadFade so the
      // every-regen showAssembly path stays a no-op for un-faded sub-parts.
      if (hadFade) cutaway.resyncSubpart(name);
      mesh.visible = shown;
      lines.visible = shown && linesOn();
      return;
    }
    if (v <= 0) {
      mesh.visible = false;
      lines.visible = false;
      return;
    }
    const staticOpacity = part.parts[name].display?.opacity ?? 1;
    const fm = fadeMatFor(name);
    fm.opacity = staticOpacity * v;
    mesh.material = fm;
    const flm = fadeLineMatFor(name);
    flm.opacity = v;
    lines.material = flm;
    mesh.visible = shown;
    lines.visible = shown && linesOn();
  }

  function setSubPartOpacity(name, value) {
    if (!subMesh[name]) return;
    const wasZero = (animOpacity.get(name) ?? 1) <= 0;
    if (value == null || !(value < 1)) animOpacity.delete(name); // null/undefined/NaN/>=1 clear
    else animOpacity.set(name, Math.max(0, value));
    applySubOpacity(name);
    const isZero = (animOpacity.get(name) ?? 1) <= 0;
    if (wasZero !== isZero) {
      cutaway.setVisible(effectiveVisible());
      if (realisticRig) shadowMovedAt = performance.now(); // a caster came or went
    }
  }

  function clearSubPartOpacities() {
    if (!animOpacity.size) return;
    const touched = [...animOpacity.keys()];
    animOpacity.clear();
    for (const n of touched) applySubOpacity(n);
    cutaway.setVisible(effectiveVisible());
  }

  // The cutaway plane lives in world space, so its initial/reset bounds must
  // include the pivot rotation and the per-view recentering transform —
  // mesh.matrixWorld carries both. Union each visible mesh's own
  // geometry.boundingBox rather than `Box3.expandByObject`, which recurses into
  // children: the two stencil-pass meshes share `mesh.geometry` so that
  // recursion is harmless for them, but the cut-face outline child carries its
  // own independent geometry that only re-slices while the cutaway is enabled
  // and visible — while hidden it can keep segments from an older, larger part
  // and inflate these bounds. A subpart's initial placeholder BufferGeometry
  // has no boundingBox computed (only buildGeometry computes one), so skip it.
  const _worldBounds = new THREE.Box3();
  const _meshBounds = new THREE.Box3();
  function getVisibleWorldBounds() {
    _worldBounds.makeEmpty();
    for (const mesh of Object.values(subMesh)) {
      if (!mesh.visible || !mesh.geometry?.boundingBox) continue;
      mesh.updateWorldMatrix(true, false);
      _meshBounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      _worldBounds.union(_meshBounds);
    }
    return _worldBounds;
  }

  // --- depth range ------------------------------------------------------------
  // The sphere the near/far planes are sized against: everything a render will
  // actually draw, as `{ center, radius }`. `withGrid` is a parameter rather
  // than a read of `grid.visible` because the offscreen captures hide the grid
  // for the duration of their render and ask for their bounds either side of
  // that — and the grid is the bigger half of the answer for a small part
  // (300 mm across a 12 mm spacer), so getting it wrong is not a rounding
  // error. Null when there is nothing to draw.
  const _depthBounds = new THREE.Box3();
  const _depthCenter = new THREE.Vector3();
  const _depthSize = new THREE.Vector3();
  const _gridCorner = new THREE.Vector3();
  const _groundBounds = new THREE.Box3();
  function sceneDepthBounds({ withGrid } = {}) {
    // getVisibleWorldBounds returns a SHARED Box3 that the cutaway also reads,
    // so copy before touching it.
    _depthBounds.copy(getVisibleWorldBounds());
    if (withGrid) {
      const half = GRID_SIZE / 2;
      _depthBounds.expandByPoint(_gridCorner.set(-half, floorY, -half));
      _depthBounds.expandByPoint(_gridCorner.set(half, floorY, half));
    }
    // The realistic ground disc is several part radii across, so it is the
    // bigger half of the answer the way the grid is in CAD: without it the far
    // plane cuts the disc's back edge off.
    if (realisticRig) _depthBounds.union(_groundBounds.setFromObject(realisticRig.ground));
    if (_depthBounds.isEmpty()) return null;
    return {
      center: _depthBounds.getCenter(_depthCenter).toArray(),
      radius: _depthBounds.getSize(_depthSize).length() / 2,
    };
  }

  // Re-size the live camera's depth range to the scene, once per frame. Cheap
  // by construction — the bounds are a union of already-computed per-mesh
  // boxes, and depthRangeFor quantizes, so the projection matrix is rebuilt
  // only when the answer actually moves a step. Only the ACTIVE camera is
  // written: the two projections take different near planes (an orthographic
  // one may legitimately be negative, which would be a broken perspective
  // matrix), and setProjection re-runs this on the camera it swaps in.
  function updateDepthRange() {
    const bounds = sceneDepthBounds({ withGrid: grid.visible });
    if (!bounds) return; // nothing shown — leave the planes where they are
    const { near, far } = depthRangeFor({
      // _depthCenter is the vector sceneDepthBounds just wrote its centre into.
      distance: activeCamera.position.distanceTo(_depthCenter),
      radius: bounds.radius,
      projection: projectionMode,
    });
    if (activeCamera.near === near && activeCamera.far === far) return;
    activeCamera.near = near;
    activeCamera.far = far;
    activeCamera.updateProjectionMatrix();
  }

  const cutaway = createCutaway({
    renderer,
    scene,
    camera: activeCamera, // kept current across a projection swap via cutaway.setCamera
    orbitControls: controls,
    domElement: renderer.domElement,
    getBounds: getVisibleWorldBounds,
    edgeColor: THEME.dark.line,
  });
  for (const name of names) {
    cutaway.setSubpart(name, subMesh[name], subLines[name]);
  }

  // --- realistic mode ---------------------------------------------------------
  // "cad" is the drafting view (flat lights, grid, feature lines); "realistic"
  // swaps every sub-part onto a physical material lit by an environment rig,
  // with a ground and contact shadow brought to the part — which never moves.
  //
  // Materials change through ONE seam, rebaseSubMaterial: baseMats is what the
  // fade clones and the cutaway's clipped clones are derived from, so the swap
  // re-points that and lets both re-derive, rather than writing mesh.material
  // (which the cutaway and the fades own) directly.
  //
  // Everything a load can fail at (the rig, the physical materials, the shader
  // compile) happens BEFORE the live scene is touched, and the swap itself is
  // one synchronous block that rolls back to CAD if it throws — so a failure at
  // any point leaves a whole CAD (or the previous realistic) view, never a
  // half-swapped one. Rigs are cached for the viewer's life and freed only in
  // dispose(): scene.environment/background may still point into one.
  let environmentId = resolveEnvironmentId(part.meta?.environment).id;
  let modeToken = 0;                 // bumped by every request; a stale completion does nothing
  let realisticPending = false;      // a realistic request is in flight (setEnvironment joins it)
  let environmentChosen = false;     // set by setEnvironment; false while seeded from meta/default

  // Feature lines, remembered per style (view-style-state.js has the defaults).
  // `linesOverride` pins them for a capture that must not follow the user's
  // switch: agent-facing CAD renders always draw them, realistic ones never.
  let featureLinesPrefs = {};
  let linesOverride = null;
  const linesListeners = new Set();
  const currentStyle = () => styleFor(renderMode, realisticRig?.id ?? environmentId);
  const linesOn = () => linesOverride ?? (featureLinesPrefs[currentStyle()] ?? defaultFeatureLines(currentStyle()));
  function refreshFeatureLines() { for (const n of names) applySubOpacity(n); }
  function withFeatureLines(on, fn) {
    const before = linesOverride;
    linesOverride = on;
    refreshFeatureLines();
    try { return fn(); } finally { linesOverride = before; refreshFeatureLines(); }
  }
  function announceFeatureLines() {
    const evt = { style: currentStyle(), on: linesOn() };
    for (const cb of [...linesListeners]) {
      try { cb(evt); } catch (e) { console.warn("partforge: feature-lines listener failed", e); }
    }
  }
  function setFeatureLines(on) {
    featureLinesPrefs = { ...featureLinesPrefs, [currentStyle()]: !!on };
    refreshFeatureLines();
    announceFeatureLines();
  }
  function setFeatureLinesPrefs(prefs) {
    featureLinesPrefs = { ...(prefs ?? {}) };
    refreshFeatureLines();
    announceFeatureLines();
  }

  const physicalMats = new Map();    // name -> MeshPhysicalMaterial (environment-independent, cached)
  const rigCache = new Map();        // environment id -> Promise<Rig>
  const loadedRigs = new Map();      // environment id -> Rig, once its load has landed (synchronous captures)
  const thumbnailRigRefs = new Map(); // environment id -> count of in-flight renderStyleThumbnail calls using it
  const textureCache = new Map();    // asset file name -> Texture
  const textureLoader = new THREE.TextureLoader();
  let pmrem = null;
  let printFrames = {};
  const modeListeners = new Set();
  const envListeners = new Set();
  const SHADOW_LOWRES_MS = 100;      // at most one low-res shadow per this, while a part moves
  const SHADOW_SETTLE_MS = 200;      // …and one full-res render this long after the last move
  let shadowLowResAt = -Infinity;
  const isCoarsePointer = () => {
    try { return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches; } catch { return false; }
  };

  // Anisotropic filtering: the ground disc and the wood grain are seen at grazing
  // angles, where plain trilinear mip selection blurs them into smeared blocks.
  //
  // TextureLoader.load returns at once and fills `image` later, so a rig (or a
  // physical material) is "ready" long before its maps are: a capture taken
  // straight away draws the floor and the wood untextured. Each load therefore
  // records a settle promise (resolved on load AND on error — a missing map is
  // drawn without it, never an error), and whenTexturesSettled() waits for them.
  const pendingTextures = new Set();
  const loadTexture = (file) => {
    let t = textureCache.get(file);
    if (!t) {
      let settle;
      const settled = new Promise((resolve) => { settle = resolve; });
      pendingTextures.add(settled);
      settled.then(() => pendingTextures.delete(settled));
      t = textureLoader.load(assetUrl(file), () => settle(), undefined, () => settle());
      t.anisotropy = Math.min(8, renderer.capabilities?.getMaxAnisotropy?.() ?? 1);
      textureCache.set(file, t);
    }
    return t;
  };
  // Every texture requested so far has loaded or failed. Loops, because waiting
  // can overlap more requests (a material built by a later compile). Bounded:
  // an image request that never answers must not hang a mode switch or a
  // capture forever — past the cap it draws with whatever has arrived.
  const TEXTURE_SETTLE_CAP_MS = 15000;
  async function whenTexturesSettled() {
    const deadline = Date.now() + TEXTURE_SETTLE_CAP_MS;
    while (pendingTextures.size) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer;
      await Promise.race([
        Promise.all([...pendingTextures]),
        new Promise((resolve) => { timer = setTimeout(resolve, left); }),
      ]);
      clearTimeout(timer);
    }
  }
  const loadHdr = (url) => new UltraHDRLoader().setDataType(THREE.HalfFloatType).loadAsync(url);
  function rigFor(id) {
    if (!rigCache.has(id)) {
      pmrem ??= new THREE.PMREMGenerator(renderer);
      const p = loadEnvironmentRig(renderer, id, { loadHdr, loadTexture, pmrem });
      // A failure is retryable, not memoized — but only drop THIS attempt.
      p.then((rig) => { if (rigCache.get(id) === p) loadedRigs.set(id, rig); },
        () => { if (rigCache.get(id) === p) rigCache.delete(id); });
      rigCache.set(id, p);
    }
    return rigCache.get(id);
  }

  // A rig loaded only to draw a thumbnail is freed straight away: each holds
  // its equirect (~16 MB of half-float) and a PMREM, and four of them resident
  // on a phone is not acceptable. The live one (or one a switch is loading) stays
  // — and only those: in CAD, the default environment is freed like any other.
  // rig.dispose() also disposes the ground textures loadTexture cached — safe:
  // each environment.js ground.texture/roughnessTexture/normalTexture is a
  // distinct file (environments.js), so no two rigs ever share a Texture
  // object, and Texture.dispose() only frees the GPU handle (via the
  // renderer's 'dispose' listener) — it leaves texture.image and every field
  // three's uploader reads untouched. loadTexture keeps returning that same
  // (still-intact) Texture object out of textureCache, so a later rigFor for
  // this id just re-uploads it on the next render, exactly like a first load.
  //
  // Concurrent thumbnails of the same environment share one in-flight rig
  // promise (rigFor's own cache), and a rig's envMap is a PMREM render-target
  // texture that CANNOT re-upload once disposed — so releasing while a
  // sibling call is still capturing with it would leave that capture's
  // reflections black. `p` is the exact promise this call awaited from
  // rigFor: `thumbnailRigRefs` counts in-flight users of `id` (bumped by the
  // caller right after rigFor, decremented here), and this only deletes/
  // disposes once that count reaches 0 AND `rigCache.get(id) === p` — the
  // second check is what stops a call from freeing a *different* rig a later
  // load (or the live environment) has since put in the cache for the same id.
  function releaseThumbnailRig(id, p) {
    const refs = (thumbnailRigRefs.get(id) ?? 0) - 1;
    if (refs > 0) { thumbnailRigRefs.set(id, refs); return; }
    thumbnailRigRefs.delete(id);
    // Keep only a rig that is (or is about to be) on screen. In CAD the
    // current environment's id alone is no reason: nothing is showing it, and
    // a realistic switch reloads it (from the texture cache) when asked.
    if (realisticRig?.id === id || (realisticPending && id === environmentId)) return;
    if (rigCache.get(id) !== p) return;
    rigCache.delete(id);
    loadedRigs.delete(id);
    p.then((r) => r.dispose(), () => {});
  }

  // three's Material.copy carries neither onBeforeCompile nor
  // customProgramCacheKey, and it JSON-copies userData. For a patterned
  // physical material (patterns.js) that means every clone the cutaway or a
  // fade makes silently drops the pattern — and serializes the pattern texture's
  // image through a canvas to do it. So a patterned material's clone shares the
  // hooks and the uniforms object (one print frame drives them all) instead.
  function cloneKeepsPattern(m) {
    if (!Object.hasOwn(m, "onBeforeCompile")) return m;
    m.clone = function clone() {
      const uniforms = this.userData.patternUniforms;
      delete this.userData.patternUniforms;
      let c;
      try { c = THREE.MeshPhysicalMaterial.prototype.clone.call(this); } finally {
        if (uniforms) this.userData.patternUniforms = uniforms;
      }
      if (uniforms) c.userData.patternUniforms = uniforms;
      c.onBeforeCompile = this.onBeforeCompile;
      c.customProgramCacheKey = this.customProgramCacheKey;
      c.clone = clone;
      return c;
    };
    return m;
  }
  function physicalFor(name) {
    let m = physicalMats.get(name);
    if (!m) {
      m = cloneKeepsPattern(buildPhysicalMaterial(part.parts[name].display, { printFrame: printFrames[name], loadTexture }));
      physicalMats.set(name, m);
      syncGrain(name);
    }
    return m;
  }
  // Wood grain runs along the sub-part's longest axis (patterns.js). The
  // uniforms are shared with every clone, so setting them once reaches the
  // cutaway's and the fades' copies too. Called when the material is built and
  // whenever new geometry lands (a regen can change which axis is longest).
  function syncGrain(name) {
    const m = physicalMats.get(name);
    const geo = subCache[name];
    if (m && geo) setGrainAxis(m, grainAxisFor(geo.boundingBox));
  }

  function publishMode(extra = {}) {
    const evt = { mode: renderMode, busy: false, error: null, ...extra };
    for (const cb of [...modeListeners]) {
      try { cb(evt); } catch (e) { console.warn("partforge: render-mode listener failed", e); }
    }
  }

  // Point one sub-part at a new source material. The fade clones were cloned
  // from the old one, so they go (applySubOpacity re-clones on demand); the
  // cutaway re-derives its clipped clone and reassigns mesh.material for its
  // current state; then any live fade is re-asserted on top.
  function rebaseSubMaterial(name, mat) {
    for (const map of [fadeMats, fadeLineMats]) {
      const clone = map.get(name);
      if (!clone) continue;
      fadeUnregisters.get(clone)?.();
      fadeUnregisters.delete(clone);
      clone.dispose();
      map.delete(name);
    }
    baseMats[name] = mat;
    cutaway.refreshSubpartMaterial(name, mat);
    applySubOpacity(name);
  }
  function setSubMaterials(matFor) {
    for (const n of names) {
      const m = matFor(n);
      if (baseMats[n] !== m) rebaseSubMaterial(n, m);
      else applySubOpacity(n); // same material, but the lines follow the mode
    }
  }

  // Ghosts (a static display opacity below 1) cast no shadow.
  const castersNow = () => names
    .filter((n) => subMesh[n].visible && (part.parts[n].display?.opacity ?? 1) >= 1)
    .map((n) => subMesh[n]);
  // `force` renders even while parked: a capture is offscreen work a parked
  // viewer still does, and it must not bake a stale (or absent) shadow.
  function renderShadow(opts, { force = false } = {}) {
    if (!realisticRig || (!active && !force)) return;
    try {
      if (opts) realisticRig.shadow.render(scene, castersNow(), opts);
      else realisticRig.shadow.render(scene, castersNow());
    } catch (e) {
      console.warn("partforge: contact shadow failed", e);
    }
  }
  // The ground comes to the part: it sits at the bottom of what is visible and
  // is sized from it. Only on showAssembly (and on entering the mode) — an
  // animated pose change moves the shadow, never the floor.
  function placeGround({ force = false } = {}) {
    if (!realisticRig) return;
    const b = getVisibleWorldBounds(); // shared Box3: read it out before anything else runs
    if (b.isEmpty()) return;
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    realisticRig.setGround({
      y: b.min.y, centerX: center.x, centerZ: center.z, radius: size.length() / 2, footprintMm: Math.max(size.x, size.z),
    });
    shadowMovedAt = null; // this render is the full-resolution one
    renderShadow(undefined, { force });
  }
  // Called once per rendered frame: low-res while a part is moving, one full
  // render once it has settled, nothing while it is still.
  function updateMovingShadow() {
    if (!realisticRig || shadowMovedAt == null) return;
    const t = performance.now();
    if (t - shadowMovedAt >= SHADOW_SETTLE_MS) {
      shadowMovedAt = null;
      renderShadow();
    } else if (t - shadowLowResAt >= SHADOW_LOWRES_MS) {
      shadowLowResAt = t;
      renderShadow({ lowRes: true });
    }
  }

  const livePixelRatio = (mode) =>
    Math.min(devicePixelRatio, mode === "realistic" && isCoarsePointer() ? 1.5 : 2);
  function applyPixelRatio(mode) {
    const want = livePixelRatio(mode);
    if (renderer.getPixelRatio() === want) return;
    renderer.setPixelRatio(want);
    resize();
  }

  // The two synchronous halves of a mode change. `live: false` is for a
  // capture that borrows a look for one synchronous render (it leaves the
  // canvas's pixel ratio alone, and renders the shadow even while parked);
  // nothing here publishes — setRenderMode does. `reground: false` puts a rig
  // back exactly where it was (after a CAD capture borrowed the scene): the
  // ground only moves on showAssembly, never because a capture happened.
  function enterRealistic(rig, { live = true, reground = true } = {}) {
    try {
      renderMode = "realistic";
      // A regen can land between the proxy compile and here, while the mode
      // was still CAD, so setSubGeometry skipped the UVs. Idempotent.
      for (const n of names) if (subCache[n] && physicalFor(n).userData.pfAnisotropic) ensureBoxUVs(subCache[n]);
      setSubMaterials(physicalFor);
      if (realisticRig && realisticRig !== rig) scene.remove(realisticRig.ground, realisticRig.shadow.group, ...(realisticRig.lights ?? []));
      realisticRig = rig;
      scene.environment = rig.envMap;
      scene.background = rig.background;
      scene.backgroundBlurriness = rig.backgroundBlurriness;
      scene.backgroundIntensity = rig.backgroundIntensity ?? 1;
      scene.backgroundRotation.set(0, rig.rotationY ?? 0, 0);
      scene.environmentRotation.set(0, rig.rotationY ?? 0, 0);
      scene.add(rig.ground, rig.shadow.group, ...(rig.lights ?? []));
      for (const l of Object.values(liveLights)) l.visible = false;
      grid.visible = false;
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = rig.exposure;
      if (reground) placeGround({ force: !live });
      if (live) applyPixelRatio("realistic");
      // setSubMaterials above already re-applied every sub-part, but it ran
      // BEFORE realisticRig was reassigned, so it read the OLD style (still
      // CAD, or the previous environment) — refresh now that currentStyle()
      // answers correctly.
      refreshFeatureLines();
    } catch (e) {
      try { enterCad({ live }); } catch (rollback) { console.warn("partforge: rolling back to CAD failed", rollback); }
      throw e;
    }
  }
  // Every step is attempted even if an earlier one throws (the first error is
  // rethrown at the end): this is the rollback path too, and a half-restored
  // CAD view is exactly what it exists to prevent. Tone mapping goes first.
  function enterCad({ live = true } = {}) {
    let firstError = null;
    const attempt = (fn) => { try { fn(); } catch (e) { firstError ??= e; } };
    attempt(() => {
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
    });
    renderMode = "cad";
    attempt(() => {
      if (realisticRig) scene.remove(realisticRig.ground, realisticRig.shadow.group, ...(realisticRig.lights ?? []));
    });
    realisticRig = null;
    shadowMovedAt = null;
    attempt(() => {
      scene.environment = null;
      scene.background = new THREE.Color(THEME[currentTheme].bg);
      scene.backgroundBlurriness = 0;
      scene.backgroundIntensity = 1;
      scene.backgroundRotation.set(0, 0, 0);
      scene.environmentRotation.set(0, 0, 0);
    });
    attempt(() => { for (const l of Object.values(liveLights)) l.visible = true; });
    attempt(() => { grid.visible = true; });
    for (const n of names) attempt(() => { if (baseMats[n] !== cadMats[n]) rebaseSubMaterial(n, cadMats[n]); else applySubOpacity(n); });
    if (live) attempt(() => applyPixelRatio("cad"));
    attempt(refreshFeatureLines);
    if (firstError) throw firstError;
  }

  const isStale = (token) => disposed || token !== modeToken;

  // Compile every built sub-part's physical program against the rig before the
  // look is swapped in, so the swap does not stall on shader compilation.
  // Three keys a program on tone mapping and output colour space, and both
  // differ with a render target bound, so the canvas variant compiles under
  // the realistic tone mapping and a capture's variant with a render
  // target bound — each only for the synchronous compile() inside
  // compileAsync, so the view on screen is untouched while it waits.
  function compileRealistic(rig, { forCapture = false } = {}) {
    const proxy = new THREE.Scene();
    proxy.environment = rig.envMap;
    for (const n of names) {
      const m = physicalFor(n);
      const geo = subCache[n];
      if (!geo) continue; // not built yet: it compiles when it is first shown
      if (m.userData.pfAnisotropic) ensureBoxUVs(geo);
      proxy.add(new THREE.Mesh(geo, m));
    }
    const toneMappingBefore = renderer.toneMapping;
    // Any bound target gives the capture's key (NoToneMapping, linear output);
    // an 8-bit one is always renderable.
    const probe = forCapture ? new THREE.WebGLRenderTarget(1, 1) : null;
    if (probe) renderer.setRenderTarget(probe);
    else renderer.toneMapping = THREE.NeutralToneMapping;
    let compiling;
    try { compiling = renderer.compileAsync?.(proxy, activeCamera); } finally {
      renderer.toneMapping = toneMappingBefore;
      if (probe) renderer.setRenderTarget(null);
    }
    return Promise.resolve(compiling).finally(() => probe?.dispose());
  }

  // Resolves to the mode actually in effect. A later setRenderMode or
  // setEnvironment supersedes this one; a superseded completion changes
  // nothing (its rig and materials are cached, so there is nothing to undo).
  async function setRenderMode(next) {
    if (disposed) return renderMode;
    const want = next === "realistic" ? "realistic" : "cad";
    const token = ++modeToken;
    if (want === "cad") {
      realisticPending = false;
      if (renderMode !== "cad") {
        try { enterCad(); } catch (e) { console.warn("partforge: leaving the realistic view failed", e); }
      }
      publishMode();
      return renderMode;
    }
    const envId = environmentId;
    if (renderMode === "realistic" && realisticRig?.id === envId) {
      realisticPending = false;
      publishMode();
      return renderMode;
    }
    const wasRealistic = renderMode === "realistic";
    realisticPending = true;
    publishMode({ busy: true });
    try {
      const rig = await rigFor(envId);
      if (isStale(token)) return renderMode;
      await compileRealistic(rig);
      if (isStale(token)) return renderMode;
      // The ground's and materials' maps: without this the floor pops in a
      // frame or two after the switch, untextured first.
      await whenTexturesSettled();
      if (isStale(token)) return renderMode;
      enterRealistic(rig);
      realisticPending = false;
      publishMode();
    } catch (e) {
      if (isStale(token)) return renderMode;
      realisticPending = false;
      console.warn("partforge: the realistic view failed to load", e);
      // Still realistic means the previous rig is still what's on screen: the
      // environment the switch asked for never landed, so the id (and anyone
      // showing it) goes back to the one actually lit.
      if (renderMode === "realistic" && realisticRig && realisticRig.id !== environmentId) {
        announceEnvironment(realisticRig.id);
      }
      publishMode({ error: wasRealistic && renderMode === "realistic" ? "couldn't load that environment" : "couldn't load realistic view" });
    }
    return renderMode;
  }

  function announceEnvironment(id) {
    environmentId = id;
    for (const cb of [...envListeners]) {
      try { cb(id); } catch (e) { console.warn("partforge: environment listener failed", e); }
    }
  }

  // The id is recorded (and announced) at once; in realistic mode — or on the
  // way into it — the new rig then loads and replaces the current one. If that
  // load fails while realistic, setRenderMode reverts the id to the rig still
  // shown and announces that too; in CAD nothing loads, so the id just stands.
  async function setEnvironment(id) {
    const next = resolveEnvironmentId(id).id;
    environmentChosen = true;
    if (next !== environmentId) announceEnvironment(next);
    if (renderMode === "realistic" || realisticPending) await setRenderMode("realistic");
    return environmentId;
  }

  // Per-sub-part print frames (display → export) for the layer-line pattern.
  function setPrintFrames(frames) {
    printFrames = frames ?? {};
    const identity = new THREE.Matrix4().toArray();
    for (const [n, m] of physicalMats) m.userData.patternUniforms?.pfPrintFrame.value.fromArray(printFrames[n] ?? identity);
  }

  // Resolves once the current environment's rig is loaded (captures wait on it).
  const whenRealisticReady = () => rigFor(environmentId).then(() => {});

  function disposeRealistic() {
    modeToken++;
    modeListeners.clear();
    envListeners.clear();
    linesListeners.clear();
    for (const p of rigCache.values()) p.then((r) => r.dispose(), () => {});
    rigCache.clear();
    loadedRigs.clear();
    thumbnailRigRefs.clear();
    for (const m of physicalMats.values()) m.dispose();
    physicalMats.clear();
    for (const t of textureCache.values()) t.dispose();
    textureCache.clear();
    pendingTextures.clear();
    pmrem?.dispose();
    pmrem = null;
  }

  // --- animation hooks --------------------------------------------------------
  // Frame listeners get dt (seconds, clamped so a background-tab return doesn't
  // fast-forward playback) inside the render loop — so a parked viewer
  // (setActive(false)) automatically halts playback too: no loop, no ticks.
  const frameListeners = new Set();
  function onFrame(cb) { frameListeners.add(cb); return () => frameListeners.delete(cb); }

  // Fired at the end of every showAssembly, for hosts that need to react to
  // which sub-parts are visible (e.g. re-deriving a view style thumbnail).
  const assemblyListeners = new Set();

  const camTween = createCameraTween();

  // OrbitControls' damping is a rotational RESIDUAL, not a per-frame effect: it
  // keeps applying a decaying fraction of the last drag's accumulated
  // sphericalDelta on every update(), for seconds after the pointer went up.
  // That is invisible DURING a cue tween — the tween writes position after
  // controls.update() every frame, so whatever the residual did that frame is
  // overwritten — but the residual is still unspent when the tween ends, and
  // controls.update() then keeps walking the camera off the exact angle it just
  // landed on. Measured on the demo part: a `top` click straight after a flick
  // settled 3.8° off axis, where the same click from rest settled on it.
  //
  // Suspending damping is what drains it: with the flag off, update() applies
  // the whole remaining sphericalDelta once and then zeroes it (same for
  // panOffset), and that frame's position and target are overwritten by the
  // tween anyway, so the drain never reaches the screen. The previous value is
  // restored when the tween finishes OR is cancelled, so a user grab mid-tween —
  // which cancels through beginCameraGrab — damps exactly as it always did.
  let dampingBeforeTween = null;
  function suspendDamping() {
    if (dampingBeforeTween !== null) return; // already suspended; don't shadow the real value
    dampingBeforeTween = controls.enableDamping;
    controls.enableDamping = false;
  }
  function restoreDamping() {
    if (dampingBeforeTween === null) return;
    controls.enableDamping = dampingBeforeTween;
    dampingBeforeTween = null;
  }

  // Tween the orbit camera to a canonical angle, framed on what's visible now.
  // Presentational only; a caller passing duration 0 gets a jump cut.
  //
  // `refit` opts in to also restoring the FRAMING at the end of the tween, and
  // only matters under orthographic: the pose above already re-derives the
  // framing distance from the visible bounds, which is the whole job in
  // perspective, but under ortho apparent size comes from the frustum and
  // camera.zoom rather than from distance, so a tween alone leaves whatever
  // dolly the user had accumulated in place. Off by default, because "look from
  // this direction" and "refit the part" are different intentions: an animation
  // camera cue means only the former, and refitting mid-animation would resize
  // the part under the user. The view cube's clicks mean both — clicking a face
  // is the reframe button's job now — so they pass it.
  //
  // Applied ONCE, on completion, never per frame: re-deriving the frustum inside
  // the tween would re-zoom on every frame of a 0.6s cue (see setCameraState's
  // comment, which is where that reasoning is written down). Composed with the
  // caller's own onComplete rather than replacing it.
  function tweenCameraTo(viewName, { duration = 0.6, onComplete, refit = false } = {}) {
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) { onComplete?.(); return; }
    const center = box.getCenter(new THREE.Vector3()).toArray();
    const size = box.getSize(new THREE.Vector3());
    // radius = full max extent (not half), matching frameTo's framing distance so a
    // live camera cue doesn't land twice as close as the reframe button and crop the part.
    const pose = cameraPoseForView(viewName, { center, radius: Math.max(size.x, size.y, size.z) || 12 });
    // The projection is read at COMPLETION, not now: a 0.6s tween is long
    // enough for the user to have toggled projection under it.
    const finish = () => {
      restoreDamping();
      if (refit && projectionMode === "orthographic") {
        // The tween fires onComplete from inside its own update(), BEFORE the
        // render loop writes the final pose onto the camera — so the camera is
        // still a frame short of where it is going. Frame from the distance
        // this pose asked for rather than from wherever it has got to.
        syncOrthoToPerspectiveFraming({
          distance: new THREE.Vector3().fromArray(pose.position)
            .distanceTo(new THREE.Vector3().fromArray(pose.target)),
        });
      }
      onComplete?.();
    };
    suspendDamping();
    camTween.start(
      { position: activeCamera.position.toArray(), target: controls.target.toArray() },
      { position: pose.position, target: pose.target },
      { duration, onComplete: finish },
    );
  }
  // Cancelling has to put damping back: the tween's own completion path is the
  // only other place that does, and it never runs for a cancelled tween.
  const cancelCameraTween = () => { camTween.cancel(); restoreDamping(); };

  // User grabbing the orbit cancels any cue tween (the user owns the camera) and
  // tells subscribers (the animation driver disarms remaining cues).
  const cameraStartListeners = new Set();
  // What every real camera grab owes its subscribers: an in-flight cue tween is
  // cancelled, and the animation driver hears about it so remaining cues disarm.
  // OrbitControls' "start" event gives the canvas this for free; an external drag
  // source (the view cube) has to say so explicitly — so both routes call here
  // rather than each keeping its own copy of the contract. A hoisted function
  // declaration, not a `const` arrow: it runs after `cameraStartListeners` and
  // `camTween` above are initialized, but nothing requires it be declared after
  // them textually.
  function beginCameraGrab() {
    cancelCameraTween();
    for (const cb of [...cameraStartListeners]) cb();
  }
  // beginCameraGrab takes no parameters, so the "start" event object
  // OrbitControls passes in is simply ignored — safe to wire up directly.
  const onControlsStart = beginCameraGrab;
  controls.addEventListener("start", onControlsStart);
  function onCameraStart(cb) { cameraStartListeners.add(cb); return () => cameraStartListeners.delete(cb); }

  // Orbit from a pixel delta — the view cube's drag. Routed through the viewer
  // rather than done in the widget so it gets the same beginCameraGrab contract
  // that grabbing the canvas gets for free from OrbitControls' "start" event.
  function orbitBy(dx, dy) {
    beginCameraGrab();
    const next = orbitPose(
      {
        position: activeCamera.position.toArray(),
        target: controls.target.toArray(),
        up: activeCamera.up.toArray(),
      },
      { dx, dy },
      // Match OrbitControls' own feel: a drag spanning the full viewport height
      // is a full turn, so the cube and the canvas rotate at the same rate.
      { radiansPerPx: (2 * Math.PI) / Math.max(1, container.clientHeight || 1) },
    );
    activeCamera.position.fromArray(next.position);
    controls.update();
  }

  // --- projection (perspective <-> orthographic) ------------------------------
  function applyOrthoFrustum({ halfW, halfH }) {
    orthoCamera.left = -halfW;
    orthoCamera.right = halfW;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
    orthoCamera.updateProjectionMatrix();
  }

  // Re-derive the ortho frustum from the perspective camera's fov at the
  // camera's CURRENT distance from the orbit target. Called on every swap into
  // ortho and after any reframe, which is what keeps the two projections
  // showing the same amount of part.
  //
  // `distance` overrides "current": tweenCameraTo's refit runs from the tween's
  // completion callback, which fires one frame BEFORE the final pose reaches the
  // camera, so it frames from the distance it asked for rather than from where
  // the camera happens to be at that instant.
  function syncOrthoToPerspectiveFraming({ distance: atDistance } = {}) {
    const distance = atDistance || activeCamera.position.distanceTo(controls.target) || 1;
    applyOrthoFrustum(orthoFrustum({
      fovDeg: camera.fov,
      distance,
      aspect: camera.aspect || 1,
    }));
    // The frustum now expresses the whole framing, so any dolly-by-zoom the user
    // had accumulated is already spent — leaving it would double-count.
    orthoCamera.zoom = 1;
    orthoCamera.updateProjectionMatrix();
  }

  // Swap which camera is live. Everything downstream reads viewer.camera fresh
  // at call time, so the only wiring that has to move is OrbitControls' own
  // object and the cutaway's captured reference.
  function setProjection(mode) {
    const next = mode === "orthographic" ? "orthographic" : "perspective";
    if (next === projectionMode) return projectionMode;
    const from = activeCamera;
    const to = next === "orthographic" ? orthoCamera : camera;
    to.position.copy(from.position);
    to.up.copy(from.up);
    to.quaternion.copy(from.quaternion);
    if (next === "orthographic") {
      syncOrthoToPerspectiveFraming();
    } else {
      // Recover whatever dolly the user did while in ortho: OrbitControls
      // changes camera.zoom there rather than moving the camera, so the zoom
      // has to come back as a distance or the part jumps size.
      //
      // The bound exists because ortho zoom is UNBOUNDED and zooming a long way
      // out costs nothing there (an ortho projection has no depth falloff) —
      // while the recovered distance goes as 1/zoom, so a zoom near nothing would
      // fling the perspective camera an absurd distance out and leave the part a
      // speck, with no cue as to why. The far plane is the yardstick because it
      // is by definition past everything worth looking at; read off `from`,
      // which is the camera that is still live and therefore the one
      // updateDepthRange has been keeping current. `far * 0.9` alone would be
      // too eager: frameTo frames at 2.6r + 6 MILLIMETRES, so an everyday 300mm
      // part sits at 786mm and a plain toggle would silently reframe it closer.
      // Hence the max with the distance the camera is already at, which makes an
      // untouched round trip (zoom === 1, where orthoFrustum/perspectiveDistance
      // are exact inverses) lossless for a part of ANY size, and still never lets
      // a degenerate zoom move the camera further out than it already was.
      // `|| 1` on the zoom for the same reason captureCurrent guards it: a zero
      // would make this non-finite.
      const halfH = (orthoCamera.top - orthoCamera.bottom) / 2 || 1;
      const offset = from.position.clone().sub(controls.target);
      const distance = Math.min(
        perspectiveDistance({ halfH, zoom: orthoCamera.zoom || 1, fovDeg: camera.fov }),
        Math.max(from.far * 0.9, offset.length()),
      );
      camera.position.copy(controls.target).addScaledVector(offset.normalize(), distance);
    }
    to.updateProjectionMatrix();
    activeCamera = to;
    controls.object = to;
    controls.update();
    // The incoming camera's depth range is whatever it was left with when it
    // was last live, and the two projections do not take the same near plane.
    // Everything below reads a projection matrix, so re-derive it here rather
    // than waiting for the next frame.
    updateDepthRange();
    // The projection matrix is not the world matrix, and `to` has never been
    // rendered — nothing has composed its matrixWorld, which WebGLRenderer would
    // not fix up until the NEXT frame. Two readers get there first: the listener
    // fan-out below is synchronous, and cutaway.updateForCamera runs before
    // render(). Both end up in matrixWorld (raycaster.setFromCamera takes the
    // ray's origin AND direction from it).
    //
    // controls.update() ends in Object3D.lookAt, which does refresh matrixWorld
    // — but it refreshes BEFORE writing the new quaternion, so a rotation
    // applied inside that same update (damping momentum still decaying as the
    // toggle lands) leaves the rotation one frame behind. One matrix compose is
    // cheaper than depending on that ordering. Placed after controls.update()
    // for the same reason: it is the last writer of the pose.
    to.updateMatrixWorld();
    cutaway.setCamera(to);
    projectionMode = next;
    for (const cb of [...projectionListeners]) cb(projectionMode);
    return projectionMode;
  }

  function onProjectionChange(cb) {
    projectionListeners.add(cb);
    return () => projectionListeners.delete(cb);
  }

  // Fallback creasing for payloads with no kernel normals. Both backends now
  // ship authoritative normals (Manifold: policy-aware crease pass; OCCT:
  // analytic B-rep normals), so this path is last-ditch only — it must not be
  // "improved" in lieu of fixing a backend that stopped sending normals.
  const CREASE_ANGLE = Math.PI / 6; // 30°

  // --- geometry builder -----------------------------------------------------
  // BufferGeometry from a worker mesh payload — kept in its shared-frame coords
  // (NOT recentred) so the pieces assemble in the right relative positions.
  function buildGeometry({ positions, normals, indices, triangles, edges, featureIds, features }) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (indices?.length) geo.setIndex(new THREE.BufferAttribute(indices, 1)); // Manifold is non-indexed
    const triCount = triangles ?? (indices ? indices.length : positions.length / 3) / 3;
    let out;
    if (normals?.length) {
      // kernel-computed normals (both backends) — smooth within a surface, hard at cut seams
      geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      geo.computeBoundingBox();
      out = geo;
    } else {
      // fallback (payload with no kernel normals — no current backend does this): crease from the triangle soup
      out = toCreasedNormals(geo, CREASE_ANGLE);
      out.computeBoundingBox();
    }
    out.userData.triangles = triCount;
    if (featureIds) { out.userData.featureIds = featureIds; out.userData.features = features; }
    // feature edge lines: kernel-supplied segments are authoritative — an EMPTY
    // array means "this solid has no feature edges" (e.g. a lone sphere), so
    // draw none rather than falling back. Only a payload with NO edge data at
    // all (edges === undefined; no current backend does this) derives by angle.
    const lg = new LineSegmentsGeometry();
    if (edges) lg.setPositions(edges); // edges is already a well-formed (possibly zero-length) Float32Array
    else lg.fromEdgesGeometry(new THREE.EdgesGeometry(out, EDGE_ANGLE));
    out.userData.edges = lg;
    return out;
  }

  // --- sub-part geometry cache ----------------------------------------------
  const subCache = Object.fromEntries(names.map((n) => [n, null]));

  function setSubGeometry(name, payload) {
    setSubPose(name, null); // fresh worker mesh is baked at current params — clear any fast-path pose
    const prev = subCache[name];
    const next = buildGeometry(payload);
    // Brushed metal needs UVs for its tangent frame; CAD meshes carry none.
    if (renderMode === "realistic" && physicalMats.get(name)?.userData.pfAnisotropic) ensureBoxUVs(next);
    subCache[name] = next;
    syncGrain(name);
    // Section helpers must stop referring to the old buffers before those
    // buffers are released.
    cutaway.updateGeometry(name, next);
    if (prev) { prev.userData.edges?.dispose(); prev.dispose(); }
  }

  // Presentational rigid pose for one sub-part (the pose fast path): applied to
  // the mesh and its edge lines. `null` clears. Column-major mat16 (pose.js /
  // three.js Matrix4 convention). Never affects exports or geometry — the worker
  // owns real placement; this only re-poses the delivered mesh.
  function setSubPose(name, mat16) {
    for (const obj of [subMesh[name], subLines[name]]) {
      if (!obj) continue;
      obj.matrixAutoUpdate = false;
      if (mat16) obj.matrix.fromArray(mat16);
      else obj.matrix.identity();
      obj.matrixWorldNeedsUpdate = true;
    }
    // The contact shadow follows on the render loop's throttle (see
    // updateMovingShadow); the ground itself stays put until showAssembly.
    if (realisticRig) shadowMovedAt = performance.now();
  }

  // Cache queries for the app's regenerate loop (so it never reaches into subCache).
  const hasSubMesh = (name) => !!subCache[name];
  const subTriangles = (name) => subCache[name]?.userData.triangles ?? 0;

  // --- show / hide assembly -------------------------------------------------
  const _box = new THREE.Box3();
  const _posedBox = new THREE.Box3();

  // Recentre the assembly on the pivot and frame the camera to the named parts.
  // Cached bounding boxes are in the delivered mesh's own frame, so any fast-path
  // pose has to be applied before the union or framing ignores the re-posing.
  function frameTo(visibleNames) {
    _box.makeEmpty();
    for (const name of visibleNames) {
      if (!subCache[name]) continue;
      _posedBox.copy(subCache[name].boundingBox).applyMatrix4(subMesh[name].matrix);
      _box.union(_posedBox);
    }
    if (_box.isEmpty()) return;
    const center = _box.getCenter(new THREE.Vector3());
    partsGroup.position.copy(center).multiplyScalar(-1); // centre assembly on the pivot
    const size = _box.getSize(new THREE.Vector3());
    // Drop the grid to the bottom of the bounding box (model Z -> world Y), so it reads
    // as a floor the part sits on rather than a plane through its middle.
    floorY = -size.z / 2;
    grid.position.y = floorY;
    const r = Math.max(size.x, size.y, size.z) || 12;
    activeCamera.position.setLength(r * 2.6 + 6);
    controls.target.set(0, 0, 0);
    // Framing under ortho is a frustum, not a distance — without this the
    // reframe button moves the camera and nothing visibly changes.
    if (projectionMode === "orthographic") syncOrthoToPerspectiveFraming();
  }

  // Show exactly the named sub-parts (from the cache). When `frame` is set, also
  // frame the camera to them — done only on the initial show and on view (tab)
  // changes, NOT on regeneration, so a user's zoom/orbit survives editing params.
  function showAssembly(visibleNames, { frame = false } = {}) {
    lastShown = [...visibleNames];
    for (const name of names) {
      if (visibleNames.includes(name)) {
        subMesh[name].geometry = subCache[name]; // cached geometries reused, not disposed
        subLines[name].geometry = subCache[name].userData.edges;
        applySubOpacity(name); // shown, but an active 0-override keeps it hidden
      } else {
        subMesh[name].visible = false;
        subLines[name].visible = false;
      }
    }
    if (frame) frameTo(visibleNames);
    cutaway.setVisible(effectiveVisible());
    placeGround(); // realistic only: the ground comes to the part, and the shadow re-renders
    for (const cb of [...assemblyListeners]) {
      try { cb(); } catch (e) { console.warn("partforge: assembly listener failed", e); }
    }
  }

  // Re-frame whatever is currently visible (the reframe button).
  function frame() {
    frameTo(names.filter((n) => subMesh[n].visible && subCache[n]));
  }

  // Call after anything that rewrites sub-part materials out from under us.
  // The cutaway assigns mesh.material itself — the clipped clone on enable, the
  // captured original on disable, and a freshly re-cloned pair on every
  // refreshSourceMaterial (which setTheme drives) — so a live fade has to be
  // re-asserted on top or a PAUSED mid-fade part sticks at full opacity. A
  // playing animation would self-heal on its next frame; a paused one has no
  // next frame. Only the calls that reassign materials need this: flip and
  // reset move the plane and nothing else.
  function reassertLiveFades() {
    for (const n of animOpacity.keys()) applySubOpacity(n);
  }

  function setCutawayEnabled(on) {
    const result = cutaway.setEnabled(on);
    reassertLiveFades();
    return result;
  }

  // Restoring a snapshot enables the mode, so it reassigns sub-part materials
  // exactly the way setCutawayEnabled above does — and therefore has to
  // re-assert live fades for the same reason a paused mid-fade part would
  // otherwise stick at full opacity.
  function setCutawayState(state) {
    const result = cutaway.setState(state);
    reassertLiveFades();
    return result;
  }

  // Swap the scene background, grid, and edge-line colors for the given theme.
  function setTheme(mode) {
    const t = THEME[mode] ?? THEME.dark;
    // Realistic mode's backdrop belongs to the environment and its grid is off;
    // enterCad puts the theme's background back on the way out.
    if (renderMode === "cad") scene.background = new THREE.Color(t.bg);
    scene.remove(grid);
    grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVS, t.grid[0], t.grid[1]);
    grid.position.y = floorY; // keep the floor at the bbox bottom across theme swaps
    grid.visible = renderMode === "cad";
    scene.add(grid);
    lineMaterial.color.set(t.line);
    for (const m of fadeLineMats.values()) m.color.set(t.line); // clones follow the theme
    cutaway.setTheme(mode, t.line);
    reassertLiveFades(); // setTheme re-clones every section's materials and reassigns them
    currentTheme = THEME[mode] ? mode : "dark";
    for (const cb of [...themeListeners]) cb(currentTheme);
  }

  function hideAssembly() {
    lastShown = [];
    for (const m of Object.values(subMesh)) m.visible = false;
    for (const l of Object.values(subLines)) l.visible = false;
    cutaway.setVisible([]);
  }

  // --- resize ---------------------------------------------------------------
  // Size from the host container (not the window) so embedders control the pane.
  function resize() {
    // Parked (see setActive): the buffer is deliberately 1x1 and must stay that
    // way. iOS fires resizes constantly as the URL bar collapses, and every one
    // of them would otherwise re-allocate a full MSAA buffer for a hidden pane.
    if (!active) return;
    const w = container.clientWidth || 300, h = container.clientHeight || 150;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Hold the ortho camera's VERTICAL extent across a resize and let the width
    // follow the aspect — the same thing the perspective camera does, so a
    // window drag never rescales the part under either projection.
    const halfH = (orthoCamera.top - orthoCamera.bottom) / 2 || 1;
    applyOrthoFrustum({ halfH, halfW: halfH * (w / h) });
    lineMaterial.resolution.set(w, h); // fat lines need the viewport size for px width
    for (const m of fadeLineMats.values()) m.resolution.set(w, h); // clones need it too
    cutaway.setViewportSize(w, h, renderer.getPixelRatio());
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // --- offscreen canonical-view capture -------------------------------------
  // Offscreen render of the shared scene from an arbitrary pose → JPEG data URL.
  // A separate WebGLRenderTarget + temp camera means the visible canvas and the
  // live `camera` are never touched. WebGL pixels are bottom-up, so flip on encode.
  //
  // These captures are read by a model, not shown as a thumbnail (partforge-cloud's
  // render_part_views tool feeds them straight to the agent), so they are sized and lit
  // for reading small features: 1024² is the largest square that fits Anthropic's
  // ~1.15 MP no-downscale budget, 4× MSAA keeps a thin wall from aliasing into noise,
  // and the light rig follows the camera so no view is a flat silhouette.
  const _rtSize = 1024;
  let _rt = null;
  let _capLights = null;
  // Defaults reproduce the canonical-view capture exactly (1024² cached target,
  // fov 45, quality 0.9). A custom size (captureCurrent) gets a fresh render
  // target, disposed after the read — those captures are rare, so per-call
  // allocation beats caching one target per size ever requested.
  //
  // stencilBuffer is NOT optional: cutaway masks its section caps with the
  // stencil buffer, and a WebGLRenderTarget defaults to not having one (the
  // visible canvas does, via the `stencil: true` renderer above). Without it
  // the mask silently no-ops and every cap floods its whole plane with hatch —
  // no error, live view unaffected, wrong only in the capture.
  const RT_OPTIONS = { samples: 4, stencilBuffer: true };
  // Decided once per viewer, on the first realistic capture (see
  // halfFloatCaptureSupported). Two 1×1 probes, because a capture needs two
  // things of half-float: RENDERING into the exact target a capture uses (4×
  // MSAA with a stencil — a GPU can support single-sampled half-float and
  // still refuse a multisampled one, which would come back as a black capture),
  // and READING BACK, which three does from the resolved single-sampled
  // framebuffer, so the read format is asked of a plain half-float target.
  let _hdrReadback = null;
  function hdrCaptureReadback() {
    if (_hdrReadback !== null) return _hdrReadback;
    const readable = renderer.capabilities?.textureTypeReadable?.(THREE.HalfFloatType) === true;
    let readType = null, halfFloat = null;
    const gl = renderer.getContext?.();
    if (readable && typeof gl?.getParameter === "function") {
      halfFloat = gl.HALF_FLOAT;
      const complete = () => gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const renderProbe = new THREE.WebGLRenderTarget(1, 1, { ...RT_OPTIONS, type: THREE.HalfFloatType });
      const readProbe = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
      try {
        renderer.setRenderTarget(renderProbe);
        const renderable = complete();
        renderer.setRenderTarget(readProbe);
        readType = renderable && complete() && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA
          ? gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE)
          : -1;
      } catch {
        readType = -1;
      } finally {
        renderer.setRenderTarget(null);
        renderProbe.dispose();
        readProbe.dispose();
      }
    }
    _hdrReadback = halfFloatCaptureSupported({ readable, readType, halfFloat });
    if (!_hdrReadback) {
      console.warn("partforge: this device can't read back HDR renders; realistic captures are tone-mapped from 8-bit (highlights clip)");
    }
    return _hdrReadback;
  }
  //
  // `viewOffset` ({ fullWidth, fullHeight, x, y }) renders the width×height
  // output as that sub-window of a larger virtual frame — the recentred
  // showcase capture (captureCurrentFromScene). The camera's aspect is then the
  // VIRTUAL frame's, so the projection is exactly the un-offset one and the
  // output is a pixel-exact crop of what the user framed.
  function renderOffscreen(pose,
                           { width = _rtSize, height = _rtSize, fov = 45, quality = 0.9,
                             projection = "perspective", orthoHalfH = 1, viewOffset, sceneBounds } = {},
                           renderScene = scene) {
    // A realistic LIVE scene renders HDR into a half-float target and is tone
    // mapped here (three tone-maps only the canvas path). It is lit by its
    // environment alone, so the CAD capture lights stay out of it. A throwaway
    // scene (renderMeshPayloads' thumbnails) is CAD whatever the live mode.
    // Without HDR readback it falls back to the 8-bit target and tone-maps the
    // clipped linear bytes: highlights clip, but it is still the realistic look.
    const realistic = renderScene === scene && renderMode === "realistic";
    const hdr = realistic && hdrCaptureReadback();
    const cachedSize = !hdr && width === _rtSize && height === _rtSize;
    const rt = cachedSize
      ? (_rt = _rt ?? new THREE.WebGLRenderTarget(_rtSize, _rtSize, RT_OPTIONS))
      : new THREE.WebGLRenderTarget(width, height, hdr ? { ...RT_OPTIONS, type: THREE.HalfFloatType } : RT_OPTIONS);
    _capLights = _capLights ?? createCaptureLights();
    // Canonical captures never pass `projection`, so agent-facing renders and
    // the CLI stay perspective no matter what the user is looking at. Built
    // through the same helper the recentring math projects through, so the two
    // can never disagree about where a vertex lands.
    const aspect = viewOffset ? viewOffset.fullWidth / viewOffset.fullHeight : width / height;
    // `sceneBounds` encloses what this render will draw; without it the camera
    // keeps the fixed historical planes, which is right for a caller with
    // nothing to measure and wrong for a part 300 mm across.
    const cam = makeCaptureCamera(pose, {
      aspect, fov, projection, orthoHalfH, ...captureDepthRange(pose, { sceneBounds, projection }),
    });
    if (viewOffset) cam.setViewOffset(viewOffset.fullWidth, viewOffset.fullHeight, viewOffset.x, viewOffset.y, width, height);
    const { position, up, target } = pose;
    const buf = hdr ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
    // Swap the world-fixed key/fill for the camera-relative pair, for this one render
    // only. A DirectionalLight aims at its `target`, whose matrixWorld only updates
    // while it is in the scene graph, so both go in and both come back out.
    const { key: capKey, fill: capFill } = _capLights;
    // Restored to what they WERE, not to true: realistic mode keeps them off.
    const keyWas = liveLights.key.visible, fillWas = liveLights.fill.visible;
    if (!realistic) {
      const poses = captureLightPoses({ position, up, target });
      capKey.position.set(poses.key[0], poses.key[1], poses.key[2]);
      capFill.position.set(poses.fill[0], poses.fill[1], poses.fill[2]);
      for (const light of [capKey, capFill]) light.target.position.set(target[0], target[1], target[2]);
      liveLights.key.visible = false;
      liveLights.fill.visible = false;
      scene.add(capKey, capKey.target, capFill, capFill.target);
    }
    // A pick marker is transient UI feedback about a click, never part of the
    // part, so it belongs in no capture. It used to be near enough true that a
    // capture would miss one — a dot faded after 1200ms — but a HELD dot lives
    // as long as the host's UI hangs off it, so any capture taken during a pick
    // would now bake the yellow sphere into an agent-facing render or a
    // published thumbnail. Hidden HERE, at the one offscreen chokepoint, rather
    // than via canonicalCaptureHidden: captureCurrent deliberately ignores that
    // set. Only dots that were actually shown are restored, so this cannot
    // resurrect one the live canvas had hidden for its own reasons.
    // The pointer's hover highlight (selection/feature-highlight.js) is the
    // same kind of transient feedback, and it TINTS the surface under it: a
    // capture taken with the pointer resting on a part baked a translucent
    // blue wash over it (an orange PLA sample came out pink).
    const reshowFlashDots = [];
    for (const dot of [...flashDots, ...captureHidden]) if (dot.visible) { dot.visible = false; reshowFlashDots.push(dot); }
    try {
      renderer.setRenderTarget(rt);
      renderer.render(renderScene, cam);
      // render() resolves the multisample renderbuffer into the target texture, so this
      // reads antialiased pixels.
      renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
    } finally {
      // Never leave the user's own view unlit, pointed at the offscreen target,
      // or missing a marker the user is still looking at.
      renderer.setRenderTarget(null);
      if (!realistic) {
        scene.remove(capKey, capKey.target, capFill, capFill.target);
        liveLights.key.visible = keyWas;
        liveLights.fill.visible = fillWas;
      }
      for (const dot of reshowFlashDots) dot.visible = true;
      if (!cachedSize) rt.dispose();
    }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);
    // Linear pixels → sRGB bytes: tone-mapped for a realistic capture, only
    // transfer-encoded for CAD (which renders LDR with no tone mapping).
    const encoded = realistic ? neutralToneMapToSrgb8(readbackToLinear(buf), renderer.toneMappingExposure) : srgbEncodeInPlace(buf);
    // flip rows (GL origin is bottom-left)
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width * 4;
      img.data.set(encoded.subarray(src, src + width * 4), y * width * 4);
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/jpeg", quality);
  }

  // Pointer feedback excluded from EVERY offscreen render (renderOffscreen),
  // showcase captures included — unlike canonicalCaptureHidden below.
  const captureHidden = new Set();
  function registerCaptureHidden(obj) {
    captureHidden.add(obj);
    return () => captureHidden.delete(obj);
  }

  // Objects excluded from CANONICAL captures only (agent renders must stay
  // dimension-free); captureCurrent — the user-framed showcase capture —
  // deliberately does NOT consult this set.
  const canonicalCaptureHidden = new Set();
  function registerCanonicalCaptureHidden(obj) {
    canonicalCaptureHidden.add(obj);
    return () => canonicalCaptureHidden.delete(obj);
  }

  // Render the canonical camera angles offscreen, framed to whatever is visible,
  // without disturbing the user's live view. Returns [{ view, dataUrl }].
  //
  // Always the CAD look, whatever the live view shows: these are the agent's
  // renders, and the editor's on-screen mode must never change what the agent
  // sees. A realistic live view lends its scene to CAD for the synchronous
  // capture and gets it back exactly (captureIn). renderViews is the one way
  // to ask for realistic canonical views. Feature lines are pinned ON, ignoring
  // the user's per-style switch — an agent-facing CAD drawing always has them.
  function captureCanonicalViews(viewNames) {
    if (disposed) return [];
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) return []; // nothing to draw: don't swap the look for it
    return withFeatureLines(true, () => captureIn("cad", null, () => canonicalViewsInCurrentLook(viewNames)));
  }
  // The canonical views in whatever look the scene has right now — the body
  // both captureCanonicalViews and renderViews wrap in captureIn.
  function canonicalViewsInCurrentLook(viewNames) {
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) return [];
    const center = box.getCenter(new THREE.Vector3()).toArray();
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) / 2 || 10;
    return captureViewsFromScene(viewNames, {
      renderer: { renderOffscreen },
      // The live camera only to save/restore its position around the pass; the
      // renders themselves pass no `projection`, so they stay perspective.
      liveCamera: activeCamera,
      grid,
      hidden: [...canonicalCaptureHidden],
      bounds: { center, radius },
      // The ENCLOSING radius, which is a different number from the framing one
      // above: a box's corners reach √3 further than half its max extent, and
      // the depth planes have to clear the corners. A realistic capture keeps
      // its ground disc, which is several part radii across, so it counts too.
      sceneBounds: (realisticRig && sceneDepthBounds()) || { center, radius: size.length() / 2 || 10 },
    });
  }

  // One offscreen render of the user's CURRENT framing (live camera pose +
  // orbit target, live aspect) at a caller-chosen resolution — the showcase
  // capture. Returns a JPEG data URL, or null when disposed / nothing visible.
  //
  // `renderMode` picks the look. Omitted, it follows the live view (a gallery
  // "Capture from viewer" captures what the user sees). "cad" borrows CAD for
  // the synchronous capture if the live view is realistic. "realistic" from a
  // CAD view borrows the realistic look only if the current environment's
  // assets have ALREADY loaded — this call is synchronous and cannot wait for
  // them — and otherwise falls back to the live look; renderViews is the async
  // path that guarantees realistic.
  function captureCurrent(opts) {
    if (disposed) return null;
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) return null;
    const { renderMode: want, ...rest } = opts ?? {};
    const capture = () => currentFramingInCurrentLook(rest);
    if (want === "cad") return captureIn("cad", null, capture);
    if (want === "realistic" && renderMode !== "realistic") {
      const rig = loadedRigs.get(environmentId);
      if (rig) return captureIn("realistic", rig, capture);
    }
    return capture();
  }
  function currentFramingInCurrentLook(opts) {
    return captureCurrentFromScene(opts, {
      renderer: { renderOffscreen },
      liveCamera: activeCamera,
      target: controls.target.toArray(),
      grid,
      maxTextureSize: renderer.capabilities?.maxTextureSize,
      // For `recenter`: the geometry that is actually in the picture. Sub-part
      // meshes only — dimension labels and section caps are overlays on them.
      meshes: Object.values(subMesh).filter((m) => m.visible),
      // For the depth planes. `hideGrid` is the capture's own default-on option,
      // so ask whether the grid will still be there when the render happens.
      sceneBounds: sceneDepthBounds({ withGrid: grid.visible && opts?.hideGrid === false }),
      projection: projectionMode,
      // Divided by zoom, because OrbitControls dollies an ortho camera with
      // `zoom` and leaves the frustum alone: the raw frustum is the un-dollied
      // framing, so a capture built from it would ignore the user's zoom.
      orthoHalfH: (orthoCamera.top - orthoCamera.bottom) / 2 / (orthoCamera.zoom || 1),
    });
  }

  // Run one synchronous capture in the `want` look, leaving the live view
  // exactly as it was — even if the capture throws. The swap and the restore
  // sit in one synchronous block, so the canvas never paints a borrowed frame,
  // and nothing is published: the live mode never changed. A parked viewer
  // still captures (offscreen work), so its shadow is rendered on demand.
  function captureIn(want, rig, capture) {
    if (want === renderMode) {
      if (want === "realistic" && !active) renderShadow(undefined, { force: true });
      return capture();
    }
    if (want === "realistic") {
      enterRealistic(rig, { live: false }); // rolls itself back to CAD if it throws
      try { return capture(); } finally { enterCad({ live: false }); }
    }
    const liveRig = realisticRig, movedAt = shadowMovedAt;
    try {
      enterCad({ live: false });
      return capture();
    } finally {
      try {
        enterRealistic(liveRig, { live: false, reground: false });
        shadowMovedAt = movedAt;
      } catch (e) {
        // enterRealistic already rolled the scene back to CAD: make it the live mode.
        console.warn("partforge: restoring the realistic view after a capture failed", e);
        try { applyPixelRatio("cad"); } catch { /* the view is CAD either way */ }
        publishMode({ error: "couldn't load realistic view" });
      }
    }
  }

  // One small render of the CURRENT framing in any style, for the view style
  // popover. The live view is put back exactly (same contract as captureIn:
  // no publish, nothing persisted), whether it is CAD, or realistic in this
  // or another environment. The borrowed style brings its own feature-lines
  // preference with it, because linesOn() reads the current style.
  async function renderStyleThumbnail(style, { size = 256 } = {}) {
    if (disposed) return null;
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) return null;
    const capture = () => currentFramingInCurrentLook({ size, quality: 0.8 });
    if (style === "cad") return captureIn("cad", null, capture);
    const id = resolveEnvironmentId(style).id;
    // Grab the exact promise rigFor is caching for `id`, and register with it
    // BEFORE awaiting: a second concurrent call for the same id must see this
    // one already counted, or two overlapping releases could both drop the
    // count to 0 and race each other to dispose.
    const p = rigFor(id);
    thumbnailRigRefs.set(id, (thumbnailRigRefs.get(id) ?? 0) + 1);
    try {
      const rig = await p;
      if (disposed) return null;
      await compileRealistic(rig, { forCapture: true });
      if (disposed) return null;
      await whenTexturesSettled();
      if (disposed) return null;
      if (renderMode !== "realistic" || realisticRig === rig) return captureIn("realistic", rig, capture);
      // Realistic in another environment: borrow this rig, then put the live one back.
      const liveRig = realisticRig, movedAt = shadowMovedAt;
      try {
        enterRealistic(rig, { live: false });
        return capture();
      } finally {
        try {
          enterRealistic(liveRig, { live: false, reground: false });
          shadowMovedAt = movedAt;
        } catch (e) {
          // enterRealistic already rolled the scene back to CAD: make it the live mode.
          console.warn("partforge: restoring the realistic view after a thumbnail failed", e);
          try { applyPixelRatio("cad"); } catch { /* the view is CAD either way */ }
          publishMode({ error: "couldn't load realistic view" });
        }
      }
    } finally {
      releaseThumbnailRig(id, p);
    }
  }

  // Agent-facing canonical renders in a chosen appearance, whatever the live
  // view shows. CAD is exactly captureCanonicalViews (which is always CAD).
  // Realistic waits for the current environment's rig and the capture's
  // shader programs, then borrows the realistic look for the synchronous
  // capture only if the live view is not already realistic. A rig that fails
  // to load rejects rather than silently returning CAD images. Feature lines
  // are pinned OFF here too, ignoring the user's switch — an agent-facing
  // realistic render is always the photograph, never the annotated drawing.
  async function renderViews(viewNames, { renderMode: want = "cad" } = {}) {
    if (disposed) return [];
    if (want !== "realistic") return captureCanonicalViews(viewNames);
    const rig = await rigFor(environmentId);
    if (disposed) return [];
    await compileRealistic(rig, { forCapture: true });
    if (disposed) return [];
    await whenTexturesSettled();
    if (disposed) return [];
    return withFeatureLines(false, () => captureIn("realistic", rig, () => canonicalViewsInCurrentLook(viewNames)));
  }

  // Offscreen render of an arbitrary mesh set (a non-active view), for thumbnails.
  // Assembles a THROWAWAY scene mirroring the live pivot convention, frames it from a
  // canonical angle, renders through the parameterized renderOffscreen, and disposes
  // everything. Never touches the live scene, camera, subMesh, or subCache. The scene
  // gets THUMBNAIL_BG unless `background` says otherwise (`null` = no background, the
  // renderer's clear colour). `payloads` is the worker's [{name, positions, normals,
  // indices, …}] array — placement is already baked into shared-frame coords, so
  // meshes are NOT recentred.
  function renderMeshPayloads(payloads, { angle = "iso", size = 640, quality = 0.8, background } = {}) {
    if (disposed) return null; // same guard as captureCurrent/captureCanonicalViews — never touch a torn-down renderer
    const tmpScene = new THREE.Scene();
    // Deliberately the throwaway scene's own background, never the live one's:
    // this must not follow the viewer theme (see THUMBNAIL_BG) and must not
    // reach the live-scene captures, which correctly do follow it.
    tmpScene.background = thumbnailBackground(background);
    const tmpPivot = new THREE.Group();
    tmpPivot.rotation.x = -Math.PI / 2; // model Z (CAD up) -> vertical, same as live pivot
    tmpScene.add(tmpPivot);

    const built = [];
    for (const payload of payloads) {
      const geo = buildGeometry(payload); // shared-frame coords, NOT recentred
      const mesh = new THREE.Mesh(geo, materialFor(payload.name));
      tmpPivot.add(mesh);
      built.push(mesh);
    }

    // Frame in WORLD space, AFTER the pivot rotation. The meshes are built in model
    // coords but rendered rotated by tmpPivot, so a model-space bbox centre would aim
    // the camera at the wrong point — an off-origin part would render off-centre or blank.
    tmpPivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(tmpPivot);
    const center = box.getCenter(new THREE.Vector3()).toArray();
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const pose = cameraPoseForView(angle, { center, radius });

    // Light the throwaway scene ourselves: renderOffscreen's own key/fill (and the
    // persistent hemisphere) live in the LIVE scene, which is never rendered here — so
    // without our own ambient + camera-relative key/fill it comes back near-black.
    const hemi = createHemisphereLight();
    const capLights = createCaptureLights();
    const poses = captureLightPoses(pose);
    capLights.key.position.set(poses.key[0], poses.key[1], poses.key[2]);
    capLights.fill.position.set(poses.fill[0], poses.fill[1], poses.fill[2]);
    for (const light of [capLights.key, capLights.fill]) {
      light.target.position.set(pose.target[0], pose.target[1], pose.target[2]);
    }
    tmpScene.add(hemi, capLights.key, capLights.key.target, capLights.fill, capLights.fill.target);

    // Feature-edge lines, so the thumbnail carries the same hole/seam/chamfer outlines the
    // live viewer shows. A dedicated LineMaterial at the render resolution (the live one is
    // sized to the on-screen canvas); added after framing so it can't perturb the bbox.
    const lineMat = new LineMaterial({ color: THEME.dark.line, linewidth: 1.0 });
    lineMat.resolution.set(size, size);
    for (const mesh of built) {
      const edges = mesh.geometry.userData.edges;
      if (edges) tmpPivot.add(new LineSegments2(edges, lineMat));
    }

    try {
      // fov comes from the PERSPECTIVE camera, deliberately, not from whichever
      // camera is live: thumbnails are canonical captures and stay perspective
      // however the user has the projection toggled. cameraPoseForView's distance
      // is tuned to this fov, so a narrower one would crop long, thin parts.
      return renderOffscreen(
        pose,
        // The throwaway scene holds these meshes and nothing else — no grid, no
        // gizmo — so its own bounds are the whole of what the planes must hold.
        { width: size, height: size, fov: camera.fov, quality, sceneBounds: { center, radius } },
        tmpScene,
      );
    } finally {
      for (const mesh of built) {
        mesh.geometry.userData.edges?.dispose();
        mesh.geometry.dispose();
        if (mesh.material !== material) mesh.material.dispose(); // clone only — never the shared singleton
      }
      lineMat.dispose();
      hemi.dispose?.();
      capLights.key.dispose?.();
      capLights.fill.dispose?.();
    }
  }

  // --- render loop ----------------------------------------------------------
  // The tween is applied after controls.update() so the cue wins the frame, and
  // the frame listeners run before render so a playback frame draws its own pose.
  let lastFrameTime = null;
  function renderFrame(time) {
    const dt = lastFrameTime == null ? 0 : Math.min(0.1, (time - lastFrameTime) / 1000);
    lastFrameTime = time;
    controls.update();
    const tw = camTween.update(dt);
    if (tw) {
      activeCamera.position.fromArray(tw.position);
      controls.target.fromArray(tw.target);
    }
    // Per-listener guard, because three re-arms requestAnimationFrame only AFTER
    // this callback returns (WebGLAnimation.onAnimationFrame): a listener that
    // throws would stop the rAF chain outright and freeze the viewer for good, not
    // just skip a frame. Containment belongs here rather than in every subscriber.
    for (const cb of [...frameListeners]) {
      try { cb(dt); } catch (e) { console.warn("partforge: frame listener failed", e); }
    }
    updateMovingShadow(); // after the listeners, so it sees this frame's poses
    // After the frame listeners, before anything reads the camera to draw with:
    // a playback frame may have moved sub-parts or the camera itself, and both
    // change where the planes belong.
    updateDepthRange();
    if (cutaway.isEnabled) cutaway.updateForCamera();
    // Re-size the pick markers against the pose this frame will actually draw:
    // a dot is only alive for about a second, but orbiting or zooming inside
    // that second must not resize it.
    for (const dot of flashDots) scaleFlashDot(dot);
    // …and re-project the held one, so a host anchored to it follows the
    // camera. Change-gated: a still camera publishes nothing.
    if (anchorDot) {
      const next = projectPoint([anchorDot.position.x, anchorDot.position.y, anchorDot.position.z]);
      if (anchorMoved(lastAnchor, next)) publishAnchor(next);
    }
    renderer.render(scene, activeCamera);
    cutaway.renderOverlay(renderer, activeCamera);
  }
  renderer.setAnimationLoop(renderFrame);

  // --- active / parked ------------------------------------------------------
  // For a host that HIDES the viewer without unmounting it. partforge's own
  // narrow layout uses `display: none` on the stage, which zeroes clientWidth
  // and lets the ResizeObserver above collapse the buffer for free. An embedder
  // that cannot do that — partforge-cloud's phone tab bar uses
  // `visibility: hidden`, because the canvas has to keep its size for build
  // screenshots — gets no such signal: the full-resolution MSAA drawing buffer
  // stays resident and this loop keeps rendering the scene at 60fps behind an
  // invisible pane. On an iPhone that is tens of megabytes and
  // continuous GPU work nobody can see, so the host has to say so explicitly.
  //
  // Parking stops the loop and releases the drawing buffer. `setSize(1, 1,
  // false)` leaves the canvas element's CSS box alone, so the host's layout
  // does not move and the pane can be revealed again without a reflow.
  function setActive(next) {
    const want = next !== false;
    if (disposed || want === active) return;
    active = want;
    if (!active) {
      renderer.setAnimationLoop(null);
      renderer.setSize(1, 1, false);
      // The cached 1024² 4x-MSAA + stencil capture target is the other large
      // allocation here — on a phone it is comparable to the canvas itself, so
      // parking that kept it would leave half the memory behind. Dropping it
      // costs one re-allocation on the next capture, which a parked viewer
      // barely notices: the cache only ever hits on an exactly-square request,
      // and a phone's capture aspect is not square, so those captures were
      // allocating per call regardless.
      _rt?.dispose();
      _rt = null;
      return;
    }
    resize(); // rebuild the buffer at whatever size the container is now
    // A parked viewer renders no contact shadow (placeGround skips it), so a
    // regen while hidden left it stale.
    placeGround();
    lastFrameTime = null; // parked time is not elapsed time — no dt jump on unpark
    renderer.setAnimationLoop(renderFrame);
  }

  // --- context loss ---------------------------------------------------------
  // Losing the WebGL context is how a memory-starved phone tells you it gave
  // up. With no handler the canvas just freezes, indistinguishable from a hang,
  // and three never re-initialises. preventDefault() is what makes the loss
  // recoverable (three's own listener re-uploads on restore); the subscribers
  // let an embedder surface it instead of showing a dead rectangle.
  const contextLostListeners = new Set();
  const onContextLostEvent = (event) => {
    event.preventDefault();
    for (const listener of [...contextLostListeners]) listener();
  };
  renderer.domElement.addEventListener("webglcontextlost", onContextLostEvent);
  function onContextLost(listener) {
    contextLostListeners.add(listener);
    return () => contextLostListeners.delete(listener);
  }

  // --- camera state (read/write for persistence; mount.js owns storage) -------
  function getCameraState() {
    return {
      pos: [activeCamera.position.x, activeCamera.position.y, activeCamera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
    };
  }
  function setCameraState({ pos, target }) {
    activeCamera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
    // A saved pose carries an implied FRAMING, so the ortho frustum has to be
    // re-derived from the restored distance. Without it, a reload in ortho comes
    // back at the wrong zoom: the projection is restored during mount setup,
    // while the camera is restored much later (showView, on the first accepted
    // build), so the frustum would stay sized for wherever the camera happened
    // to start. Done here rather than at the mount's call site so every caller
    // is fixed, including a host that restores a pose itself.
    //
    // Deliberately NOT done DURING a tweenCameraTo: an animation camera cue
    // means "look from this direction", not "reframe". Under ortho the camera's
    // distance has no effect on apparent size anyway, so re-deriving there would
    // silently re-zoom the part — and mid-tween, on every frame of one. A caller
    // that really does mean "refit" opts in with `{ refit: true }`, which runs
    // this same sync exactly once, on the tween's completion; the view cube's
    // clicks are the only callers that do.
    if (projectionMode === "orthographic") syncOrthoToPerspectiveFraming();
  }
  function onCameraEnd(cb) { controls.addEventListener("end", cb); }

  // Transient marker at a world-space point — visual confirmation of a pick.
  //
  // Two things keep it visible where it used to disappear. It is ordered above
  // every band the cutaway raises its surfaces, edges and outlines into (a
  // section view moves them past 1,000,000, so the old fixed 999 was painted
  // over by the very geometry the marker sat on — and `depthTest: false` means
  // no depth is written either, so nothing behind it survives the overdraw).
  // And it is `transparent`, which puts it in the pass three draws LAST: a
  // translucent part puts the cutaway's caps in the transparent list, where an
  // opaque marker is already behind whatever its render order.
  //
  // The sphere is a UNIT sphere scaled per frame (see below) so it reads as a
  // constant handful of CSS pixels instead of a fixed millimetre size.
  const _flashWorld = new THREE.Vector3();
  const FLASH_RENDER_ORDER = CUTAWAY_OVERLAY_RENDER_ORDER + 1;
  const flashTimers = new Set();
  const flashDots = new Set();
  // The subset that will not fade. A HELD marker outlives the pick that made
  // it, because the host has hung something off it — see holdFlashPoint.
  const heldDots = new Set();
  let lastFlashed = null;   // the newest marker, which is what hold() holds
  let anchorDot = null;     // the held marker the anchor stream follows
  let lastAnchor = null;
  const anchorListeners = new Set();
  const flashGeometry = new THREE.SphereGeometry(1, 16, 12);
  const flashViewport = new THREE.Vector2();

  function scaleFlashDot(dot) {
    renderer.getSize(flashViewport); // CSS px, which is what a pixel radius means
    dot.scale.setScalar(flashWorldRadius(activeCamera, dot.position, flashViewport.y));
  }

  function projectPoint(world) {
    renderer.getSize(flashViewport);
    _flashWorld.set(world[0], world[1], world[2]);
    return projectToScreen(activeCamera, _flashWorld, flashViewport.x, flashViewport.y);
  }

  function publishAnchor(anchor) {
    lastAnchor = anchor;
    // A throwing subscriber must not stop the render loop or the other
    // subscribers — same containment the frame listeners get.
    for (const cb of [...anchorListeners]) {
      try { cb(anchor); } catch (e) { console.warn("partforge: anchor listener failed", e); }
    }
  }

  function dropFlashDot(dot) {
    scene.remove(dot);
    dot.material.dispose(); // the geometry is shared and freed in dispose()
    flashDots.delete(dot);
    heldDots.delete(dot);
    if (lastFlashed === dot) lastFlashed = null;
  }

  function flashPoint(world) {
    const dot = new THREE.Mesh(
      flashGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffcc33, depthTest: false, depthWrite: false, transparent: true,
      })
    );
    dot.renderOrder = FLASH_RENDER_ORDER;
    dot.position.set(world[0], world[1], world[2]);
    scaleFlashDot(dot); // sized before its first frame, not one frame late
    scene.add(dot);
    flashDots.add(dot);
    lastFlashed = dot;
    const t = setTimeout(() => {
      flashTimers.delete(t);
      dot.userData.fadeTimer = null;
      dropFlashDot(dot);
    }, 1200);
    dot.userData.fadeTimer = t;
    flashTimers.add(t);
  }

  // Keep the newest marker on screen until released. Earlier held markers stay
  // held: picking a second spot should light both, and one release() clears
  // them together. The anchor stream follows the newest, which is the one a
  // host's own UI is anchored to.
  function holdFlashPoint() {
    if (!lastFlashed) return false;
    const dot = lastFlashed;
    if (dot.userData.fadeTimer) {
      clearTimeout(dot.userData.fadeTimer);
      flashTimers.delete(dot.userData.fadeTimer);
      dot.userData.fadeTimer = null;
    }
    heldDots.add(dot);
    anchorDot = dot;
    publishAnchor(projectPoint([dot.position.x, dot.position.y, dot.position.z]));
    return true;
  }

  function releaseFlashPoints() {
    if (heldDots.size === 0 && !anchorDot) return;
    for (const dot of [...heldDots]) dropFlashDot(dot);
    anchorDot = null;
    publishAnchor(null);
  }

  function onFlashAnchorChange(cb) {
    // The `disposed` half is the same guard cutaway's onHandleHoverChange takes,
    // and for the same two reasons: a subscribe racing teardown (effect-cleanup
    // ordering, a StrictMode remount) would otherwise be handed an anchor for a
    // dot no longer in the scene, and would re-populate a listener set that
    // dispose() will never clear again — retaining the embedder's closure.
    if (disposed || typeof cb !== "function") return () => {};
    anchorListeners.add(cb);
    cb(lastAnchor); // current state on subscribe, like onCutawayHandleHover
    return () => anchorListeners.delete(cb);
  }

  // Full teardown: render loop, observers, controls, timers, GPU resources, DOM.
  // Idempotent. Cached sub-part geometries and their edge lines are freed; the
  // shared and per-part cloned materials tolerate double-dispose.
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    ro.disconnect();
    renderer.setAnimationLoop(null);
    // Embedder callbacks must not outlive teardown — a disposed viewer has no
    // context left to lose, and a surviving listener would keep the embedder's
    // closure (and whatever it captured) alive.
    renderer.domElement.removeEventListener("webglcontextlost", onContextLostEvent);
    contextLostListeners.clear();
    controls.removeEventListener("start", onControlsStart);
    cameraStartListeners.clear();
    frameListeners.clear();
    assemblyListeners.clear();
    themeListeners.clear();
    projectionListeners.clear();
    canonicalCaptureHidden.clear();
    camTween.cancel();
    controls.dispose();
    for (const t of flashTimers) clearTimeout(t);
    flashTimers.clear();
    // A dot whose timer was just cancelled — or one held indefinitely — still
    // holds its own material; the sphere geometry is shared and freed once.
    for (const dot of flashDots) { scene.remove(dot); dot.material.dispose(); }
    flashDots.clear();
    heldDots.clear();
    lastFlashed = null;
    anchorDot = null;
    lastAnchor = null;
    anchorListeners.clear();
    flashGeometry.dispose();
    cutaway.dispose();
    for (const n of names) {
      const g = subCache[n];
      if (g) { g.userData.edges?.dispose(); g.dispose(); subCache[n] = null; }
      // cadMats[n], not subMesh[n].material: an active fade override has swapped
      // the mesh onto a clone, and the base material would otherwise leak. Not
      // baseMats[n] either — in realistic mode that is a physical material,
      // freed with the rest of them in disposeRealistic below.
      cadMats[n]?.dispose();
      subMesh[n].geometry?.dispose(); // the initial empty BufferGeometry, if never replaced
    }
    // Hand the fade clones back before freeing them. cutaway.dispose() above has
    // already restored their original clippingPlanes and emptied its registry,
    // so these unregister closures find no entry and return without touching a
    // disposed cutaway. They still earn their place: they release this map's
    // hold on the registry's unregister closures rather than leaving it to GC.
    for (const off of fadeUnregisters.values()) off();
    fadeUnregisters.clear();
    for (const m of fadeMats.values()) m.dispose();
    for (const m of fadeLineMats.values()) m.dispose();
    fadeMats.clear();
    fadeLineMats.clear();
    disposeRealistic();
    material.dispose();
    lineMaterial.dispose();
    grid.geometry.dispose();
    grid.material.dispose();
    _rt?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    showAssembly,
    hideAssembly,
    setSubGeometry,
    setSubPose,
    setSubPartOpacity,
    clearSubPartOpacities,
    hasSubMesh,
    subTriangles,
    frame,
    captureCanonicalViews,
    captureCurrent,
    renderMeshPayloads,
    renderViews,
    renderStyleThumbnail,
    onFrame,
    onAssemblyChange: (cb) => { assemblyListeners.add(cb); return () => assemblyListeners.delete(cb); },
    tweenCameraTo,
    cancelCameraTween,
    orbitBy,
    onCameraStart,
    setActive,
    onContextLost,
    setTheme,
    onThemeChange,
    getTheme: () => currentTheme,
    getCameraState,
    setCameraState,
    onCameraEnd,
    // A GETTER, not a value: the active camera changes when the projection is
    // toggled, and every consumer (measure/dim3-scene.js, selection/raycast.js,
    // annotate/annotate-mode.js, measure/measure-mode.js) reads viewer.camera
    // fresh at call time — so this is transparent to all of them.
    get camera() { return activeCamera; },
    setProjection,
    getProjection: () => projectionMode,
    onProjectionChange,
    domElement: renderer.domElement,
    _subMeshes: subMesh,
    __subMesh: (n) => subMesh[n],   // test hooks (cf. attachAnimationControls' __viewer)
    __subLines: (n) => subLines[n],
    flashPoint,
    projectPoint,
    holdFlashPoint,
    releaseFlashPoints,
    onFlashAnchorChange,
    cutawaySupported: () => cutaway.isSupported,
    cutawayEnabled: () => cutaway.isEnabled,
    setCutawayEnabled,
    // Carry the slice across a remount — see cutaway.js's getState/setState.
    getCutawayState: cutaway.getState,
    setCutawayState,
    flipCutaway: cutaway.flip,
    resetCutaway: cutaway.reset,
    isWorldPointVisible: cutaway.isPointVisible,
    getCutawayPlane: cutaway.getPlane,
    registerCutawayMaterial: cutaway.registerClippableMaterial,
    registerCanonicalCaptureHidden,
    registerCaptureHidden,
    onCutawayHandleHover: cutaway.onHandleHoverChange,
    setRenderMode,
    getRenderMode: () => renderMode,
    onRenderModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    // Feature lines, for the CURRENT style (setFeatureLines) or the whole
    // per-style map (setFeatureLinesPrefs, e.g. a carried viewerState).
    setFeatureLines,
    getFeatureLines: () => linesOn(),
    getFeatureLinesPrefs: () => ({ ...featureLinesPrefs }),
    setFeatureLinesPrefs,
    onFeatureLinesChange: (cb) => { linesListeners.add(cb); return () => linesListeners.delete(cb); },
    setEnvironment,
    getEnvironment: () => environmentId,
    // Whether the environment was named through setEnvironment (by the user or
    // a host) rather than seeded from the part's meta.environment / the
    // default — so a carried viewer state only pins an environment someone chose.
    isEnvironmentChosen: () => environmentChosen,
    // A realistic request is loading (getRenderMode still reads the mode on
    // screen until it lands); false once it lands, fails, or is superseded.
    isRealisticPending: () => realisticPending,
    onEnvironmentChange: (cb) => { envListeners.add(cb); return () => envListeners.delete(cb); },
    setPrintFrames,
    whenRealisticReady,
    dispose,
  };
}

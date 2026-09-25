// src/framework/materials/contact-shadow.js
// A contact shadow for realistic mode (after three's webgl_shadow_contact
// example): render the casters' depth from BELOW into a target, blur it, and
// lay it on the ground. Rendered on demand — on geometry change, and at low
// resolution while an animation moves a sub-part — never every frame.
//
// Two layers, like a real shadow: a TIGHT one (high resolution, a millimetre
// or so of blur, a steep height falloff) that follows the part's own outline
// where it meets the ground, over a faint SOFT one (low resolution, a blur
// that scales with the part) that stands in for the ambient darkening around
// it. The tight layer alone reads as a cut-out; the soft one alone as a blob.
import * as THREE from "three";
import { HorizontalBlurShader } from "three/addons/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/addons/shaders/VerticalBlurShader.js";

const LAYERS = [
  // blurMm: a fixed reach in millimetres; blurFrac: a reach as a fraction of
  // the shadow plane (so it grows with the part). falloff: the power the
  // height fade is raised to — higher is denser at contact, thinner above.
  { name: "soft", resolution: 256, darkness: 0.22, blurFrac: 0.035, falloff: 1.5 },
  { name: "tight", resolution: 1024, darkness: 0.42, blurMm: 1.2, falloff: 2.5 },
];

function depthMaterialFor(darkness, falloff) {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      `gl_FragColor = vec4( vec3( 0.0 ), pow( 1.0 - fragCoordZ, ${falloff.toFixed(2)} ) * ${darkness.toFixed(3)} );`,
    );
  };
  m.customProgramCacheKey = () => `pf-contact-${darkness}-${falloff}`;
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

export function createContactShadow({ renderer, sizeMm = 400 }) {
  const group = new THREE.Group();
  const planeGeo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);

  const layers = LAYERS.map((spec, i) => {
    const rt = new THREE.WebGLRenderTarget(spec.resolution, spec.resolution);
    rt.texture.generateMipmaps = false;
    const rtBlur = new THREE.WebGLRenderTarget(spec.resolution, spec.resolution);
    rtBlur.texture.generateMipmaps = false;
    // polygonOffset: the ground sits a hair below this plane and writes
    // depth; at a normal viewing distance that hair is inside the depth
    // buffer's precision, so without the offset the shadow z-fights it.
    const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({
      map: rt.texture, opacity: 1, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 - i,
    }));
    plane.renderOrder = 1 + i; // tight over soft
    group.add(plane);
    return { spec, rt, rtBlur, plane, depthMaterial: depthMaterialFor(spec.darkness, spec.falloff) };
  });

  const blurPlane = new THREE.Mesh(planeGeo);
  blurPlane.visible = false;
  group.add(blurPlane);

  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  cam.rotation.x = Math.PI / 2;
  group.add(cam);

  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); hBlur.depthTest = false;
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader); vBlur.depthTest = false;

  // The meshes are scaled; the camera is SIZED. three leaves scale out of a
  // camera's view matrix, so a camera sized by a scaled parent would see a
  // 1 mm square (it did: the shadow was empty in every environment).
  let planeSize = sizeMm;
  function setSize(size, height = size) {
    planeSize = size;
    for (const l of layers) l.plane.scale.set(size, -1, size); // y = -1: rendered from below
    blurPlane.scale.set(size, 1, size);
    cam.left = -size / 2; cam.right = size / 2;
    cam.top = size / 2; cam.bottom = -size / 2;
    cam.far = height;
    cam.updateProjectionMatrix();
  }
  setSize(sizeMm);

  // The blur plane sits in the shadow group, i.e. in the user's scene, so it
  // is hidden again even if a blur render throws. three's blur shaders reach
  // four taps either side, `h` apart in UV: a reach of `mm` millimetres on a
  // plane `planeSize` across is h = mm / planeSize / 4.
  function blurPass(layer, mm) {
    const step = mm / planeSize / 4;
    blurPlane.visible = true;
    try {
      blurPlane.material = hBlur; hBlur.uniforms.tDiffuse.value = layer.rt.texture; hBlur.uniforms.h.value = step;
      renderer.setRenderTarget(layer.rtBlur); renderer.render(blurPlane, cam);
      blurPlane.material = vBlur; vBlur.uniforms.tDiffuse.value = layer.rtBlur.texture; vBlur.uniforms.v.value = step;
      renderer.setRenderTarget(layer.rt); renderer.render(blurPlane, cam);
    } finally {
      blurPlane.visible = false;
    }
  }

  // `casters` are the visible sub-part meshes; everything else in `scene` is
  // hidden for the depth pass so only the part casts. Every mutation here —
  // to the scene and to the renderer's own state — is captured up front and
  // restored in `finally`, so a throw mid-render (context loss, a shader
  // compile failure) never leaves the user's scene with hidden objects, the
  // depth override material pinned, no background, or the wrong render
  // target bound.
  //
  // While a part moves (lowRes) only the soft layer is redrawn and the tight
  // one is hidden: an outline left where the part WAS would be wrong, and the
  // settle render that follows brings it back.
  //
  // `clippingPlanes` (world space) clip the casters the way the cutaway clips
  // what is on screen. The depth pass draws every caster with the one override
  // material, which carries none of the casters' own clipping planes, so
  // without this the half the cutaway removed still cast its shadow.
  function render(scene, casters, { lowRes = false, clippingPlanes = null } = {}) {
    const bg = scene.background;
    const overrideBefore = scene.overrideMaterial;
    const clear = renderer.getClearAlpha();
    const prevRT = renderer.getRenderTarget();
    const hidden = [];
    scene.traverseVisible((o) => { if (o.isMesh || o.isLine || o.isLineSegments || o.isSprite) if (!casters.includes(o)) { o.visible = false; hidden.push(o); } });
    for (const l of layers) l.plane.visible = false;
    try {
      scene.background = null;
      renderer.setClearAlpha(0);
      for (const l of layers) {
        if (lowRes && l.spec.name === "tight") continue;
        setClipping(l.depthMaterial, clippingPlanes);
        scene.overrideMaterial = l.depthMaterial;
        renderer.setRenderTarget(l.rt);
        renderer.render(scene, cam);
        scene.overrideMaterial = overrideBefore;
        const reach = l.spec.blurMm ?? l.spec.blurFrac * planeSize;
        blurPass(l, reach);
        if (!lowRes) blurPass(l, reach * 0.5);
      }
    } finally {
      scene.overrideMaterial = overrideBefore;
      renderer.setRenderTarget(prevRT);
      renderer.setClearAlpha(clear);
      for (const o of hidden) o.visible = true;
      // After the restore above: the planes are in the scene too, so they were
      // among `hidden`, and restoring them first would undo this.
      for (const l of layers) l.plane.visible = !(lowRes && l.spec.name === "tight");
      scene.background = bg;
    }
  }

  // A new plane count needs a new program; the same planes moved do not (three
  // reads their values every frame).
  function setClipping(material, planes) {
    const next = planes?.length ? planes : null;
    if ((material.clippingPlanes?.length ?? 0) !== (next?.length ?? 0)) material.needsUpdate = true;
    material.clippingPlanes = next;
  }

  return {
    group,
    render,
    setSize,
    dispose() {
      for (const l of layers) { l.rt.dispose(); l.rtBlur.dispose(); l.plane.material.dispose(); l.depthMaterial.dispose(); }
      planeGeo.dispose(); hBlur.dispose(); vBlur.dispose();
    },
  };
}

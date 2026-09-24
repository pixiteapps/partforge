// src/framework/materials/contact-shadow.js
// A soft contact shadow for realistic mode (after three's webgl_shadow_contact
// example): render the casters' depth from BELOW into a small target, blur it,
// and lay it on the ground. Rendered on demand — on geometry change, and at low
// resolution while an animation moves a sub-part — never every frame.
import * as THREE from "three";
import { HorizontalBlurShader } from "three/addons/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/addons/shaders/VerticalBlurShader.js";

export function createContactShadow({ renderer, sizeMm = 400, resolution = 512, darkness = 1, blur = 6 }) {
  const group = new THREE.Group();
  const rt = new THREE.WebGLRenderTarget(resolution, resolution);
  rt.texture.generateMipmaps = false;
  const rtBlur = new THREE.WebGLRenderTarget(resolution, resolution);
  rtBlur.texture.generateMipmaps = false;

  const planeGeo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
  // polygonOffset: the ground disc sits a hair below this plane and writes
  // depth; at a normal viewing distance that hair is inside the depth
  // buffer's precision, so without the offset the shadow z-fights the ground.
  const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({
    map: rt.texture, opacity: 1, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  }));
  plane.renderOrder = 1;
  group.add(plane);
  const blurPlane = new THREE.Mesh(planeGeo);
  blurPlane.visible = false;
  group.add(blurPlane);

  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  cam.rotation.x = Math.PI / 2;
  group.add(cam);

  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.userData.darkness = { value: darkness };
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = depthMaterial.userData.darkness;
    shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );",
    )}`;
  };
  depthMaterial.depthTest = false;
  depthMaterial.depthWrite = false;

  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); hBlur.depthTest = false;
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader); vBlur.depthTest = false;

  // The meshes are scaled; the camera is SIZED. three leaves scale out of a
  // camera's view matrix, so a camera sized by a scaled parent would see a
  // 1 mm square (it did: the shadow was empty in every environment).
  function setSize(size, height = size) {
    plane.scale.set(size, -1, size); // y = -1: the texture is rendered from below
    blurPlane.scale.set(size, 1, size);
    cam.left = -size / 2; cam.right = size / 2;
    cam.top = size / 2; cam.bottom = -size / 2;
    cam.far = height;
    cam.updateProjectionMatrix();
  }
  setSize(sizeMm);

  // The blur plane sits in the shadow group, i.e. in the user's scene, so it
  // is hidden again even if a blur render throws.
  function blurPass(amount) {
    blurPlane.visible = true;
    try {
      blurPlane.material = hBlur; hBlur.uniforms.tDiffuse.value = rt.texture; hBlur.uniforms.h.value = amount / 256;
      renderer.setRenderTarget(rtBlur); renderer.render(blurPlane, cam);
      blurPlane.material = vBlur; vBlur.uniforms.tDiffuse.value = rtBlur.texture; vBlur.uniforms.v.value = amount / 256;
      renderer.setRenderTarget(rt); renderer.render(blurPlane, cam);
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
  function render(scene, casters, { lowRes = false } = {}) {
    const bg = scene.background;
    const overrideBefore = scene.overrideMaterial;
    const clear = renderer.getClearAlpha();
    const prevRT = renderer.getRenderTarget();
    const hidden = [];
    scene.traverseVisible((o) => { if (o.isMesh || o.isLine || o.isLineSegments || o.isSprite) if (!casters.includes(o)) { o.visible = false; hidden.push(o); } });
    plane.visible = false;
    try {
      scene.background = null;
      scene.overrideMaterial = depthMaterial;
      renderer.setClearAlpha(0);
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      scene.overrideMaterial = overrideBefore;
      blurPass(lowRes ? blur * 0.6 : blur);
      if (!lowRes) blurPass(blur * 0.4);
    } finally {
      scene.overrideMaterial = overrideBefore;
      renderer.setRenderTarget(prevRT);
      renderer.setClearAlpha(clear);
      plane.visible = true;
      for (const o of hidden) o.visible = true;
      scene.background = bg;
    }
  }

  return {
    group,
    render,
    setSize,
    dispose() { rt.dispose(); rtBlur.dispose(); planeGeo.dispose(); plane.material.dispose(); depthMaterial.dispose(); hBlur.dispose(); vBlur.dispose(); },
  };
}

// src/framework/materials/environment.js
// One environment "rig": PMREM-filtered lighting from a baked UltraHDR JPEG, a
// backdrop, a textured ground disc that fades into the backdrop at its rim, and a
// contact shadow. Loaded lazily the first time an environment is shown; the
// loaders are injected so this is testable without GL or network.
import * as THREE from "three";
import { ENVIRONMENTS } from "./environments.js";
import { resolveEnvironmentId } from "./resolve.js";
import { assetUrl } from "./assets.js";
import { createContactShadow } from "./contact-shadow.js";

const GROUND_RADIUS_FACTOR = 4; // ground disc radius, in part radii

function groundMaterial(tex, rough, tint) {
  const m = new THREE.MeshStandardMaterial({ color: tint, map: tex, roughnessMap: rough ?? null, roughness: 1, metalness: 0, transparent: true });
  // Radial fade to transparent at the rim so the disc melts into the backdrop.
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vPfDisc;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPfDisc = position.xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vPfDisc;")
      .replace("#include <dithering_fragment>", "#include <dithering_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(0.35, 0.5, length(vPfDisc));");
  };
  m.customProgramCacheKey = () => "pf-ground";
  return m;
}

export async function loadEnvironmentRig(renderer, requestedId, { loadHdr, loadTexture, pmrem }) {
  const { id } = resolveEnvironmentId(requestedId);
  const env = ENVIRONMENTS[id];
  let hdr = await loadHdr(assetUrl(env.hdr));
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  let envMap;
  try { envMap = pmrem.fromEquirectangular(hdr).texture; } catch (e) { hdr.dispose(); throw e; }

  let background, backgroundBlurriness = 0;
  if (env.backdrop === "gradient") {
    background = new THREE.Color(env.gradient[1]);
    // The equirect (~16 MB of half-float) was only needed for the PMREM
    // filter above; a gradient backdrop never draws it, so on a phone it
    // shouldn't sit in memory for the rig's life.
    hdr.dispose();
    hdr = null;
  } else {
    background = hdr;
    backgroundBlurriness = 0.6;
  }

  const tex = loadTexture(env.ground.texture);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const rough = env.ground.roughnessTexture ? loadTexture(env.ground.roughnessTexture) : null;
  if (rough) rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  const discGeo = new THREE.CircleGeometry(0.5, 96).rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(discGeo, groundMaterial(tex, rough, env.ground.tint));
  ground.renderOrder = -1;

  const shadow = createContactShadow({ renderer, sizeMm: env.ground.sizeMm });

  function setGround({ y, centerX = 0, centerZ = 0, radius }) {
    const r = Math.max(radius * GROUND_RADIUS_FACTOR, env.ground.sizeMm / 2);
    ground.position.set(centerX, y - 0.01, centerZ);
    ground.scale.setScalar(r * 2);
    // Keep the texture at real millimetres however large the disc is.
    const repeat = (r * 2) / (env.ground.tileMm ?? env.ground.sizeMm);
    tex.repeat.set(repeat, repeat);
    if (rough) rough.repeat.set(repeat, repeat);
    shadow.group.position.set(centerX, y, centerZ);
    shadow.setSize(Math.max(radius * 3, 20), Math.max(radius * 4, 20));
  }

  return {
    id,
    exposure: env.exposure,
    envMap,
    background,
    backgroundBlurriness,
    ground,
    shadow,
    setGround,
    dispose() {
      envMap.dispose(); hdr?.dispose(); tex.dispose(); rough?.dispose();
      discGeo.dispose(); ground.material.dispose(); shadow.dispose();
    },
  };
}

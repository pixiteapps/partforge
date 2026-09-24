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
import { createPrintBed } from "./print-bed.js";

const GROUND_RADIUS_FACTOR = 4; // ground disc radius, in part radii

// A ground normal map is OpenGL-format (+Y up, Poly Haven's "nor_gl"), which is
// what three's tangent-space normal maps expect: a positive normalScale.
const GROUND_NORMAL_SCALE = 1.5;

// ground.detail: {scale, strength} re-samples the colour map `scale` times
// finer and multiplies it in at `strength`, so a ground seen up close under a
// small part keeps crisp grain after the base map's texels have gone soft.
// `mean` is the map's average linear luminance, so the detail layer darkens
// and lightens about 1 rather than shifting the ground's overall tone.
function injectDetail(shader, { scale, strength, mean }) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <map_fragment>",
    `#include <map_fragment>
#ifdef USE_MAP
  {
    float pfDl = dot(texture2D(map, vMapUv * ${scale.toFixed(3)}).rgb, vec3(0.3333));
    diffuseColor.rgb *= mix(1.0, pfDl / ${mean.toFixed(3)}, ${strength.toFixed(3)});
  }
#endif`,
  );
}

function groundMaterial(tex, rough, normal, { tint, roughness = 1, normalScale = GROUND_NORMAL_SCALE, bed = false, detail }) {
  const m = new THREE.MeshStandardMaterial({
    color: tint, map: tex, roughnessMap: rough ?? null, roughness, metalness: 0, transparent: !bed,
    ...(normal ? { normalMap: normal, normalScale: new THREE.Vector2(normalScale, normalScale) } : {}),
  });
  if (bed) {
    // a build plate has a hard edge: no rim fade
    if (detail) {
      m.onBeforeCompile = (shader) => injectDetail(shader, detail);
      m.customProgramCacheKey = () => "pf-ground-bed-detail";
    }
    return m;
  }
  // Radial fade to transparent at the rim so the disc melts into the backdrop.
  m.onBeforeCompile = (shader) => {
    if (detail) injectDetail(shader, detail);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vPfDisc;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPfDisc = position.xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vPfDisc;")
      .replace("#include <dithering_fragment>", "#include <dithering_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(0.35, 0.5, length(vPfDisc));");
  };
  m.customProgramCacheKey = () => (detail ? "pf-ground-detail" : "pf-ground");
  return m;
}

export async function loadEnvironmentRig(renderer, requestedId, { loadHdr, loadTexture, pmrem, createCanvas }) {
  const { id } = resolveEnvironmentId(requestedId);
  const env = ENVIRONMENTS[id];
  const hdr = await loadHdr(assetUrl(env.hdr));
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  let envMap;
  try { envMap = pmrem.fromEquirectangular(hdr).texture; } catch (e) { hdr.dispose(); throw e; }

  // Every environment draws its own photo, blurred, as the backdrop — so the
  // equirect stays alive for the rig's life (freed in dispose()).
  const background = hdr;
  const backgroundBlurriness = env.blurriness ?? 0.6;
  const backgroundIntensity = env.backgroundIntensity ?? 1;

  const tex = loadTexture(env.ground.texture);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Roughness and normal maps are data, not colour: never sRGB-decoded.
  const dataMap = (file) => {
    if (!file) return null;
    const t = loadTexture(file);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  const rough = dataMap(env.ground.roughnessTexture);
  const normal = dataMap(env.ground.normalTexture);
  const shadow = createContactShadow({ renderer, sizeMm: env.ground.sizeMm });

  // env.ground.bed: a standard-size build plate instead of the fading disc.
  if (env.ground.bed) {
    const material = groundMaterial(tex, rough, normal, { ...env.ground, bed: true });
    const bed = createPrintBed({ pei: material, tileMm: env.ground.tileMm ?? env.ground.sizeMm, createCanvas });
    // An enclosure's LED bar: one hard overhead light, aimed at the bed's own
    // origin. The LIGHT itself is deliberately not a child of bed.object:
    // updateForCamera hides that whole group from below, and a hidden parent
    // stops three from rendering its children too — the light would go dark
    // exactly when the part needs it lit from underneath. It rides in
    // `lights` instead and is repositioned by hand wherever the bed moves.
    // The target CAN stay a child (matrixWorld updates regardless of
    // visibility), which is what lets it keep tracking the bed for free.
    let keyLight = null;
    if (env.keyLight) {
      keyLight = new THREE.DirectionalLight(0xffffff, env.keyLight.intensity);
      bed.object.add(keyLight.target);
    }
    return {
      id, exposure: env.exposure, envMap, background, backgroundBlurriness, backgroundIntensity,
      rotationY: ((env.rotationDeg ?? 0) * Math.PI) / 180,
      ground: bed.object,
      lights: keyLight ? [keyLight] : [],
      shadow,
      updateForCamera(camera) { bed.updateForCamera(camera); },
      setGround({ y, centerX = 0, centerZ = 0, radius, footprintMm = radius }) {
        bed.place({ y, centerX, centerZ, footprintMm });
        if (keyLight) {
          const p = bed.object.position; // the fixed offset off the bed's origin
          keyLight.position.set(p.x + env.keyLight.direction[0], p.y + env.keyLight.direction[1], p.z + env.keyLight.direction[2]);
        }
        shadow.group.position.set(centerX, y, centerZ);
        // The shadow plane never hangs past the plate's edge into thin air.
        const s = Math.min(Math.max(radius * 3, 20), bed.sizeMm);
        shadow.setSize(s, Math.max(radius * 4, 20));
      },
      dispose() {
        envMap.dispose(); hdr.dispose(); tex.dispose(); rough?.dispose(); normal?.dispose();
        material.dispose(); bed.dispose(); shadow.dispose(); keyLight?.dispose();
      },
    };
  }

  const discGeo = new THREE.CircleGeometry(0.5, 96).rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(discGeo, groundMaterial(tex, rough, normal, env.ground));
  ground.renderOrder = -1;

  function setGround({ y, centerX = 0, centerZ = 0, radius }) {
    const r = Math.max(radius * GROUND_RADIUS_FACTOR, env.ground.sizeMm / 2);
    ground.position.set(centerX, y - 0.01, centerZ);
    ground.scale.setScalar(r * 2);
    // Keep the texture at real millimetres however large the disc is.
    const repeat = (r * 2) / (env.ground.tileMm ?? env.ground.sizeMm);
    tex.repeat.set(repeat, repeat);
    if (rough) rough.repeat.set(repeat, repeat);
    if (normal) normal.repeat.set(repeat, repeat);
    shadow.group.position.set(centerX, y, centerZ);
    shadow.setSize(Math.max(radius * 3, 20), Math.max(radius * 4, 20));
  }

  return {
    id,
    exposure: env.exposure,
    envMap,
    background,
    backgroundBlurriness,
    backgroundIntensity,
    rotationY: ((env.rotationDeg ?? 0) * Math.PI) / 180,
    ground,
    lights: [],
    shadow,
    setGround,
    dispose() {
      envMap.dispose(); hdr.dispose(); tex.dispose(); rough?.dispose(); normal?.dispose();
      discGeo.dispose(); ground.material.dispose(); shadow.dispose();
    },
  };
}

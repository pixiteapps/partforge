# Cached Preview Mesh (GLB) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give partforge a deterministic preview-GLB writer (`partforge/gltf`), a way to show such a file in the live viewer before the kernel boots (`mount({ preview })`), a kernel-free viewer for it (`mountPreview`), a way to produce it from the view on screen (`runtime.exportPreview()`), and a public `resolveDefaultView` — shipped as 0.147.0.

**Architecture:** The writer is a worker-safe module (no three.js, no DOM) built on `@gltf-transform` + `meshoptimizer`: one node/mesh/primitive per sub-part under a single −90°-about-X root, materials from the viewer's own `cadAppearance`, then `weld() → quantize() → meshopt({ level: "medium" })`. The reader decodes with three's `GLTFLoader` + `MeshoptDecoder` and converts each glTF mesh back into the viewer's ordinary mesh payload in the part's Z-up model frame (the writer's root rotation undone), so the preview goes through `viewer.setSubGeometry` exactly like a worker delivery — the existing pivot, materials, framing, cutaway and capture code serve it unchanged, and the first live delivery replaces it in place. `mountPreview` builds a synthetic part from the GLB's own node names (and the `display` blocks the writer stored in node extras) and hands it to the same `createViewer`.

**Tech Stack:** Plain ES modules, three.js 0.184 (`three/addons`), `@gltf-transform/{core,extensions,functions}` ^4.4.0, `meshoptimizer` ^1.3.0, vitest 4 (node + happy-dom environments), TypeScript only for the shipped `types/*.d.ts`.

**Spec:** partforge-cloud `docs/superpowers/specs/2026-10-11-forge-mesh-cache-preview-design.md`, section 1 ("partforge changes"). The benchmark behind the encoding recipe is partforge-cloud `research_notes/Forge mesh caching and glb viewer/local_glb_benchmark.md`; the codebase facts (mesh payloads, canonical vs posed frames, the materials resolver) are in `codebase_load_path_and_mesh_data.md` beside it.

## Global Constraints

- Node 24 for every command: run `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH` in each shell before `npm`/`npx`/`node`.
- Version: **0.147.0**, bumped in `package.json` AND `package-lock.json` (both `version` fields) in this branch — AGENTS.md "Releasing": the merge publishes only if the version moved. No CHANGELOG file exists.
- `partforge/gltf` (`src/gltf.js`) must import nothing that needs a DOM, three.js, `Blob` or `FileReader`, so it runs in Node, a browser main thread and a Web Worker alike.
- Encoding recipe, fixed: one glTF node + mesh + primitive per sub-part, node/mesh/material named by the sub-part key; POSITION + NORMAL (+ indices when given); a single root node `partforge` with rotation −90° about X (quaternion `[-Math.SQRT1_2, 0, 0, Math.SQRT1_2]`); units stay millimetres; then `weld()`, `quantize()`, `meshopt({ encoder: MeshoptEncoder, level: "medium" })`. `extensionsRequired` and `extensionsUsed` are exactly `KHR_mesh_quantization` + `EXT_meshopt_compression`.
- `PREVIEW_ENCODER_VERSION = 1`. Any change to the bytes the encoder writes for the same input bumps it.
- Appearance comes from `cadAppearance(part.parts[name].display)` (`src/framework/materials/resolve.js`): absent display → `NO_MATERIAL_COLOR` `0x9fb4cc`, metalness `0.25`, roughness `0.55`; colours converted sRGB → linear for `baseColorFactor`; `opacity < 1` → `alphaMode: "BLEND"` with alpha = opacity.
- Not encoded in v1: feature edges, textures, patterns.
- Identical input → byte-identical output. The encoder never mutates its input arrays (the viewer's live buffers are passed straight in by `exportPreview`).
- The preview decoder is three's `GLTFLoader` with `MeshoptDecoder` from `three/addons/libs/meshopt_decoder.module.js` (three is already a dependency). A preview that fails to decode is logged once (`console.warn`, prefix `partforge: preview ignored —`) and never throws, never rejects `ready`.
- `mount()` draws the preview without waiting for the worker's `ready`; the first build that delivers the whole view replaces it in place and does not re-frame the camera.
- `mount.js` loads the encoder lazily (`await import("./gltf/encode-preview.js")` inside `exportPreview`) so the app bundle does not carry `@gltf-transform` unless a host exports.
- No part-authoring API changes: `docs/AUTHORING-PARTS.md` and the prompt corpus are not touched.
- Tests: `npx vitest run <file>`; the full gates are `npm test`, `npm run lint`, `npm run lint:dead`, `npm run typecheck`.
- Commits: conventional messages, each ending with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

- A split dispatch (two `meshes` replies for one view): after the first, the preview must stay active and the sub-parts still building keep showing their preview geometry, never a hole — test in Task 5 ("a partial live delivery keeps the preview…").
- A parameter edit while the preview shows: the rail stays live, the preview stays on screen (no `hideAssembly`), and the build dispatched at `ready` carries the edited value — test in Task 5 ("a param edit during the preview…").
- A first build that errors while the preview shows: `ready` rejects with the build's message, the preview stays on screen and `previewActive` stays true until a later whole-view build succeeds — test in Task 5 ("a first-build error…").
- A preview for another view, or whose names match no sub-part of the view on screen (a session-remembered tab, a renamed sub-part): ignored with one warning, never drawn posed for the wrong view — tests in Task 5 ("…for another view is ignored", "…none of its meshes…").
- `exportPreview` while a rebuild is pending after a param edit: it must refuse rather than encode geometry the parameters have already left — test in Task 6 ("exportPreview refuses while a preview is showing or a rebuild is pending").

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/framework/default-view.js` (modify) | header comment only — the rule is now a public export |
| `src/index.js`, `src/testing.js` (modify) | export `resolveDefaultView`; main entry also `mountPreview` |
| `src/gltf.js` (create) | the `partforge/gltf` entry: re-exports the writer |
| `src/framework/gltf/encode-preview.js` (create) | the GLB writer — worker-safe, no three, no DOM |
| `src/framework/gltf/decode-preview.js` (create) | the GLB reader → viewer mesh payloads in the model frame (three, main thread) |
| `src/framework/viewer.js` (modify) | `getSubMeshPayload(name)` — the drawn geometry with its fast-path pose baked in |
| `src/framework/preview-gate.js` (create) | the "preview on screen" flag + the chrome buttons it holds disabled |
| `src/framework/mount.js` (modify) | `preview` option, `previewActive`, `exportPreview`, the deferred cutaway restore |
| `src/framework/viewbar-clear.js` (create) | the `--pf-viewbar-clear` publisher, moved out of mount.js so mountPreview shares it |
| `src/framework/mount-preview.js` (create) | `mountPreview` — the kernel-free viewer |
| `types/gltf.d.ts` (create), `types/index.d.ts`, `types/testing.d.ts` (modify) | declarations |
| `package.json`, `package-lock.json`, `knip.config.js`, `README.md`, `AGENTS.md` (modify) | wiring, version, docs |
| `test/helpers/preview-glb.js` (create) | box fixtures (soup + indexed) and Node-side GLB readers |
| `test/default-view-export.test.js`, `test/gltf-encode.test.js`, `test/gltf-layering.test.js`, `test/framework/preview-decode.test.js`, `test/framework/preview-gate.test.js`, `test/framework/preview-real-viewer.test.js` (create) | new suites |
| `test/framework/mount.test.js`, `test/framework/viewer-pose.test.js`, `test/types-surface.test.js`, `test/partforge.test-d.ts` (modify) | extended suites |

---

### Task 1: Export `resolveDefaultView`

**Files:**
- Modify: `src/index.js`, `src/testing.js`, `src/framework/default-view.js:1-11` (header comment)
- Modify: `types/index.d.ts` (append after the `viewSubParts` declaration at the end), `types/testing.d.ts` (append)
- Test: `test/default-view-export.test.js` (create); `test/types-surface.test.js` (existing, must stay green)

**Interfaces:**
- Consumes: `resolveDefaultView(part)` from `src/framework/default-view.js` (unchanged; it reads `part.defaults`, returns `string | null`).
- Produces: `resolveDefaultView` exported from `partforge` and `partforge/testing`, declared `resolveDefaultView(part: PartDefinition): string | null`.

- [ ] **Step 1: Write the failing test**

Create `test/default-view-export.test.js`:

```js
// resolveDefaultView is public as of 0.147.0: a host that builds a part headlessly
// (partforge-cloud's preview job) must open the same view mount() does, or the
// cached preview and the live build disagree and the swap visibly jumps.
import { expect, test } from "vitest";
import { resolveDefaultView as fromMain } from "../src/index.js";
import { resolveDefaultView as fromTesting } from "../src/testing.js";
import { resolveDefaultView } from "../src/framework/default-view.js";

const part = {
  defaults: {},
  views: { lid: { label: "Lid" }, assembly: { label: "Assembly" } },
  parts: {
    base: { views: ["assembly"], build: () => null },
    lid: { views: ["lid", "assembly"], build: () => null },
  },
};

test("both entries export the rule mount() itself uses", () => {
  expect(fromMain).toBe(resolveDefaultView);
  expect(fromTesting).toBe(resolveDefaultView);
});

test("it names the view placing the most sub-parts, unless one is flagged default", () => {
  expect(fromMain(part)).toBe("assembly");
  expect(fromTesting({ ...part, views: { ...part.views, lid: { label: "Lid", default: true } } })).toBe("lid");
  expect(fromMain({ parts: {} })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/default-view-export.test.js`
Expected: FAIL — `fromMain` / `fromTesting` are `undefined` ("expected undefined to be [Function resolveDefaultView]").

- [ ] **Step 3: Export it from both entries**

In `src/index.js`, append:

```js
// Which view mount() opens on — for a host that builds a part outside the viewer
// (a cached preview, a server-side render) and must agree with it.
export { resolveDefaultView } from "./framework/default-view.js";
```

In `src/testing.js`, append after the `viewSubParts` line:

```js
export { resolveDefaultView } from "./framework/default-view.js";
```

In `src/framework/default-view.js`, replace the header's last paragraph:

```js
// Pure: no DOM, no storage, no kernel, no build. The headless surfaces (measure /
// verify / renderViews) deliberately do NOT use this — they stay on
// Object.keys(part.views)[0], where a mechanically obvious rule matters more than a
// convenient one.
```

with:

```js
// Pure: no DOM, no storage, no kernel, no build. partforge's own headless surfaces
// (measure / verify / renderViews) deliberately do NOT use this — they stay on
// Object.keys(part.views)[0], where a mechanically obvious rule matters more than a
// convenient one. It is exported (main entry and partforge/testing, 0.147.0) for a
// host that must open the SAME view mount() does — a cached preview built off the
// viewer has to match the live build it is swapped for. The signature is (part):
// it reads part.defaults, never caller params.
```

- [ ] **Step 4: Declare it**

Append to `types/index.d.ts` (after the `viewSubParts` declaration that ends the file):

```ts
/**
 * The view `mount()` opens on: a view flagged `default: true`, else the one
 * placing the most sub-parts at the part's defaults (ties keep declaration
 * order). `null` for a part with no views. Exported so a host building a part
 * outside the viewer — a cached preview — opens the same view.
 */
export function resolveDefaultView(part: PartDefinition): string | null;
```

Append to `types/testing.d.ts`:

```ts
/** The view `mount()` opens on (see the main entry's declaration). */
export function resolveDefaultView(part: PartDefinition): string | null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/default-view-export.test.js test/types-surface.test.js test/framework/default-view.test.js && npm run typecheck`
Expected: all PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/index.js src/testing.js src/framework/default-view.js types/index.d.ts types/testing.d.ts test/default-view-export.test.js
git commit -F - <<'EOF'
feat: export resolveDefaultView from the main entry and partforge/testing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: The preview GLB writer, `partforge/gltf`

**Files:**
- Create: `src/framework/gltf/encode-preview.js`, `src/gltf.js`, `types/gltf.d.ts`, `test/helpers/preview-glb.js`, `test/gltf-encode.test.js`, `test/gltf-layering.test.js`
- Modify: `package.json` (dependencies, `exports`, `typesVersions`), `package-lock.json` (via npm), `test/types-surface.test.js:68-78` (the `RUNTIME` table), `knip.config.js:4-6` (comment)

**Interfaces:**
- Consumes: `cadAppearance`, `DISPLAY_KEYS` from `src/framework/materials/resolve.js`; `cubeSoup(edge)` from `test/helpers/cube-soup.js`.
- Produces:
  - `encodePreviewGlb({ meshes, part = null, view = null }) → Promise<Uint8Array>` where `meshes: Array<{ name: string, positions: Float32Array, normals?: Float32Array | null, indices?: Uint32Array | null, triangles?: number, edges?: Float32Array }>` — throws `TypeError` for a non-array/empty `meshes`, an unnamed mesh or non-typed-array positions; `Error` for a duplicate name, positions that are not whole vertices/triangles, mismatched normals, or every mesh empty. A zero-length mesh gets no node.
  - `PREVIEW_ENCODER_VERSION === 1`.
  - File layout readers rely on: top-level glTF `extras` = `{ partforgeView: string | null, partforgeEncoder: 1, partforgeMeta?: { background?: number, environment?: string } }`; the scene is named for the view; root node `partforge`; each sub-part node's `extras` = `{ partforgeSubPart: name, partforgeDisplay?: <display block, primitive values of DISPLAY_KEYS only> }`.
  - Test helpers: `boxSoup(name, min, max)`, `indexedBox(name, min, max)` (12 triangles each), `previewGlbFor(meshes, part, view)`, `boundsOf(positions)`, `readGlb(bytes)` (NodeIO + meshopt decoder), `worldBounds(doc)`, `glbJson(bytes)`.

- [ ] **Step 1: Add the dependencies**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
npm install --save @gltf-transform/core@^4.4.0 @gltf-transform/extensions@^4.4.0 @gltf-transform/functions@^4.4.0 meshoptimizer@^1.3.0
npm ls @gltf-transform/core meshoptimizer
```

Expected: `npm ls` shows one `@gltf-transform/core` (manifold-3d's copy deduped onto the direct one) and `meshoptimizer@1.x`.

- [ ] **Step 2: Write the fixture helper**

Create `test/helpers/preview-glb.js`:

```js
// Preview-GLB fixtures shared by the gltf / preview suites: a box in each of the
// two shapes the kernels deliver — Manifold's non-indexed soup with per-corner
// normals, OCCT's indexed mesh — plus Node-side readers for the writer's output.
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { encodePreviewGlb } from "../../src/gltf.js";
import { cubeSoup } from "./cube-soup.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const corner = (corners, i, min, max) => [0, 1, 2].map((a) => min[a] + corners[i * 3 + a] * (max[a] - min[a]));

// The box [min, max] as 12 triangles of soup, each corner carrying its face normal.
export function boxSoup(name, min = [0, 0, 0], max = [1, 1, 1]) {
  const { positions: corners, indices } = cubeSoup(1);
  const positions = new Float32Array(indices.length * 3);
  const normals = new Float32Array(indices.length * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => corner(corners, indices[t + k], min, max));
    const n = unit(cross(sub(p[1], p[0]), sub(p[2], p[0])));
    for (let k = 0; k < 3; k++) {
      positions.set(p[k], (t + k) * 3);
      normals.set(n, (t + k) * 3);
    }
  }
  return { name, positions, normals, triangles: indices.length / 3, edges: new Float32Array(0) };
}

// The box [min, max] as 8 shared vertices + 36 indices (smooth corner normals).
export function indexedBox(name, min = [0, 0, 0], max = [1, 1, 1]) {
  const { positions: corners, indices } = cubeSoup(1);
  const positions = new Float32Array(corners.length);
  const normals = new Float32Array(corners.length);
  for (let i = 0; i < corners.length / 3; i++) {
    positions.set(corner(corners, i, min, max), i * 3);
    normals.set(unit([0, 1, 2].map((a) => corners[i * 3 + a] - 0.5)), i * 3);
  }
  return { name, positions, normals, indices: new Uint32Array(indices), triangles: indices.length / 3, edges: new Float32Array(0) };
}

export const previewGlbFor = (meshes, part = null, view = "main") => encodePreviewGlb({ meshes, part, view });

export function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return { min, max };
}

// Read a preview GLB back the way a third party would (no three.js).
export async function readGlb(bytes) {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  return io.readBinary(bytes);
}

// World-space bounds of every mesh node: dequantized positions through each
// node's world matrix (the root's Y-up rotation and quantize()'s node transform).
export function worldBounds(doc) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const el = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      for (let i = 0; i < pos.getCount(); i++) {
        const [x, y, z] = pos.getElement(i, el);
        const w = [
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ];
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], w[a]);
          max[a] = Math.max(max[a], w[a]);
        }
      }
    }
  }
  return { min, max };
}

// The GLB's JSON chunk, parsed (bytes 12..: chunk length, chunk type, then JSON).
export function glbJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}
```

- [ ] **Step 3: Write the failing tests**

Create `test/gltf-encode.test.js`:

```js
// partforge/gltf: the cached-preview writer. What a reader can rely on — one
// node per sub-part named by key, under one Y-up root, in millimetres; the
// viewer's own CAD look; exactly two required extensions; and the same bytes
// for the same input (the cloud keys its cache on them).
import { expect, test } from "vitest";
import { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "../src/gltf.js";
import { cadAppearance } from "../src/framework/materials/resolve.js";
import { boxSoup, indexedBox, readGlb, worldBounds, glbJson } from "./helpers/preview-glb.js";

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const factorOf = (hex, alpha = 1) =>
  [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => srgbToLinear(v / 255)).concat(alpha);
const expectNear = (got, want, digits = 4) => {
  expect(got).toHaveLength(want.length);
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i], digits));
};

const part = {
  parts: {
    base: { display: { color: 0xff0000 } },
    lid: {},
    glass: { display: { opacity: 0.4 } },
    brass: { display: { material: "brass" } },
  },
};
const meshes = () => [
  boxSoup("base", [0, 0, 0], [4, 2, 6]),
  indexedBox("lid", [0, 0, 6], [4, 2, 7]),
  boxSoup("glass", [5, 0, 0], [6, 1, 1]),
  boxSoup("brass", [7, 0, 0], [8, 1, 1]),
];
const nodeNamed = (doc, name) => doc.getRoot().listNodes().find((n) => n.getName() === name);
const materialOf = (doc, name) => nodeNamed(doc, name).getMesh().listPrimitives()[0].getMaterial();

test("PREVIEW_ENCODER_VERSION starts at 1", () => {
  expect(PREVIEW_ENCODER_VERSION).toBe(1);
});

test("one node, mesh and primitive per sub-part, named by key, under one Y-up root", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  const [scene] = doc.getRoot().listScenes();
  expect(scene.getName()).toBe("assembly");
  const [root] = scene.listChildren();
  expect(root.getName()).toBe("partforge");
  expectNear(root.getRotation(), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], 6);
  const children = root.listChildren();
  expect(children.map((n) => n.getName())).toEqual(["base", "lid", "glass", "brass"]);
  for (const node of children) {
    expect(node.getMesh().getName()).toBe(node.getName());
    expect(node.getMesh().listPrimitives()).toHaveLength(1);
    expect(node.getExtras().partforgeSubPart).toBe(node.getName());
  }
  expect(doc.getRoot().getExtras()).toEqual({ partforgeView: "assembly", partforgeEncoder: PREVIEW_ENCODER_VERSION });
  expect(nodeNamed(doc, "base").getExtras().partforgeDisplay).toEqual({ color: 0xff0000 });
  expect(nodeNamed(doc, "lid").getExtras()).toEqual({ partforgeSubPart: "lid" });
});

test("triangle counts survive welding and compression, soup and indexed alike", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  for (const name of ["base", "lid", "glass", "brass"]) {
    const prim = nodeNamed(doc, name).getMesh().listPrimitives()[0];
    expect(prim.getIndices().getCount() / 3).toBe(12);
    expect(prim.getAttribute("NORMAL")).toBeTruthy();
  }
});

test("bounds come out Y-up in millimetres: model (x, y, z) is glTF (x, z, -y)", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("base", [0, 0, 0], [4, 2, 6])], part, view: "v" }));
  const { min, max } = worldBounds(doc);
  expectNear(min, [0, 0, -2], 2);
  expectNear(max, [4, 6, 0], 2);
});

test("materials come from the viewer's CAD resolver", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  for (const name of ["base", "lid", "glass", "brass"]) {
    const look = cadAppearance(part.parts[name].display);
    expectNear(materialOf(doc, name).getBaseColorFactor(), factorOf(look.color, look.opacity), 6);
    expect(materialOf(doc, name).getRoughnessFactor()).toBeCloseTo(look.roughness, 6);
    expect(materialOf(doc, name).getMetallicFactor()).toBeCloseTo(look.metalness, 6);
  }
  expectNear(materialOf(doc, "base").getBaseColorFactor(), [1, 0, 0, 1], 6);
  expectNear(materialOf(doc, "lid").getBaseColorFactor(), factorOf(0x9fb4cc), 6);
  expect(materialOf(doc, "lid").getMetallicFactor()).toBeCloseTo(0.25, 6);
  expect(materialOf(doc, "lid").getRoughnessFactor()).toBeCloseTo(0.55, 6);
  expect(materialOf(doc, "glass").getAlphaMode()).toBe("BLEND");
  expect(materialOf(doc, "glass").getBaseColorFactor()[3]).toBeCloseTo(0.4, 6);
  expect(materialOf(doc, "base").getAlphaMode()).toBe("OPAQUE");
});

test("with no part every sub-part takes the drafting default", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("x")], view: "v" }));
  expectNear(materialOf(doc, "x").getBaseColorFactor(), factorOf(0x9fb4cc), 6);
});

test("the part's background and environment ride along for a part-less viewer", async () => {
  const withMeta = { ...part, meta: { title: "T", background: 0x101010, environment: "workshop" } };
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("base")], part: withMeta, view: "v" }));
  expect(doc.getRoot().getExtras().partforgeMeta).toEqual({ background: 0x101010, environment: "workshop" });
});

test("required and used extensions are exactly quantization and meshopt", async () => {
  const json = glbJson(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  expect([...json.extensionsRequired].sort()).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
  expect([...json.extensionsUsed].sort()).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
});

test("identical input encodes to identical bytes, and the input is left untouched", async () => {
  const input = meshes();
  const before = input.map((m) => [m.positions.slice(), m.normals.slice()]);
  const a = await encodePreviewGlb({ meshes: input, part, view: "assembly" });
  const b = await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" });
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  input.forEach((m, i) => {
    expect(m.positions).toEqual(before[i][0]);
    expect(m.normals).toEqual(before[i][1]);
  });
});

test("an empty sub-part gets no node; all-empty and malformed input is refused", async () => {
  const empty = { name: "ghost", positions: new Float32Array(0), normals: new Float32Array(0), triangles: 0 };
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("base"), empty], view: "v" }));
  expect(doc.getRoot().listNodes().map((n) => n.getName())).toEqual(["partforge", "base"]);
  await expect(encodePreviewGlb({ meshes: [empty], view: "v" })).rejects.toThrow(/every mesh was empty/);
  await expect(encodePreviewGlb({ meshes: [] })).rejects.toThrow(TypeError);
  await expect(encodePreviewGlb({ meshes: [boxSoup("a"), boxSoup("a")] })).rejects.toThrow(/two meshes are named "a"/);
  await expect(encodePreviewGlb({ meshes: [{ name: "a", positions: [0, 0, 0] }] })).rejects.toThrow(TypeError);
  await expect(encodePreviewGlb({ meshes: [{ name: "a", positions: new Float32Array(6) }] })).rejects.toThrow(/whole triangles/);
  await expect(encodePreviewGlb({ meshes: [{ ...boxSoup("a"), normals: new Float32Array(3) }] })).rejects.toThrow(/normals do not match/);
});
```

Create `test/gltf-layering.test.js`:

```js
// partforge/gltf runs in Node (the cloud's sandbox job), a browser main thread
// (exportPreview) and a Web Worker. Two checks: the static import closure of OUR
// modules (the import-graph walker, as worker-layering.test.js does it), and an
// encode with no DOM, Blob or FileReader in scope, which is the only way to judge
// the bare packages the walker cannot descend into.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";
import { boxSoup } from "./helpers/preview-glb.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = `${ROOT}/src/gltf.js`;
const ALLOWED = new Set([
  "@gltf-transform/core", "@gltf-transform/extensions", "@gltf-transform/functions", "meshoptimizer/encoder",
]);
const DOM_GLOBALS = ["document", "window", "localStorage", "sessionStorage", "HTMLElement", "customElements", "Blob", "FileReader"];
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

afterEach(() => vi.unstubAllGlobals());

test("partforge/gltf imports no package beyond the encoder's own (no three, no Node builtin)", () => {
  const { bare, importer } = walk(ENTRY, "gltf walk");
  for (const spec of bare) {
    expect(ALLOWED.has(spec), `partforge/gltf must not import "${spec}":\n  ${chainTo(spec, importer, ROOT)}`).toBe(true);
  }
});

test("no module of ours in the closure touches a main-thread-only global", () => {
  const { files, importer } = walk(ENTRY, "gltf walk");
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const hit = DOM_GLOBALS.find((g) => new RegExp(`\\b${g}\\b`).test(src));
    expect(hit == null, hit ? `\`${hit}\` in partforge/gltf's closure:\n  ${chainTo(file, importer, ROOT)}` : "").toBe(true);
  }
});

test("it encodes with no document, window, Blob or FileReader in scope", async () => {
  for (const g of ["document", "window", "Blob", "FileReader"]) vi.stubGlobal(g, undefined);
  const { encodePreviewGlb } = await import("../src/gltf.js");
  const bytes = await encodePreviewGlb({ meshes: [boxSoup("a")], view: "v" });
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
});
```

In `test/types-surface.test.js`, add one line to the `RUNTIME` table (after `"./panel-values"`):

```js
  "./gltf": () => import("../src/gltf.js"),
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/gltf-encode.test.js test/gltf-layering.test.js`
Expected: FAIL — `Failed to resolve import "../src/gltf.js"` (and the helper's import of it).

- [ ] **Step 5: Write the encoder**

Create `src/framework/gltf/encode-preview.js`:

```js
// The cached-preview writer behind `partforge/gltf`: one view's POSED display
// meshes (the payloads the viewer, the worker's `meshes` reply and the oracle's
// buildView all hold) as a small GLB a viewer can show before the kernel boots.
//
// The file, which a reader may rely on:
//  - one node + mesh + primitive per sub-part, all three named by the sub-part
//    key; POSITION + NORMAL (+ indices when the kernel sent them)
//  - every sub-part node under ONE root node, "partforge", rotated −90° about X:
//    partforge models Z-up in millimetres and glTF is Y-up. Units stay mm — the
//    file is for partforge's own viewer; metres would only matter for AR.
//  - each material from cadAppearance — the CAD look the viewer itself draws —
//    and each node's extras carrying the sub-part's own `display` block, so a
//    part-less viewer (mountPreview) can rebuild the exact look, realistic too
//  - top-level extras { partforgeView, partforgeEncoder, partforgeMeta? }
//  - weld() → quantize() → meshopt({ level: "medium" }): 5–8 bytes a triangle,
//    the recipe measured in partforge-cloud's local_glb_benchmark.md
// Not encoded (v1): feature edges, textures, patterns.
//
// Runs in Node, a page and a Web Worker: no three.js, no DOM, no Blob
// (test/gltf-layering.test.js). Deterministic: the same input writes the same
// bytes, and nothing here mutates the input (exportPreview passes the viewer's
// live buffers). Bump PREVIEW_ENCODER_VERSION whenever the bytes for the same
// input change — downstream caches key on it.
import { Document, Logger, WebIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt, quantize, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { cadAppearance, DISPLAY_KEYS } from "../materials/resolve.js";

export const PREVIEW_ENCODER_VERSION = 1;

// −90° about X as [x, y, z, w]: model (x, y, z) → glTF (x, z, −y), the viewer's pivot.
const Z_UP_TO_Y_UP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

let encoderReady = null; // MeshoptEncoder's wasm, awaited once per process

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function baseColorFactor(hex, opacity) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => srgbToLinear(v / 255)).concat(opacity);
}

// The display block as plain data (resolve.js's own keys, primitive values only).
function displayExtras(display) {
  if (!display || typeof display !== "object") return null;
  const out = {};
  for (const key of DISPLAY_KEYS) {
    const v = display[key];
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// The two meta fields createViewer reads (background, environment).
function metaExtras(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  if (Number.isInteger(meta.background)) out.background = meta.background;
  if (typeof meta.environment === "string") out.environment = meta.environment;
  return Object.keys(out).length ? out : null;
}

function checkMesh(m, seen) {
  if (!m || typeof m.name !== "string" || !m.name) throw new TypeError("encodePreviewGlb: every mesh needs a non-empty string name");
  if (seen.has(m.name)) throw new Error(`encodePreviewGlb: two meshes are named "${m.name}"`);
  seen.add(m.name);
  if (!ArrayBuffer.isView(m.positions)) throw new TypeError(`encodePreviewGlb: "${m.name}" positions must be a typed array`);
  const indexed = m.indices != null && m.indices.length > 0;
  if (m.positions.length % (indexed ? 3 : 9) !== 0) {
    throw new Error(`encodePreviewGlb: "${m.name}" positions are not whole ${indexed ? "vertices" : "triangles"}`);
  }
  if (indexed && m.indices.length % 3 !== 0) throw new Error(`encodePreviewGlb: "${m.name}" indices are not whole triangles`);
  if (m.normals != null && m.normals.length > 0 && m.normals.length !== m.positions.length) {
    throw new Error(`encodePreviewGlb: "${m.name}" normals do not match its positions`);
  }
}

export async function encodePreviewGlb({ meshes, part = null, view = null } = {}) {
  if (!Array.isArray(meshes) || meshes.length === 0) throw new TypeError("encodePreviewGlb: meshes must be a non-empty array");
  const seen = new Set();
  for (const m of meshes) checkMesh(m, seen);
  await (encoderReady ??= MeshoptEncoder.ready);

  const viewName = typeof view === "string" && view ? view : null;
  const doc = new Document();
  doc.setLogger(new Logger(Logger.Verbosity.SILENT));
  const buffer = doc.createBuffer();
  const scene = doc.createScene(viewName ?? "preview");
  const root = doc.createNode("partforge").setRotation(Z_UP_TO_Y_UP);
  scene.addChild(root);
  const meta = metaExtras(part?.meta);
  doc.getRoot().setExtras({
    partforgeView: viewName,
    partforgeEncoder: PREVIEW_ENCODER_VERSION,
    ...(meta ? { partforgeMeta: meta } : {}),
  });

  for (const m of meshes) {
    if (m.positions.length === 0) continue; // glTF forbids a zero-count accessor
    // Copies throughout: setArray keeps the array it is handed, and the
    // transforms below rewrite it.
    const prim = doc.createPrimitive().setAttribute(
      "POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(m.positions)).setBuffer(buffer));
    if (m.normals?.length) {
      prim.setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(m.normals)).setBuffer(buffer));
    }
    if (m.indices?.length) {
      prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(m.indices)).setBuffer(buffer));
    }
    const display = part?.parts?.[m.name]?.display;
    const look = cadAppearance(display);
    prim.setMaterial(doc.createMaterial(m.name)
      .setBaseColorFactor(baseColorFactor(look.color, look.opacity))
      .setMetallicFactor(look.metalness)
      .setRoughnessFactor(look.roughness)
      .setAlphaMode(look.opacity < 1 ? "BLEND" : "OPAQUE"));
    const extras = displayExtras(display);
    root.addChild(doc.createNode(m.name)
      .setMesh(doc.createMesh(m.name).addPrimitive(prim))
      .setExtras(extras ? { partforgeSubPart: m.name, partforgeDisplay: extras } : { partforgeSubPart: m.name }));
  }
  if (root.listChildren().length === 0) throw new Error("encodePreviewGlb: every mesh was empty");

  await doc.transform(weld(), quantize(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const io = new WebIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  io.setLogger(new Logger(Logger.Verbosity.SILENT));
  return io.writeBinary(doc);
}
```

Create `src/gltf.js`:

```js
// partforge/gltf — the cached-preview writer. One view's posed display meshes as a
// small GLB (see src/framework/gltf/encode-preview.js for the file's contract).
// Worker-safe: no three.js, no DOM, so it runs in Node (a server-side preview job),
// a page (runtime.exportPreview) and a Web Worker alike. Read the files back with
// mount()'s `preview` option or mountPreview(), both on the main entry.
export { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "./framework/gltf/encode-preview.js";
```

Create `types/gltf.d.ts`:

```ts
// partforge/gltf — the cached-preview writer. Worker-safe: no three.js, no DOM.

import type { PartDefinition } from "./part.js";

/** One sub-part's posed display mesh — the shape the viewer, the worker's `meshes` reply and `buildView` hold. */
export interface PreviewMesh {
  /** The sub-part key; names the glTF node, mesh and material. */
  name: string;
  /** xyz triples in millimetres, Z-up, already posed. */
  positions: Float32Array;
  normals?: Float32Array | null;
  /** Absent for a non-indexed soup (Manifold); OCCT sends indices. */
  indices?: Uint32Array | null;
  triangles?: number;
  /** Ignored: feature edges are not encoded in this version. */
  edges?: Float32Array | null;
}

export interface EncodePreviewInput {
  /** At least one; a zero-length mesh gets no node. */
  meshes: PreviewMesh[];
  /** Read for `parts[name].display` (materials) and `meta.background` / `meta.environment`. */
  part?: Pick<PartDefinition, "parts" | "meta"> | null;
  /** The view these meshes show; names the scene and lands in the file's extras as `partforgeView`. */
  view?: string | null;
}

/** Bumped whenever the encoder writes different bytes for the same input. */
export const PREVIEW_ENCODER_VERSION: number;

/** Encode one view's posed meshes as a welded, quantized, meshopt-compressed GLB (Y-up, millimetres). Deterministic. */
export function encodePreviewGlb(input: EncodePreviewInput): Promise<Uint8Array>;
```

- [ ] **Step 6: Wire the subpath**

In `package.json`, add to `exports` (after `"./panel-values"`):

```json
    "./gltf": {
      "types": "./types/gltf.d.ts",
      "default": "./src/gltf.js"
    },
```

and to `typesVersions["*"]` (after `"panel-values"`):

```json
      "gltf": [
        "./types/gltf.d.ts"
      ],
```

(mind the trailing commas: `"panel-values"` gains a comma, `"gltf"` is last in `typesVersions`; in `exports`, `"./gltf"` sits before the two `.css` entries).

In `knip.config.js`, in the header comment change "the nine subpath exports in package.json" to "the ten subpath exports in package.json".

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/gltf-encode.test.js test/gltf-layering.test.js test/types-surface.test.js && npm run typecheck`
Expected: all PASS; typecheck exits 0. If the bounds test is off by more than 0.005, print `worldBounds(doc)` — quantization at 14 bits over a 6 mm box is ~0.0004 mm, so a larger error means the root rotation or the dequantization transform is wrong, not the tolerance.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json knip.config.js src/gltf.js src/framework/gltf/encode-preview.js types/gltf.d.ts test/helpers/preview-glb.js test/gltf-encode.test.js test/gltf-layering.test.js test/types-surface.test.js
git commit -F - <<'EOF'
feat(gltf): add the preview GLB writer as partforge/gltf

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: The preview GLB reader

**Files:**
- Create: `src/framework/gltf/decode-preview.js`, `test/framework/preview-decode.test.js`

**Interfaces:**
- Consumes: the file layout from Task 2; `encodePreviewGlb`; `boxSoup`, `indexedBox`, `boundsOf` from `test/helpers/preview-glb.js`.
- Produces: `decodePreviewGlb(bytes: Uint8Array | ArrayBuffer) → Promise<{ view: string | null, meta: { background?: number, environment?: string } | null, meshes: Array<{ name, positions: Float32Array, normals: Float32Array | null, indices: Uint32Array | null, triangles: number, edges: Float32Array /* always empty */, display: object | null }> }>`. Positions/normals are in the part's **Z-up model frame** (the writer's root rotation undone, quantization decoded) — the exact payload `viewer.setSubGeometry(name, payload)` takes. Rejects (`TypeError` for a non-binary argument) on anything that is not a decodable GLB.

- [ ] **Step 1: Write the failing test**

Create `test/framework/preview-decode.test.js`:

```js
// @vitest-environment happy-dom
// The preview reader: three's GLTFLoader + MeshoptDecoder, turning the writer's
// file back into the viewer's own mesh payloads in the part's Z-up frame — so a
// preview goes through setSubGeometry exactly like a worker delivery.
import { expect, test } from "vitest";
import { encodePreviewGlb } from "../../src/gltf.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxSoup, indexedBox, boundsOf } from "../helpers/preview-glb.js";

const expectNear = (got, want, digits = 2) => got.forEach((g, i) => expect(g).toBeCloseTo(want[i], digits));
const part = { meta: { environment: "workshop" }, parts: { base: { display: { color: 0xff0000 } }, lid: {} } };
const encode = () => encodePreviewGlb({
  meshes: [boxSoup("base", [0, 0, 0], [4, 2, 6]), indexedBox("lid", [0, 0, 6], [4, 2, 7])], part, view: "assembly",
});

test("decodes back to model-frame (Z-up) payloads named by sub-part key", async () => {
  const out = await decodePreviewGlb(await encode());
  expect(out.view).toBe("assembly");
  expect(out.meta).toEqual({ environment: "workshop" });
  expect(out.meshes.map((m) => m.name)).toEqual(["base", "lid"]);
  const [base, lid] = out.meshes;
  expect(base.triangles).toBe(12);
  expect(lid.triangles).toBe(12);
  expect(base.display).toEqual({ color: 0xff0000 });
  expect(lid.display).toBeNull();
  expect(base.edges).toEqual(new Float32Array(0));
  expect(base.indices).toBeInstanceOf(Uint32Array);
  const b = boundsOf(base.positions);
  expectNear(b.min, [0, 0, 0]);
  expectNear(b.max, [4, 2, 6]);
  const l = boundsOf(lid.positions);
  expectNear(l.min, [0, 0, 6]);
  expectNear(l.max, [4, 2, 7]);
  for (let i = 0; i < base.normals.length; i += 3) {
    expect(Math.hypot(base.normals[i], base.normals[i + 1], base.normals[i + 2])).toBeCloseTo(1, 3);
  }
});

test("a face normal comes back pointing the way it was written (+Z stays +Z)", async () => {
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [boxSoup("top", [0, 0, 0], [1, 1, 1])], view: "v" }));
  const { positions, normals } = out.meshes[0];
  // a vertex on the top face (z = 1) whose normal is the face's
  let found = false;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2] - 1) < 1e-3 && normals[i + 2] > 0.99) found = true;
  }
  expect(found).toBe(true);
});

test("accepts an ArrayBuffer and an offset Uint8Array view alike", async () => {
  const glb = await encode();
  const padded = new Uint8Array(glb.length + 8);
  padded.set(glb, 8);
  expect((await decodePreviewGlb(padded.subarray(8))).meshes).toHaveLength(2);
  const exact = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  expect((await decodePreviewGlb(exact)).meshes).toHaveLength(2);
});

test("anything that is not a decodable GLB rejects", async () => {
  await expect(decodePreviewGlb(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  await expect(decodePreviewGlb((await encode()).subarray(0, 40))).rejects.toThrow();
  await expect(decodePreviewGlb("glTF")).rejects.toThrow(TypeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/framework/preview-decode.test.js`
Expected: FAIL — `Failed to resolve import "../../src/framework/gltf/decode-preview.js"`.

- [ ] **Step 3: Write the reader**

Create `src/framework/gltf/decode-preview.js`:

```js
// The cached-preview reader (main thread): a GLB written by encode-preview.js,
// decoded with three's GLTFLoader + MeshoptDecoder and turned back into the
// viewer's own mesh payloads — { name, positions, normals, indices, triangles,
// edges } in the part's Z-up MODEL frame — so a preview is drawn through
// viewer.setSubGeometry exactly like a worker delivery. Everything after that
// (the pivot, the per-sub-part CAD material, framing, the cutaway, captures)
// is the viewer's existing code.
//
// Why payloads and not the loaded scene graph: the file's root node carries the
// −90° about X that stands Z-up on end, and the viewer's pivot carries the same
// rotation; parenting the glTF root under the pivot would turn the part twice.
// Undoing the root here hands the viewer geometry in the frame it already owns.
//
// Rejects on anything that is not a decodable GLB; the callers (mount's
// `preview`, mountPreview) decide what a failure means for them.
import { Matrix3, Matrix4, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

// The writer's root rotation (−90° about X), inverted: glTF Y-up → model Z-up.
const Y_UP_TO_Z_UP = new Matrix4().makeRotationX(Math.PI / 2);

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  throw new TypeError("decodePreviewGlb: the preview must be a Uint8Array or an ArrayBuffer");
}

// Read a (possibly quantized, normalized) vec3 attribute out as Float32, transformed.
function readVec3(attr, matrix, isNormal) {
  const out = new Float32Array(attr.count * 3);
  const v = new Vector3();
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i); // denormalizes a KHR_mesh_quantization attribute
    if (isNormal) v.applyMatrix3(matrix).normalize();
    else v.applyMatrix4(matrix);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

function metaOf(extras) {
  const m = extras?.partforgeMeta;
  if (!m || typeof m !== "object") return null;
  const out = {};
  if (Number.isInteger(m.background)) out.background = m.background;
  if (typeof m.environment === "string") out.environment = m.environment;
  return Object.keys(out).length ? out : null;
}

export async function decodePreviewGlb(bytes) {
  const data = toArrayBuffer(bytes);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, "");
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  const toModel = new Matrix4();
  const normalMatrix = new Matrix3();
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const geometry = obj.geometry;
    const position = geometry.getAttribute("position");
    if (!position || position.count === 0) return;
    toModel.multiplyMatrices(Y_UP_TO_Z_UP, obj.matrixWorld);
    normalMatrix.getNormalMatrix(toModel);
    const normal = geometry.getAttribute("normal");
    const indices = geometry.index ? Uint32Array.from(geometry.index.array) : null;
    const { partforgeSubPart, partforgeDisplay, name: originalName } = obj.userData;
    meshes.push({
      // The writer's own record of the key, then the unsanitized glTF node name.
      name: typeof partforgeSubPart === "string" ? partforgeSubPart : (originalName ?? obj.name),
      positions: readVec3(position, toModel, false),
      normals: normal ? readVec3(normal, normalMatrix, true) : null,
      indices,
      triangles: (indices ? indices.length : position.count) / 3,
      edges: new Float32Array(0), // previews carry no feature edges (v1)
      display: partforgeDisplay && typeof partforgeDisplay === "object" ? partforgeDisplay : null,
    });
    geometry.dispose();
  });
  const extras = gltf.userData ?? {};
  return {
    view: typeof extras.partforgeView === "string" ? extras.partforgeView : null,
    meta: metaOf(extras),
    meshes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/framework/preview-decode.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/gltf/decode-preview.js test/framework/preview-decode.test.js
git commit -F - <<'EOF'
feat(gltf): decode preview GLBs into model-frame viewer payloads

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: `viewer.getSubMeshPayload` — the drawn geometry, pose baked in

**Files:**
- Modify: `src/framework/viewer.js` — add a function after `subTriangles` (~line 1643) and one entry in the returned API (~line 2729, after `subTriangles,`)
- Test: `test/framework/viewer-pose.test.js` (append)

**Interfaces:**
- Consumes: the viewer's private `subCache[name]` (the delivered geometry, model frame) and `subMesh[name].matrix` (the fast-path pose set by `setSubPose`, identity when none).
- Produces: `viewer.getSubMeshPayload(name) → { name, positions: Float32Array, normals: Float32Array | null, indices: Uint32Array | null, triangles: number } | null` — copies, with the pose applied to positions (matrix) and normals (normal matrix, renormalized); `null` when nothing is delivered for that name. Name starts with `get`, so `withRenderRequests` leaves it unwrapped.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/viewer-pose.test.js`:

```js
// --- getSubMeshPayload: what exportPreview encodes --------------------------
const expectNear = (got, want) => {
  expect(got).toHaveLength(want.length);
  [...got].forEach((g, i) => expect(g).toBeCloseTo(want[i], 5));
};

test("getSubMeshPayload returns the delivered geometry with its fast-path pose baked in", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  // rotate 90° about Z, then slide 10mm along +X
  const pose = new THREE.Matrix4().makeTranslation(10, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  viewer.setSubPose("body", pose.toArray());

  const out = viewer.getSubMeshPayload("body");

  expect(out.name).toBe("body");
  expect(out.triangles).toBe(1);
  expect(out.indices).toBeNull();
  expectNear(out.positions, [10, 0, 0, 10, 1, 0, 9, 0, 0]);
  expectNear(out.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]); // a Z rotation keeps +Z
  viewer.dispose();
});

test("normals turn with the pose and stay unit length", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  viewer.setSubPose("body", new THREE.Matrix4().makeRotationX(Math.PI / 2).toArray());
  expectNear(viewer.getSubMeshPayload("body").normals, [0, -1, 0, 0, -1, 0, 0, -1, 0]);
  viewer.dispose();
});

test("unposed geometry comes back as delivered, as copies the caller may keep", () => {
  const viewer = makeViewer();
  const tri = { ...triangle(), indices: new Uint32Array([0, 1, 2]) };
  viewer.setSubGeometry("body", tri);
  const out = viewer.getSubMeshPayload("body");
  expectNear(out.positions, [...tri.positions]);
  expect([...out.indices]).toEqual([0, 1, 2]);
  expect(out.positions).not.toBe(tri.positions);
  out.positions[0] = 99;
  expect(tri.positions[0]).toBe(0);
  expect(viewer.getSubMeshPayload("body").positions[0]).toBe(0);
  viewer.dispose();
});

test("getSubMeshPayload is null for a sub-part with nothing delivered, or no such sub-part", () => {
  const viewer = makeViewer();
  expect(viewer.getSubMeshPayload("lid")).toBeNull();
  expect(viewer.getSubMeshPayload("nope")).toBeNull();
  viewer.dispose();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/viewer-pose.test.js`
Expected: the four new tests FAIL with "viewer.getSubMeshPayload is not a function"; the existing ones PASS.

- [ ] **Step 3: Implement**

In `src/framework/viewer.js`, directly after

```js
  const subTriangles = (name) => subCache[name]?.userData.triangles ?? 0;
```

add:

```js
  // The geometry drawn for one sub-part, as a fresh worker-style payload with its
  // fast-path pose (setSubPose) baked in — the posed mesh a headless buildView
  // would return. Copies: the caller (exportPreview → partforge/gltf) may keep or
  // transfer them. null when nothing has been delivered under that name.
  const _payloadV = new THREE.Vector3();
  const _payloadNormal = new THREE.Matrix3();
  function getSubMeshPayload(name) {
    const geo = subCache[name];
    if (!geo) return null;
    const pose = subMesh[name].matrix; // identity unless the fast path posed it
    _payloadNormal.getNormalMatrix(pose);
    const pos = geo.getAttribute("position");
    const positions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _payloadV.fromBufferAttribute(pos, i).applyMatrix4(pose).toArray(positions, i * 3);
    }
    const nor = geo.getAttribute("normal");
    let normals = null;
    if (nor) {
      normals = new Float32Array(nor.count * 3);
      for (let i = 0; i < nor.count; i++) {
        _payloadV.fromBufferAttribute(nor, i).applyMatrix3(_payloadNormal).normalize().toArray(normals, i * 3);
      }
    }
    return {
      name,
      positions,
      normals,
      indices: geo.index ? Uint32Array.from(geo.index.array) : null,
      triangles: geo.userData.triangles ?? (geo.index ? geo.index.count : pos.count) / 3,
    };
  }
```

and in the returned API object, directly after `subTriangles,` add:

```js
    getSubMeshPayload,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/viewer-pose.test.js test/framework/viewer-render-on-demand.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewer.js test/framework/viewer-pose.test.js
git commit -F - <<'EOF'
feat(viewer): getSubMeshPayload returns a sub-part's drawn mesh with its pose baked in

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: `mount({ preview })` and `runtime.previewActive`

**Files:**
- Create: `src/framework/preview-gate.js`, `test/framework/preview-gate.test.js`
- Modify: `src/framework/mount.js` (imports ~line 41; `makeHandle` line 72-73; the `mount` signature line 436; after `ui` creation ~line 516; picker `suppressed` ~line 813; hover suppression ~line 787-790; `cameraRestored` ~line 853; `showView` ~line 905-937; `emptySubParts` ~line 1006; `refreshView` ~line 1008-1024; `case "meshes"` ~line 1086 and ~line 1113; before `return makeHandle(` ~line 1449; the `measure`/`annotate` handle entries ~line 1467-1481)
- Modify: `types/index.d.ts` (`MountOptions`, `PartRuntime`)
- Test: `test/framework/mount.test.js` (top-of-file mock + imports + `beforeEach`, then append)

**Interfaces:**
- Consumes: `decodePreviewGlb` (Task 3); `boxSoup`, `previewGlbFor` (Task 2 helper).
- Produces:
  - `createPreviewGate({ buttons? }) → { isActive(): boolean, start(): void, end(): void, onChange(cb: (active: boolean) => void): () => void }` — `start` disables every given button (remembering each one's prior `disabled`), `end` restores them; both idempotent; `onChange` fires only on real transitions.
  - `mount(part, { …, preview?: Uint8Array | ArrayBuffer | null })`.
  - `runtime.previewActive` — a live getter, `true` from the moment the preview is drawn until a fresh `meshes` reply leaves no sub-part of the view missing.
  - `makeHandle({ …, isPreviewActive })`.
  - Behaviour later tasks rely on: mount-scoped `let disposed` (set by the first cleanup to run at dispose) and `previewGate` exist in `mount()`'s scope just above `return makeHandle(`.

- [ ] **Step 1: Write the gate's failing test**

Create `test/framework/preview-gate.test.js`:

```js
// @vitest-environment happy-dom
// The "a cached preview is on screen" flag and the chrome it holds disabled
// (cutaway, measure, sketch): those modes need live solids and feature ids,
// which a preview mesh does not have.
import { expect, test } from "vitest";
import { createPreviewGate } from "../../src/framework/preview-gate.js";

const button = (disabled = false) => {
  const b = document.createElement("button");
  b.disabled = disabled;
  return b;
};

test("start disables every button and end gives each back the state it had", () => {
  const free = button();
  const held = button(true);
  const gate = createPreviewGate({ buttons: [free, held, null] });
  expect(gate.isActive()).toBe(false);
  gate.start();
  expect(gate.isActive()).toBe(true);
  expect([free.disabled, held.disabled]).toEqual([true, true]);
  gate.end();
  expect(gate.isActive()).toBe(false);
  expect([free.disabled, held.disabled]).toEqual([false, true]);
});

test("start and end are idempotent and announce only real transitions", () => {
  const gate = createPreviewGate();
  const seen = [];
  const off = gate.onChange((active) => seen.push(active));
  gate.end();
  gate.start();
  gate.start();
  gate.end();
  gate.end();
  expect(seen).toEqual([true, false]);
  off();
  gate.start();
  expect(seen).toEqual([true, false]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/framework/preview-gate.test.js`
Expected: FAIL — cannot resolve `../../src/framework/preview-gate.js`.

- [ ] **Step 3: Write the gate**

Create `src/framework/preview-gate.js`:

```js
// Whether a cached preview (mount's `preview` option) is on screen, and the
// chrome it holds off meanwhile. A preview mesh has no feature ids and no live
// solid behind it, so the modes that read those — cutaway, measure, sketch —
// wait for the live build; picking and hover ask isActive() per event. Each
// button gets back exactly the `disabled` it had (a host may disable one for its
// own reasons, and that must survive the round trip).
export function createPreviewGate({ buttons = [] } = {}) {
  let active = false;
  const held = []; // { el, wasDisabled }
  const listeners = new Set();
  const announce = () => {
    for (const cb of [...listeners]) cb(active);
  };
  return {
    isActive: () => active,
    start() {
      if (active) return;
      active = true;
      for (const el of buttons) {
        if (!el) continue;
        held.push({ el, wasDisabled: el.disabled });
        el.disabled = true;
      }
      announce();
    },
    end() {
      if (!active) return;
      active = false;
      for (const { el, wasDisabled } of held.splice(0)) el.disabled = wasDisabled;
      announce();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
```

Run: `npx vitest run test/framework/preview-gate.test.js` — Expected: PASS.

- [ ] **Step 4: Write the mount tests (failing)**

In `test/framework/mount.test.js`:

(a) Directly after the `vi.mock("../../src/framework/animation-controls.js", …)` block (before `import { mount, makeHandle }`), add:

```js
// The preview decoder, wrapped so a test can await exactly the decodes mount
// started. mount's own .then is chained on the same promise first, so once a
// test has awaited the promise, mount's handler has run.
const decodes = vi.hoisted(() => []);
vi.mock("../../src/framework/gltf/decode-preview.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    decodePreviewGlb: vi.fn((bytes) => {
      const p = real.decodePreviewGlb(bytes);
      decodes.push(p);
      return p;
    }),
  };
});
```

(b) Add to the imports below it:

```js
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxSoup, previewGlbFor } from "../helpers/preview-glb.js";
```

(c) In the existing `beforeEach`, add `decodes.length = 0;` beside `fakeViewers.length = 0;`.

(d) Append to the end of the file:

```js
// --- the cached preview (mount's `preview`) ----------------------------------
const settleDecodes = async () => {
  await Promise.allSettled(decodes);
  await Promise.resolve();
};
let previewBytes = null;
const previewFor = async () =>
  (previewBytes ??= await previewGlbFor([boxSoup("body", [0, 0, 0], [4, 4, 4])], makePart(), "main"));
const previewWarnings = (spy) => spy.mock.calls.filter(([m]) => String(m).startsWith("partforge: preview ignored"));

test("a preview is drawn before the kernel is ready, framed once, with previewActive set", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview: await previewFor() });
  expect(runtime.previewActive).toBe(false); // decoding is async
  await settleDecodes();
  const v = fakeViewers[0];
  expect(runtime.previewActive).toBe(true);
  const [name, payload] = v.setSubGeometry.mock.calls[0];
  expect(name).toBe("body");
  expect(payload.positions).toBeInstanceOf(Float32Array);
  expect(payload.triangles).toBe(12);
  expect(v.showAssembly).toHaveBeenLastCalledWith(["body"], { frame: true });
  expect(workers.manifold.postMessage.mock.calls.some(([m]) => m?.type === "generate")).toBe(false);
  let ready = false;
  runtime.ready.then(() => { ready = true; });
  await Promise.resolve();
  expect(ready).toBe(false);
  runtime.dispose();
});

test("the first live build replaces the preview in place and keeps the camera", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview: await previewFor() });
  await settleDecodes();
  const v = fakeViewers[0];
  const cameraPlacements = v.setCameraState.mock.calls.length;
  finishFirstBuild(workers);
  await runtime.ready;
  expect(runtime.previewActive).toBe(false);
  expect(v.setSubGeometry).toHaveBeenLastCalledWith("body", { name: "body" });
  expect(v.showAssembly).toHaveBeenLastCalledWith(["body"], { frame: false });
  expect(v.showAssembly.mock.calls.filter(([, o]) => o?.frame)).toHaveLength(1);
  expect(v.setCameraState.mock.calls.length).toBe(cameraPlacements);
  runtime.dispose();
});

test("picking, hover, measure, sketch and cutaway are held while the preview shows", async () => {
  const { workers, createWorker } = makeWorkers();
  const els = makeElements();
  const runtime = mount(makePart(), {
    createWorker, elements: els, preview: await previewFor(), onPick: vi.fn(), onAnnotationSend: vi.fn(),
  });
  const buttons = [els.chrome.cutaway, els.chrome.measure, els.chrome.annotate];
  const before = buttons.map((b) => b.disabled);
  const suppressed = attachPicker.mock.calls[0][1].suppressed;
  const hover = attachHoverLabels.mock.results[0].value;
  expect(suppressed()).toBe(false);
  await settleDecodes();
  expect(suppressed()).toBe(true);
  expect(hover.setSuppressed).toHaveBeenLastCalledWith(true);
  expect(buttons.map((b) => b.disabled)).toEqual([true, true, true]);
  runtime.measure.setEnabled(true);
  expect(runtime.measure.isEnabled()).toBe(false);
  runtime.annotate.setEnabled(true);
  expect(runtime.annotate.isEnabled()).toBe(false);

  finishFirstBuild(workers);
  expect(suppressed()).toBe(false);
  expect(hover.setSuppressed).toHaveBeenLastCalledWith(false);
  expect(buttons.map((b) => b.disabled)).toEqual(before);
  runtime.measure.setEnabled(true);
  expect(runtime.measure.isEnabled()).toBe(true);
  runtime.dispose();
});

test("a carried cutaway waits for the live build; the carried camera lands at once", async () => {
  const { workers, createWorker } = makeWorkers();
  const viewerState = {
    camera: { pos: [5, 6, 7], target: [0, 0, 0] }, projection: "perspective",
    cutaway: { enabled: true, flipped: false, pose: { position: [0, 0, 1], quaternion: [0, 0, 0, 1] } },
  };
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), viewerState, preview: await previewFor() });
  await settleDecodes();
  const v = fakeViewers[0];
  expect(v.setCameraState).toHaveBeenCalledWith(viewerState.camera);
  expect(v.setCutawayState).not.toHaveBeenCalled();
  finishFirstBuild(workers);
  expect(v.setCutawayState).toHaveBeenCalledWith(viewerState.cutaway);
  runtime.dispose();
});

test("a partial live delivery keeps the preview on for the sub-parts still building", async () => {
  const makeTwoPart = () => ({
    meta: { title: "Two", backend: "manifold" },
    defaults: { h: 4 },
    views: { main: { label: "Main" } },
    parts: {
      a: { label: "A", views: ["main"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] }) },
      b: { label: "B", views: ["main"], build: (k, p) => k.box({ min: [0, 0, p.h], max: [p.h, p.h, 2 * p.h] }) },
    },
    parameters: [{ id: "size", title: "Size", advanced: [{ key: "h", label: "Height", min: 1, max: 10, step: 1 }] }],
  });
  const preview = await previewGlbFor([boxSoup("a", [0, 0, 0], [4, 4, 4]), boxSoup("b", [0, 0, 4], [4, 4, 8])], makeTwoPart());
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makeTwoPart(), { createWorker, elements: makeElements(), preview });
  await settleDecodes();
  const v = fakeViewers[0];
  v.hideAssembly.mockClear();
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "a" }], ms: 1 } });
  expect(runtime.previewActive).toBe(true);
  expect(v.setSubGeometry.mock.calls.filter(([n]) => n === "b")).toHaveLength(1); // still the preview's
  expect(v.hideAssembly).not.toHaveBeenCalled();
  expect(v.showAssembly).toHaveBeenLastCalledWith(["a", "b"], { frame: false });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "b" }], ms: 1 } });
  expect(runtime.previewActive).toBe(false);
  await runtime.ready;
  runtime.dispose();
});

test("a param edit during the preview keeps it on screen and the first build carries the edit", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview: await previewFor() });
  await settleDecodes();
  const v = fakeViewers[0];
  v.hideAssembly.mockClear();
  runtime.setParams({ h: 6 });
  expect(v.hideAssembly).not.toHaveBeenCalled();
  expect(v.showAssembly).toHaveBeenLastCalledWith(["body"], { frame: false });
  expect(runtime.previewActive).toBe(true);
  workers.manifold.onmessage({ data: { type: "ready" } });
  const generate = workers.manifold.postMessage.mock.calls.map(([m]) => m).find((m) => m?.type === "generate");
  expect(generate.params.h).toBe(6);
  runtime.dispose();
});

test("a first-build error leaves the preview on screen and ready rejects", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview: await previewFor() });
  await settleDecodes();
  const v = fakeViewers[0];
  v.hideAssembly.mockClear();
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "error", message: "boom" } });
  await expect(runtime.ready).rejects.toThrow("boom");
  expect(runtime.previewActive).toBe(true);
  expect(v.hideAssembly).not.toHaveBeenCalled();
  runtime.dispose();
});

test("a malformed preview is logged once and ignored", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview: new Uint8Array([1, 2, 3]) });
  await settleDecodes();
  expect(previewWarnings(warn)).toHaveLength(1);
  expect(runtime.previewActive).toBe(false);
  expect(fakeViewers[0].setSubGeometry).not.toHaveBeenCalled();
  finishFirstBuild(workers);
  await expect(runtime.ready).resolves.toBeUndefined();
  runtime.dispose();
  warn.mockRestore();
});

test("a preview for another view is ignored with one warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createWorker } = makeWorkers();
  const preview = await previewGlbFor([boxSoup("body")], makePart(), "side");
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview });
  await settleDecodes();
  expect(previewWarnings(warn)).toHaveLength(1);
  expect(previewWarnings(warn)[0][0]).toMatch(/"side"/);
  expect(runtime.previewActive).toBe(false);
  expect(fakeViewers[0].setSubGeometry).not.toHaveBeenCalled();
  runtime.dispose();
  warn.mockRestore();
});

test("a preview none of whose meshes is a sub-part of the view is ignored, not an error", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createWorker } = makeWorkers();
  const preview = await previewGlbFor([boxSoup("renamed")], null, "main");
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview });
  await settleDecodes();
  expect(previewWarnings(warn)).toHaveLength(1);
  expect(runtime.previewActive).toBe(false);
  runtime.dispose();
  warn.mockRestore();
});

test("a preview that decodes after the first live build, or after dispose, is dropped unseen", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview: await previewFor() });
  finishFirstBuild(workers); // before the decode settles
  await settleDecodes();
  expect(fakeViewers[0].setSubGeometry.mock.calls.map(([, p]) => p)).toEqual([{ name: "body" }]);
  expect(runtime.previewActive).toBe(false);
  runtime.dispose();

  const second = makeWorkers();
  const disposedEarly = mount(makePart(), { createWorker: second.createWorker, elements: makeElements(), preview: await previewFor() });
  disposedEarly.dispose();
  await settleDecodes();
  expect(fakeViewers[1].setSubGeometry).not.toHaveBeenCalled();
});

test("makeHandle reads previewActive live and defaults it to false", () => {
  let active = true;
  const h = makeHandle({ ready: Promise.resolve(), dispose() {}, viewer: {}, setParams() {}, isPreviewActive: () => active });
  expect(h.previewActive).toBe(true);
  active = false;
  expect(h.previewActive).toBe(false);
  expect(makeHandle({ ready: Promise.resolve(), dispose() {}, viewer: {}, setParams() {} }).previewActive).toBe(false);
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run test/framework/mount.test.js`
Expected: the new preview tests FAIL (`previewActive` is `undefined`, `setSubGeometry` never called); every pre-existing test still PASSES.

- [ ] **Step 6: Implement in mount.js**

1. Imports — after `import { attachViewcubeControls } from "./viewcube/viewcube-controls.js";` add:

```js
import { decodePreviewGlb } from "./gltf/decode-preview.js";
import { createPreviewGate } from "./preview-gate.js";
```

2. `makeHandle` — change its parameter list to end `… declaresMaterials, renderViews, isPreviewActive })`, and inside the returned object, directly after `ready, dispose, setParams,` add:

```js
    // Whether the `preview` GLB handed to mount() is on screen (see mount's
    // preview block). A GETTER, read live: a host that copies the handle object
    // freezes the value it had at that moment.
    get previewActive() { return isPreviewActive?.() ?? false; },
```

3. The `mount` signature — change `viewerState,` to `viewerState, preview,`.

4. Directly after

```js
    cleanup.defer(() => ui.setStatus(""));
    cleanup.defer(() => ui.hideBusy());
```

add:

```js
    // A cached preview (the `preview` option) is drawn before the kernel boots and
    // held to the camera only — no feature ids, no live solids behind it — until
    // the first whole live build replaces it. The gate is the flag, plus the
    // chrome it disables meanwhile; picking and hover consult it per event. See
    // the preview block just above `return makeHandle`.
    const previewGate = createPreviewGate({
      buttons: [els.chrome.cutaway, els.chrome.measure, els.chrome.annotate],
    });
```

5. Hover suppression — replace

```js
    const syncHoverSuppression = () =>
      hover.setSuppressed(measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false));
    cleanup.defer(measureMode.onModeChange(syncHoverSuppression));
    if (annotateMode) cleanup.defer(annotateMode.onModeChange(syncHoverSuppression));
```

with

```js
    const syncHoverSuppression = () =>
      hover.setSuppressed(previewGate.isActive() || measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false));
    cleanup.defer(measureMode.onModeChange(syncHoverSuppression));
    if (annotateMode) cleanup.defer(annotateMode.onModeChange(syncHoverSuppression));
    cleanup.defer(previewGate.onChange(syncHoverSuppression));
    // Deferred AFTER the cutaway/measure/annotate chrome attached, so at dispose
    // (LIFO) the gate hands the buttons back before those controls restore the
    // host's own attributes.
    cleanup.defer(() => previewGate.end());
```

6. The picker — replace

```js
        suppressed: () => measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false),
```

with

```js
        suppressed: () => previewGate.isActive() || measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false),
```

7. After `let cameraRestored = false; // saved camera applied once, on the first frame after load` add:

```js
    let cutawayRestored = false; // a carried cutaway, applied once — after any preview, never on one
```

8. Replace the whole `function showView(needed) { … }` with:

```js
    // A carried cutaway goes back on once, and never onto a cached preview: the
    // section needs live solids to cut. `cam` is the pose to place again after
    // it (an ortho face view's size is matched at the surface the cut decides).
    function restoreCarriedCutaway(cam) {
      cutawayRestored = true;
      if (viewerState?.cutaway?.enabled && viewer.setCutawayState?.(viewerState.cutaway)) {
        cutawayChrome.sync(); // the button was not what turned it on
        if (cam) viewer.setCameraState(cam);
      }
    }

    function showView(needed) {
      const frame = view() !== framedView;
      viewer.showAssembly(needed, { frame });
      if (frame) {
        framedView = view();
        if (!cameraRestored) {
          // A carried camera beats the persisted one: it is this session's live
          // answer, where the stored one is the last page-reload's — and it is
          // also the accurate one, since the persisted pose is only written at
          // the end of an orbit drag. An orthographic restore above was made
          // only for a face-view camera, and this is the call that re-arms it.
          const cam = viewerState?.camera ?? loadCamera();
          if (cam) viewer.setCameraState(cam);
          cameraRestored = true;
          // The cutaway goes back on AFTER the camera and only here, on the
          // first accepted build: enabling it needs the sub-parts registered
          // and real bounds to size the plane against, neither of which exists
          // until showAssembly above has run. (Its initial pose also reads the
          // camera direction, so a restore before the camera would seed the
          // fallback pose from the wrong view.) A cached preview defers it to
          // the live build below.
          if (!previewGate.isActive()) restoreCarriedCutaway(cam);
        }
      }
      if (cameraRestored && !cutawayRestored && !previewGate.isActive()) {
        // The preview held the cut back and the live build is in. Re-place the
        // camera the user is looking at NOW — they may have orbited the preview
        // — not the carried one.
        restoreCarriedCutaway(viewer.getCameraState());
      }
    }
```

9. After `const emptySubParts = new Set();` add:

```js
    // Any live delivery has landed. A preview decoded after this is dropped unseen.
    let liveDelivered = false;
```

10. In `refreshView`, replace

```js
      } else if (needed.every((n) => viewer.hasSubMesh(n))) {
        showView(needed); // stale but present — keep it visible during regenerate
        ui.setExportEnabled(false);
      } else {
```

with

```js
      } else if (needed.every((n) => viewer.hasSubMesh(n))) {
        showView(needed); // stale but present — keep it visible during regenerate
        ui.setExportEnabled(false);
      } else if (previewGate.isActive()) {
        // A cached preview that covers only part of the view: show what it has.
        showView(needed.filter((n) => viewer.hasSubMesh(n)));
        ui.setExportEnabled(false);
      } else {
```

11. In `case "meshes": {`, change its first line from `const fresh = loop.buildDone();` to:

```js
          liveDelivered = true;
          const fresh = loop.buildDone();
```

and replace

```js
            recordFrames(data.meshes);
            // A split dispatch answers in two meshes replies; the busy spinner
```

with

```js
            recordFrames(data.meshes);
            // The whole view is live: every sub-part the preview drew has just been
            // replaced in place, so the tools it held back come back. Before
            // refreshView, so showView restores a carried cutaway on this build.
            if (previewGate.isActive() && missingParts().length === 0) previewGate.end();
            // A split dispatch answers in two meshes replies; the busy spinner
```

12. Directly before `return makeHandle({` add:

```js
    // Set by the first cleanup to run at dispose (LIFO): late async work checks it.
    let disposed = false;
    cleanup.defer(() => { disposed = true; });

    // The cached preview: a GLB from partforge/gltf, decoded off the worker path
    // and drawn through setSubGeometry like any delivery — so the first live
    // `meshes` reply replaces it in place, sub-part by sub-part, and showView
    // keeps the camera (the view was already framed). Only a file for the view on
    // screen is drawn, and only its sub-parts of that view; anything else — or a
    // file that will not decode — is logged once and ignored.
    if (preview != null) {
      decodePreviewGlb(preview).then(({ view: previewView, meshes }) => {
        if (disposed || liveDelivered) return; // live geometry always wins
        const current = view();
        if (previewView != null && previewView !== current) {
          console.warn(`partforge: preview ignored — it shows view "${previewView}", the viewer opened on "${current}"`);
          return;
        }
        const needed = viewSubParts(part, current, params);
        const shown = meshes.filter((m) => needed.includes(m.name));
        if (shown.length === 0) {
          console.warn("partforge: preview ignored — none of its meshes is a sub-part of the view on screen");
          return;
        }
        measureMode.setEnabled(false);
        annotateMode?.setEnabled(false);
        previewGate.start();
        for (const m of shown) viewer.setSubGeometry(m.name, m);
        refreshView();
      }).catch((error) => {
        if (!disposed) console.warn(`partforge: preview ignored — ${error?.message ?? error}`);
      });
    }

```

13. In the `makeHandle({ … })` call: add `isPreviewActive: () => previewGate.isActive(),` after `ready, dispose, viewer, setParams,`; in the `measure: { … }` entry replace `setEnabled: measureMode.setEnabled,` with

```js
        // Held off while a cached preview shows (no feature ids to dimension).
        setEnabled: (on) => { if (on && previewGate.isActive()) return; measureMode.setEnabled(on); },
```

and in the `annotate: annotateMode ? { … }` entry replace `setEnabled: annotateMode.setEnabled,` with

```js
        setEnabled: (on) => { if (on && previewGate.isActive()) return; annotateMode.setEnabled(on); },
```

- [ ] **Step 7: Declare it**

In `types/index.d.ts`, `MountOptions`, directly after the `viewerState?: ViewerState | null;` member add:

```ts
  /**
   * A cached preview GLB (from `partforge/gltf`'s `encodePreviewGlb`, or a previous
   * runtime's `exportPreview()`) drawn before the worker is ready and replaced in
   * place, sub-part by sub-part, by the first live build — the camera is kept.
   * Only a file for the view the viewer opens on is drawn, and only meshes named
   * for that view's sub-parts; a file for another view, or one that will not
   * decode, is logged once and ignored. Carries no edge lines.
   */
  preview?: Uint8Array | ArrayBuffer | null;
```

In `PartRuntime`, directly after the `getViewerState(): ViewerState;` member add:

```ts
  /**
   * True while the `preview` GLB is on screen: from the moment it decodes until a
   * build delivers the whole view (a build error leaves it on). Picking, hover
   * labels, measure, sketch and cutaway wait meanwhile; orbit, zoom, pan, the view
   * cube, the view style and the rail work. Read it from the runtime each time —
   * a copy of the handle freezes it.
   */
  readonly previewActive: boolean;
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/framework/preview-gate.test.js test/framework/mount.test.js test/framework/mount-realistic.test.js test/framework/mount-capture-view.test.js test/mount-no-paper.test.js && npm run typecheck`
Expected: all PASS (`mount-no-paper` proves the new imports pull no `paper`); typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/framework/preview-gate.js src/framework/mount.js types/index.d.ts test/framework/preview-gate.test.js test/framework/mount.test.js
git commit -F - <<'EOF'
feat(mount): draw a cached preview GLB before the kernel boots

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 6: `runtime.exportPreview()`

**Files:**
- Modify: `src/framework/mount.js` (`makeHandle` parameters + body; a function before `return makeHandle(`; one `makeHandle` argument)
- Modify: `types/index.d.ts` (`PartRuntime`)
- Modify: `test/framework/mount.test.js` (the fake viewer + appended tests)
- Create: `test/framework/preview-real-viewer.test.js`

**Interfaces:**
- Consumes: `viewer.getSubMeshPayload(name)` (Task 4); `encodePreviewGlb` (Task 2, dynamically imported); `previewGate`, `disposed`, `missingParts`, `view`, `params`, `part` in `mount()`'s scope (Task 5); `decodePreviewGlb`, `boxSoup`, `boundsOf`, `previewGlbFor`.
- Produces: `runtime.exportPreview({ view?: string } = {}) → Promise<Uint8Array>` — rejects with `exportPreview: this mount is disposed` / `exportPreview: a cached preview is showing — wait for the first build` / `exportPreview: "<v>" is not the view on screen ("<cur>")` / `exportPreview: the view on screen is not fully built`. `makeHandle({ …, exportPreview })` whose default rejects with `exportPreview: this mount cannot encode a preview`. Task 7 reuses this test file's harness (`viewers`, `state`, `makeElements`, `makeWorkers`, `makeStage`, `expectNear`).

- [ ] **Step 1: Give the fake viewer the payload hook**

In `test/framework/mount.test.js`'s fake viewer object, directly after `hasSubMesh: (name) => built.has(name),` add:

```js
      // exportPreview's read: one 1mm triangle for every sub-part delivered.
      getSubMeshPayload: vi.fn((name) => (built.has(name) ? {
        name, triangles: 1, indices: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      } : null)),
```

- [ ] **Step 2: Write the failing mount tests**

Append to `test/framework/mount.test.js`:

```js
// --- runtime.exportPreview ---------------------------------------------------
test("exportPreview encodes the view on screen once it is fully built", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  await expect(runtime.exportPreview()).rejects.toThrow(/not fully built/);
  finishFirstBuild(workers);
  const glb = await runtime.exportPreview();
  expect(glb).toBeInstanceOf(Uint8Array);
  expect(fakeViewers[0].getSubMeshPayload).toHaveBeenCalledWith("body");
  const decoded = await decodePreviewGlb(glb);
  expect(decoded.view).toBe("main");
  expect(decoded.meshes.map((m) => m.name)).toEqual(["body"]);
  expect(decoded.meshes[0].triangles).toBe(1);
  await expect(runtime.exportPreview({ view: "main" })).resolves.toBeInstanceOf(Uint8Array);
  await expect(runtime.exportPreview({ view: "side" })).rejects.toThrow(/not the view on screen/);
  runtime.dispose();
  await expect(runtime.exportPreview()).rejects.toThrow(/disposed/);
});

test("exportPreview refuses while a preview is showing or a rebuild is pending", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview: await previewFor() });
  await settleDecodes();
  await expect(runtime.exportPreview()).rejects.toThrow(/preview is showing/);
  finishFirstBuild(workers);
  await expect(runtime.exportPreview()).resolves.toBeInstanceOf(Uint8Array);
  runtime.setParams({ h: 6 }); // the geometry on screen no longer matches the params
  await expect(runtime.exportPreview()).rejects.toThrow(/not fully built/);
  runtime.dispose();
});

test("makeHandle's exportPreview defaults to a rejection", async () => {
  const h = makeHandle({ ready: Promise.resolve(), dispose() {}, viewer: {}, setParams() {} });
  await expect(h.exportPreview()).rejects.toThrow(/cannot encode a preview/);
});
```

- [ ] **Step 3: Write the failing real-viewer tests**

Create `test/framework/preview-real-viewer.test.js`:

```js
// @vitest-environment happy-dom
// The cached preview against the REAL viewer, on a fake WebGLRenderer (the
// mount-realistic.test.js harness): what the user sees across the preview → live
// swap, the pose exportPreview bakes into its file, and (Task 7) mountPreview.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      this.compileAsync = vi.fn(async () => {});
      // The FIRST renderer a test makes is the viewer's own (view-style thumbnails
      // may make more later); beforeEach resets it.
      state.renderer ??= this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    getSize(target) { return target.set(400, 300); }
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    get capabilities() { return { maxTextureSize: 8192, textureTypeReadable: () => true }; }
    setRenderTarget() {}
    getRenderTarget() { return null; }
    getClearAlpha() { return 1; }
    setClearAlpha() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("../../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn(), setSuppressed: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

vi.mock("../../src/framework/pick-request/index.js", async () => ({
  ...(await import("../../src/framework/pick-request/endpoint.js")),
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

// The real viewer, captured so a test can read its meshes and camera.
const viewers = vi.hoisted(() => []);
vi.mock("../../src/framework/viewer.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, createViewer: (...args) => { const v = real.createViewer(...args); viewers.push(v); return v; } };
});

import { mount } from "../../src/framework/mount.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxSoup, boundsOf, previewGlbFor } from "../helpers/preview-glb.js";

const OriginalResizeObserver = globalThis.ResizeObserver;

const expectNear = (got, want, digits = 2) => {
  expect(got).toHaveLength(want.length);
  [...got].forEach((g, i) => expect(g).toBeCloseTo(want[i], digits));
};

const makePart = () => ({
  meta: { title: "Preview Fixture", backend: "manifold" },
  defaults: { h: 4 },
  views: { main: { label: "Main" } },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] }) } },
  parameters: [{ id: "size", title: "Size", advanced: [{ key: "h", label: "Height", min: 1, max: 10, step: 1 }] }],
});

// body is built at the origin and posed 10mm along +X by place(): a rigid,
// geometry-free place(), so the worker delivers it CANONICAL and mount poses it.
const placedPart = () => ({
  ...makePart(),
  parts: { body: { label: "Body", views: ["main"],
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] }),
    place: (s) => s.translate([10, 0, 0]) } },
});

function makeStage() {
  const stage = document.createElement("div");
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  document.body.append(stage);
  return stage;
}

function makeElements() {
  const mk = (tag = "div") => document.createElement(tag);
  const els = {
    viewer: makeStage(), controls: mk(), rail: mk(),
    status: { status: mk(), busy: mk(), phase: mk() },
    tabs: mk(),
    exports: { stl: mk("button"), step: mk("button"), threeMf: mk("button") },
    chrome: { reframe: mk("button"), theme: mk("button"), cutaway: mk("button"), railToggle: mk("button") },
  };
  document.body.append(els.controls, els.rail, els.tabs);
  return els;
}

function makeWorkers() {
  const workers = {};
  const createWorker = (name) => {
    const w = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
    workers[name] = w;
    return w;
  };
  return { workers, createWorker };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  viewers.length = 0;
  state.renderer = null;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the preview shows on the real viewer, and the swap keeps the camera the user moved to", async () => {
  const preview = await previewGlbFor([boxSoup("body", [0, 0, 0], [4, 4, 4])], makePart(), "main");
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview });
  await vi.waitFor(() => expect(runtime.previewActive).toBe(true));
  const v = viewers[0];
  expect(v.__subMesh("body").visible).toBe(true);
  expect(v.subTriangles("body")).toBe(12);

  v.setCameraState({ pos: [30, 20, 10], target: [1, 2, 3] }); // the user orbits the preview
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [boxSoup("body", [0, 0, 0], [4, 4, 4])] } });
  await runtime.ready;

  expect(runtime.previewActive).toBe(false);
  const cam = runtime.getViewerState().camera;
  expectNear(cam.pos, [30, 20, 10], 4);
  expectNear(cam.target, [1, 2, 3], 4);
  runtime.dispose();
});

test("exportPreview bakes a canonical sub-part's place() pose into the file", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(placedPart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [
    { ...boxSoup("body", [0, 0, 0], [1, 1, 1]), reads: ["h"], frame: "canonical" },
  ] } });
  await runtime.ready;
  // Precondition: mount posed the canonical delivery by MATRIX, not in the geometry.
  expect(viewers[0].__subMesh("body").matrix.elements[12]).toBeCloseTo(10, 6);

  const out = await decodePreviewGlb(await runtime.exportPreview());
  expect(out.view).toBe("main");
  const { min, max } = boundsOf(out.meshes[0].positions);
  expectNear(min, [10, 0, 0]);
  expectNear(max, [11, 1, 1]);
  runtime.dispose();
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/framework/mount.test.js test/framework/preview-real-viewer.test.js`
Expected: the three exportPreview tests in mount.test.js and the second real-viewer test FAIL with "runtime.exportPreview is not a function"; the real-viewer swap test PASSES already (Task 5).

- [ ] **Step 5: Implement**

In `src/framework/mount.js`:

1. `makeHandle`'s parameter list ends `… renderViews, isPreviewActive, exportPreview })`; in its returned object, after the `get previewActive()` getter add:

```js
    // The view on screen as a preview GLB (partforge/gltf), poses baked in.
    exportPreview: exportPreview ?? (() => Promise.reject(new Error("exportPreview: this mount cannot encode a preview"))),
```

2. Directly before `return makeHandle({` (after the preview block from Task 5) add:

```js
    // runtime.exportPreview: the view on screen as a preview GLB — every sub-part's
    // drawn mesh with its fast-path pose baked in, the posed meshes a headless
    // buildView returns. Only the view on screen (no other view's meshes are held),
    // only when it is fully built at the live params (missingParts covers both a
    // first build and an edit still rebuilding), never a cached preview. The
    // encoder loads on first use: a host that never exports never pays for it.
    async function exportPreview({ view: wanted } = {}) {
      if (disposed) throw new Error("exportPreview: this mount is disposed");
      if (previewGate.isActive()) throw new Error("exportPreview: a cached preview is showing — wait for the first build");
      const current = view();
      if (wanted != null && wanted !== current) {
        throw new Error(`exportPreview: "${wanted}" is not the view on screen ("${current}")`);
      }
      const needed = viewSubParts(part, current, params);
      if (needed.length === 0 || missingParts().length > 0) {
        throw new Error("exportPreview: the view on screen is not fully built");
      }
      const meshes = needed.map((name) => viewer.getSubMeshPayload(name)).filter(Boolean);
      const { encodePreviewGlb } = await import("./gltf/encode-preview.js");
      return encodePreviewGlb({ meshes, part, view: current });
    }

```

3. In the `makeHandle({ … })` call, after `isPreviewActive: () => previewGate.isActive(),` add `exportPreview,`.

4. Embedding-contract comment: after the line `//   runtime.dispose();     // full teardown` insert:

```js
//   runtime.previewActive  // true while the `preview` GLB is on screen (decoded, not yet
//                          // replaced by a whole live build): picking, hover labels,
//                          // measure, sketch and cutaway wait; orbit, the view cube,
//                          // the view style and the rail work
//   await runtime.exportPreview();  // the view on screen as a preview GLB (Uint8Array,
//                          // partforge/gltf), fast-path poses baked in. Rejects while
//                          // previewActive, before the view is fully built (a pending
//                          // rebuild counts), for a view other than the one on screen,
//                          // and after dispose
```

and directly before the line `// panelState: PanelState                 // a previous mount's runtime.getPanelState(): the transient` insert:

```js
// preview: Uint8Array | ArrayBuffer      // a GLB from encodePreviewGlb / exportPreview, drawn before
//                                         // the worker is ready and replaced sub-part by sub-part by
//                                         // the first live build, camera kept. Only a file for the view
//                                         // on screen is drawn, and only its sub-parts of that view; a
//                                         // file for another view, or one that will not decode, is
//                                         // logged once and ignored.
```

and replace the contract's opening two lines

```js
// Embedding contract (0.141.0: a place()-able sub-part is delivered in its
// canonical frame and posed by the viewer; pose-only edits never rebuild):
```

with

```js
// Embedding contract (0.147.0: a cached `preview` GLB is drawn before the kernel
// boots and swapped in place by the first build; 0.141.0: a place()-able sub-part
// is delivered in its canonical frame and posed by the viewer; pose-only edits
// never rebuild):
```

5. In `types/index.d.ts`, `PartRuntime`, after the `readonly previewActive: boolean;` member add:

```ts
  /**
   * The view on screen as a preview GLB (`partforge/gltf`'s format), every
   * sub-part posed exactly as drawn — what a later `mount({ preview })` shows
   * before its kernel boots. Rejects while `previewActive`, before the view is
   * fully built at the current params (a pending rebuild counts), for a `view`
   * other than the one on screen, and after `dispose()`.
   */
  exportPreview(opts?: { view?: string }): Promise<Uint8Array>;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/framework/mount.test.js test/framework/preview-real-viewer.test.js test/export-select.test.js && npm run typecheck`
Expected: all PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/framework/mount.js types/index.d.ts test/framework/mount.test.js test/framework/preview-real-viewer.test.js
git commit -F - <<'EOF'
feat(mount): exportPreview encodes the view on screen as a preview GLB

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 7: `mountPreview` — the kernel-free viewer

**Files:**
- Create: `src/framework/viewbar-clear.js`, `src/framework/mount-preview.js`
- Modify: `src/framework/mount.js` (the `stageClearFor` import at line 42; the viewbar-clear block ~lines 754-772), `src/index.js`, `types/index.d.ts`
- Test: `test/framework/preview-real-viewer.test.js` (add an import, append tests); `test/types-surface.test.js`, `test/framework/mount.test.js` (existing, must stay green)

**Interfaces:**
- Consumes: `decodePreviewGlb` (Task 3; its `{ view, meta, meshes[].display }`); `createViewer`, `attachViewerControls`, `attachViewcubeControls`, `attachViewStyleControls`, `createTooltipPresenter`, `isFaceAlignedState`, `ENVIRONMENTS`; the Task 6 test harness.
- Produces:
  - `observeViewbarClear(stage, viewbar) → () => void` (publishes `--pf-viewbar-clear`; no-op without a bar or `ResizeObserver`).
  - `mountPreview(container, { glb, elements?: { chrome?: { reframe?, theme? } }, viewerState? }) → PreviewRuntime` with exactly: `ready: Promise<void>`, `dispose()`, `getView(): string | null`, `getViewerState(): ViewerState`, `setViewerState(state | null)`, `setActive(active)`, `onContextLost(listener) → unsubscribe`, `setHostPane(pane)` (no-op), `setRailLayout(layout)` (no-op), `renderMode: { get, set, onChange }`, `environment: { get, set, onChange, list }`. `ready` rejects when the GLB will not decode or holds no meshes; resolves (drawing nothing) when disposed first.

- [ ] **Step 1: Write the failing tests**

In `test/framework/preview-real-viewer.test.js`, add to the imports:

```js
import { mountPreview } from "../../src/framework/mount-preview.js";
```

and append:

```js
// --- mountPreview: the kernel-free viewer --------------------------------------
const previewPart = { parts: { body: { display: { color: 0xff0000 } } } };
let glbBytes = null;
const glb = async () => (glbBytes ??= await previewGlbFor([boxSoup("body", [0, 0, 0], [4, 4, 4])], previewPart, "main"));

test("mountPreview draws the GLB with no worker, framed, in the part's own look", async () => {
  const Worker = vi.fn();
  vi.stubGlobal("Worker", Worker);
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await glb() });
  await handle.ready;
  const v = viewers.at(-1);
  expect(stage.contains(v.domElement)).toBe(true);
  expect(v.hasSubMesh("body")).toBe(true);
  expect(v.__subMesh("body").visible).toBe(true);
  expect(v.__subMesh("body").material.color.getHex()).toBe(0xff0000);
  expect(handle.getView()).toBe("main");
  expect(Worker).not.toHaveBeenCalled();
  handle.dispose();
  expect(stage.contains(v.domElement)).toBe(false);
  expect(stage.querySelector("canvas")).toBeNull(); // the view cube went with it
  expect(() => handle.dispose()).not.toThrow();
});

test("mountPreview carries viewer state in and out", async () => {
  const handle = mountPreview(makeStage(), {
    glb: await glb(), viewerState: { camera: { pos: [40, 0, 0], target: [0, 0, 0] }, projection: "perspective", cutaway: null },
  });
  await handle.ready;
  expectNear(handle.getViewerState().camera.pos, [40, 0, 0], 4);
  handle.setViewerState({ camera: { pos: [0, 50, 0], target: [1, 1, 1] }, projection: "perspective", cutaway: null });
  const s = handle.getViewerState();
  expect(s).toMatchObject({ projection: "perspective", cutaway: null, renderMode: "cad" });
  expectNear(s.camera.pos, [0, 50, 0], 4);
  expectNear(s.camera.target, [1, 1, 1], 4);
  handle.dispose();
});

test("a GLB that will not decode rejects ready and leaves the container untouched", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: new Uint8Array([1, 2, 3]) });
  await expect(handle.ready).rejects.toThrow();
  expect(stage.children).toHaveLength(0);
  expect(viewers).toHaveLength(0);
  expect(handle.getView()).toBeNull();
  expect(() => handle.dispose()).not.toThrow();
});

test("dispose before the GLB decodes means nothing is ever drawn", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await glb() });
  handle.dispose();
  await handle.ready;
  expect(viewers).toHaveLength(0);
  expect(stage.children).toHaveLength(0);
});

test("the sticky hooks a host relays are safe, before and after the decode", async () => {
  const handle = mountPreview(makeStage(), { glb: await glb() });
  handle.setActive(false); // remembered until the viewer exists
  handle.setHostPane("rail");
  handle.setRailLayout({ mode: "overlay" });
  const lost = vi.fn();
  handle.onContextLost(lost);
  await handle.ready;
  expect(state.renderer.animationLoop).toBeNull(); // parked
  handle.setActive(true);
  expect(typeof state.renderer.animationLoop).toBe("function");
  expect(await handle.renderMode.set("cad")).toBe("cad");
  expect(handle.renderMode.get()).toBe("cad");
  expect(handle.environment.list().map((e) => e.id)).toContain("studio");
  handle.dispose();
});

test("mountPreview requires a container", () => {
  expect(() => mountPreview(null, { glb: new Uint8Array(0) })).toThrow(TypeError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/preview-real-viewer.test.js`
Expected: FAIL — cannot resolve `../../src/framework/mount-preview.js`.

- [ ] **Step 3: Move the viewbar-clear publisher out of mount.js**

Create `src/framework/viewbar-clear.js`:

```js
// Publish the viewbar's vertical claim as --pf-viewbar-clear on the stage, so
// chrome.css can stack the view cube on top of it without hardcoding a height
// that cutaway/measure/annotate action rows can change. A hidden bar (ours or a
// host stylesheet's) claims 0 — stage-clear.js has the why; the observer fires
// on the hide itself, since the bar's box goes to zero. Shared by mount() and
// mountPreview(). Returns a dispose; a no-op without a bar or a ResizeObserver.
import { stageClearFor } from "./stage-clear.js";

export function observeViewbarClear(stage, viewbar) {
  if (!viewbar || typeof ResizeObserver !== "function") return () => {};
  const publish = () => {
    const clear = stageClearFor(stage.getBoundingClientRect(), viewbar.getBoundingClientRect());
    stage.style.setProperty("--pf-viewbar-clear", `${clear}px`);
  };
  const observer = new ResizeObserver(publish);
  observer.observe(viewbar);
  observer.observe(stage);
  publish();
  return () => {
    observer.disconnect();
    stage.style.removeProperty("--pf-viewbar-clear");
  };
}
```

In `src/framework/mount.js`, replace `import { stageClearFor } from "./stage-clear.js";` with `import { observeViewbarClear } from "./viewbar-clear.js";`, and replace

```js
    const viewbarEl = els.viewer.querySelector("#viewbar");
    if (viewbarEl && typeof ResizeObserver === "function") {
      const publishViewbarClear = () => {
        const clear = stageClearFor(els.viewer.getBoundingClientRect(), viewbarEl.getBoundingClientRect());
        els.viewer.style.setProperty("--pf-viewbar-clear", `${clear}px`);
      };
      const viewbarObserver = new ResizeObserver(publishViewbarClear);
      viewbarObserver.observe(viewbarEl);
      viewbarObserver.observe(els.viewer);
      publishViewbarClear();
      cleanup.defer(() => {
        viewbarObserver.disconnect();
        els.viewer.style.removeProperty("--pf-viewbar-clear");
      });
    }
```

with

```js
    cleanup.defer(observeViewbarClear(els.viewer, els.viewer.querySelector("#viewbar")));
```

(keep the comment above it).

Run: `npx vitest run test/framework/mount.test.js test/framework/stage-clear.test.js` — Expected: PASS (a pure move).

- [ ] **Step 4: Write mountPreview**

Create `src/framework/mount-preview.js`:

```js
// mountPreview: the kernel-free viewer. A cached preview GLB (partforge/gltf) in
// the SAME viewer mount() uses — scene, camera, lights, materials, the view cube,
// the view style and the theme — with no part source, no worker, no rail, no
// export and no picking. For a page that only shows a model (partforge-cloud's
// public forge page).
//
// createViewer needs a part's sub-part names at construction, so the viewer is
// built once the GLB has decoded, from a synthetic part: one sub-part per glTF
// mesh, carrying the `display` block the writer stored beside it (the exact CAD
// look, and realistic mode too), and the file's background/environment meta.
// Hence `ready`. Every handle method is safe before it resolves.
import "./app.css";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { attachViewcubeControls } from "./viewcube/viewcube-controls.js";
import { attachViewStyleControls } from "./view-style-controls.js";
import { observeViewbarClear } from "./viewbar-clear.js";
import { createTooltipPresenter } from "./tooltip.js";
import { isFaceAlignedState } from "./projection.js";
import { ENVIRONMENTS } from "./materials/environments.js";
import { decodePreviewGlb } from "./gltf/decode-preview.js";

function previewPart({ meshes, view, meta }) {
  return {
    meta: { title: "Preview", ...(meta ?? {}) },
    defaults: {},
    parameters: [],
    views: { [view]: { label: view } },
    parts: Object.fromEntries(meshes.map((m) => [m.name, {
      label: m.name,
      views: [view],
      ...(m.display ? { display: m.display } : {}),
    }])),
  };
}

const relay = (listeners) => (event) => {
  for (const cb of [...listeners]) {
    try { cb(event); } catch (error) { console.warn("partforge: preview listener failed", error); }
  }
};

export function mountPreview(container, { glb, elements = {}, viewerState = null } = {}) {
  if (!container) throw new TypeError("mountPreview: a container element is required");
  let disposed = false;
  let active = true;
  let carried = viewerState ?? null; // applied once the viewer exists, and on every setViewerState
  let live = null;                   // { viewer, view } once the GLB has decoded
  const cleanups = [];
  const modeListeners = new Set();
  const envListeners = new Set();
  const lostListeners = new Set();

  // Same precedence mount() uses: projection first (orthographic only for a
  // face-view camera), then the camera, then environment and render mode.
  function applyState(s) {
    if (!s || !live) return;
    const { viewer } = live;
    viewer.setProjection(s.projection === "orthographic" && isFaceAlignedState(s.camera) ? "orthographic" : "perspective");
    if (s.camera) viewer.setCameraState(s.camera);
    if (typeof s.environment === "string") viewer.setEnvironment(s.environment);
    if ((s.renderMode === "cad" || s.renderMode === "realistic") && s.renderMode !== viewer.getRenderMode()) {
      viewer.setRenderMode(s.renderMode);
    }
  }

  const ready = decodePreviewGlb(glb).then((decoded) => {
    if (disposed) return;
    if (decoded.meshes.length === 0) throw new Error("mountPreview: the preview holds no meshes");
    const view = decoded.view ?? "preview";
    const viewer = createViewer(container, previewPart({ ...decoded, view }));
    cleanups.push(() => viewer.dispose());
    const tooltip = createTooltipPresenter({ id: null });
    cleanups.push(() => tooltip.dispose());
    const viewcube = attachViewcubeControls(viewer, { stage: container });
    cleanups.push(() => viewcube.detach());
    const toolbar = container.querySelector("#viewbar");
    const viewStyle = attachViewStyleControls(viewer, { stage: container, toolbar, anchor: viewcube.element }, { tooltip });
    cleanups.push(() => viewStyle.detach());
    cleanups.push(observeViewbarClear(container, toolbar));
    const chrome = attachViewerControls(viewer, elements.chrome ?? {}, { tooltip });
    cleanups.push(() => chrome.detach());
    cleanups.push(viewer.onRenderModeChange(relay(modeListeners)));
    cleanups.push(viewer.onEnvironmentChange(relay(envListeners)));
    cleanups.push(viewer.onContextLost(relay(lostListeners)));
    for (const m of decoded.meshes) viewer.setSubGeometry(m.name, m);
    viewer.showAssembly(decoded.meshes.map((m) => m.name), { frame: true });
    live = { viewer, view };
    applyState(carried);
    if (!active) viewer.setActive(false);
  });
  ready.catch(() => {}); // the host awaits it; never an unhandled rejection

  function getViewerState() {
    if (!live) return carried ?? { camera: null, projection: "perspective", cutaway: null, renderMode: "cad" };
    const v = live.viewer;
    return {
      camera: v.getCameraState(),
      projection: v.getProjection?.() ?? "perspective",
      cutaway: null, // a preview has no live solid to section
      renderMode: v.isRealisticPending?.() ? "realistic" : v.getRenderMode?.() ?? "cad",
      ...(v.isEnvironmentChosen?.() ? { environment: v.getEnvironment() } : {}),
    };
  }

  // A method that needs the viewer waits for it; a failed decode answers the default.
  const whenLive = async (fn, fallback) => {
    try { await ready; } catch { return fallback; }
    return live ? fn(live.viewer) : fallback;
  };

  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      live = null;
      const errors = [];
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "partforge mountPreview cleanup failed");
    },
    getView: () => live?.view ?? null,
    getViewerState,
    setViewerState(next) {
      carried = next ?? null;
      applyState(carried);
    },
    setActive(next) {
      active = next !== false;
      live?.viewer.setActive(active);
    },
    onContextLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    // No rail to place or pick: accepted so a host relaying mount()'s sticky state
    // can send it here unchanged.
    setHostPane: () => {},
    setRailLayout: () => {},
    renderMode: {
      get: () => live?.viewer.getRenderMode() ?? "cad",
      set: (mode) => whenLive((v) => v.setRenderMode(mode), "cad"),
      onChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    },
    environment: {
      get: () => live?.viewer.getEnvironment() ?? "studio",
      set: (id) => whenLive((v) => v.setEnvironment(id), "studio"),
      onChange: (cb) => { envListeners.add(cb); return () => envListeners.delete(cb); },
      list: () => Object.values(ENVIRONMENTS).map(({ id, label }) => ({ id, label })),
    },
  };
}
```

In `src/index.js`, after the `mount` export add:

```js
// The kernel-free viewer for a cached preview GLB (partforge/gltf): no part, no worker.
export { mountPreview } from "./framework/mount-preview.js";
```

- [ ] **Step 5: Declare it**

In `types/index.d.ts`, after `export function mount(part: PartDefinition, options: MountOptions): PartRuntime;` add:

```ts
/** Options for `mountPreview`. */
export interface MountPreviewOptions {
  /** A GLB from `partforge/gltf`'s `encodePreviewGlb`, or a runtime's `exportPreview()`. */
  glb: Uint8Array | ArrayBuffer;
  /** Optional viewer buttons, wired as `mount()` wires them; `#viewbar` inside the container is found by id. */
  elements?: { chrome?: { reframe?: HTMLElement | null; theme?: HTMLElement | null } };
  /** A previous runtime's `getViewerState()`; `cutaway` is ignored (a preview has no live solid). */
  viewerState?: ViewerState | null;
}

/** The handle `mountPreview()` returns. Every method is safe before `ready` settles. */
export interface PreviewRuntime {
  /** Resolves once the GLB is drawn; rejects when it will not decode or holds no meshes. */
  ready: Promise<void>;
  /** Full teardown. Idempotent. */
  dispose(): void;
  /** The view the file was written for (`null` until drawn, or when the file names none). */
  getView(): string | null;
  /** Camera, projection, render mode and environment; `cutaway` is always `null`. */
  getViewerState(): ViewerState;
  /** Apply a state (camera, projection, render mode, environment) now, or once drawn. */
  setViewerState(state: ViewerState | null): void;
  /** Park/unpark the viewer, as `PartRuntime.setActive`. */
  setActive(active: boolean): void;
  /** WebGL context loss. Returns an unsubscribe. */
  onContextLost(listener: () => void): () => void;
  /** Accepted and ignored — there is no rail. */
  setHostPane(pane: HostPane): void;
  /** Accepted and ignored — there is no rail. */
  setRailLayout(layout: HostRailLayout): void;
  renderMode: {
    get(): RenderMode;
    set(mode: RenderMode): Promise<RenderMode>;
    onChange(cb: (e: RenderModeEvent) => void): () => void;
  };
  environment: {
    get(): string;
    set(id: string): Promise<string>;
    onChange(cb: (id: string) => void): () => void;
    list(): Array<{ id: string; label: string }>;
  };
}

/** A kernel-free viewer for a cached preview GLB: the viewer, view cube, view style and theme — no part, no worker, no rail. */
export function mountPreview(container: HTMLElement, options: MountPreviewOptions): PreviewRuntime;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/framework/preview-real-viewer.test.js test/framework/mount.test.js test/framework/mount-realistic.test.js test/types-surface.test.js test/mount-no-paper.test.js && npm run typecheck`
Expected: all PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/framework/viewbar-clear.js src/framework/mount-preview.js src/framework/mount.js src/index.js types/index.d.ts test/framework/preview-real-viewer.test.js
git commit -F - <<'EOF'
feat: mountPreview, a kernel-free viewer for cached preview GLBs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 8: Version, docs, type tests and the full gates

**Files:**
- Modify: `package.json`, `package-lock.json` (version 0.147.0), `README.md` (Embedding section), `AGENTS.md` (Architecture list), `test/partforge.test-d.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the 0.147.0 release candidate.

- [ ] **Step 1: Write the type-level tests (failing until the declarations resolve)**

In `test/partforge.test-d.ts`, change the first import line to:

```ts
import { mount, mountPreview, resolveDefaultView, EXPORT_FORMATS, KIT_OPTIONS_ERROR, KIT_DEFAULTS, validateKitOptions } from "partforge";
```

add `PreviewRuntime,` to the `import type { … } from "partforge";` list, add below the `partforge/worker` import:

```ts
import { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "partforge/gltf";
```

and directly after `expectType<() => void>(runtime.onContextLost(() => {}));` add:

```ts
// The cached preview (0.147.0).
expectType<boolean>(runtime.previewActive);
// @ts-expect-error - previewActive is read-only
runtime.previewActive = true;
expectType<Promise<Uint8Array>>(runtime.exportPreview());
expectType<Promise<Uint8Array>>(runtime.exportPreview({ view: "main" }));
expectType<PartRuntime>(mount(spacer, { ...options, preview: new Uint8Array(0) }));
const previewRuntime: PreviewRuntime = mountPreview(document.body, { glb: new Uint8Array(0) });
expectType<Promise<void>>(previewRuntime.ready);
expectType<string | null>(previewRuntime.getView());
expectType<void>(previewRuntime.setHostPane("rail"));
expectType<string | null>(resolveDefaultView(spacer));
expectType<number>(PREVIEW_ENCODER_VERSION);
expectType<Promise<Uint8Array>>(encodePreviewGlb({ meshes: [{ name: "a", positions: new Float32Array(9) }], part: spacer, view: "main" }));
// @ts-expect-error - meshes are required
encodePreviewGlb({ view: "main" });
```

Run: `npm run typecheck`
Expected: exits 0 (Tasks 1–7 already declared everything; a failure here names the declaration to fix).

- [ ] **Step 2: Bump the version**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
npm version 0.147.0 --no-git-tag-version
grep -n '"version": "0.147.0"' package.json package-lock.json
```

Expected: three matches (package.json; package-lock.json's top-level and `packages[""]`).

- [ ] **Step 3: Document it**

In `README.md`, insert directly before the paragraph that begins "Every `elements` entry defaults to the legacy global ID":

````md
**Show a cached preview while the kernel boots (0.147.0+).** `partforge/gltf`'s
`encodePreviewGlb({ meshes, part, view })` writes one view's posed display
meshes as a small GLB — welded, quantized and meshopt-compressed, one node per
sub-part, Y-up, millimetres — in Node, a page or a worker, and
`runtime.exportPreview()` encodes the view on screen with it. Hand the file back
as `mount()`'s `preview` and the viewer draws it before the worker is ready, then
swaps each sub-part for the live build in place without re-framing;
`runtime.previewActive` is true in between, while picking, measure, sketch and
cutaway wait for the live build. A file for another view, or one that will not
decode, is logged and ignored. `mountPreview(container, { glb, elements,
viewerState })` is the kernel-free form — the same viewer, view cube, view style
and theme, with no part, no worker and no rail — for a page that only shows a
model. Previews carry no edge lines, textures or patterns.
`resolveDefaultView(part)` (main entry and `partforge/testing`) names the view
`mount()` opens on, so a preview built headlessly matches it.

```js
const glb = await runtime.exportPreview();               // Uint8Array: the view on screen
mount(part, { createWorker, elements, preview: glb });   // drawn at once, replaced by the build
const shown = mountPreview(stage, { glb });              // no kernel at all
await shown.ready;
```

````

In `AGENTS.md`, insert directly before the line that begins "- **`src/framework/sheet/`** + **`src/framework/process/`**":

```md
- **`src/framework/gltf/`** + **`src/framework/mount-preview.js`** - the cached
  preview (0.147.0). `gltf/encode-preview.js` is `partforge/gltf`'s writer: one
  view's POSED meshes as a GLB (one node/mesh/primitive per sub-part under a
  single −90°-about-X root, materials from `cadAppearance`, the sub-part's
  `display` block in node extras, then weld → quantize → meshopt "medium"). It is
  worker-safe — no three.js, no DOM, no Blob (`test/gltf-layering.test.js`) — and
  deterministic; bump `PREVIEW_ENCODER_VERSION` whenever its bytes change, since
  downstream caches key on it. `gltf/decode-preview.js` reads one back with
  three's GLTFLoader + MeshoptDecoder into the viewer's ordinary mesh payloads in
  the Z-up model frame — NOT a scene graph under the pivot, which would rotate
  the part twice — so `mount({ preview })` draws it through `setSubGeometry` and
  the first whole live delivery replaces it in place (`preview-gate.js` holds
  picking/hover/measure/sketch/cutaway off meanwhile, and a carried cutaway waits
  for the live build). `runtime.exportPreview()` encodes the view on screen via
  `viewer.getSubMeshPayload` (fast-path poses baked in) and loads the encoder
  lazily, so the app bundle does not carry `@gltf-transform`. `mountPreview` is
  the same viewer with a synthetic part built from the GLB's own node names — no
  worker, no rail.
```

- [ ] **Step 4: Run every gate**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
npm test
npm run lint
npm run lint:dead
npm run typecheck
```

Expected: all four exit 0. If `lint:dead` reports a new unused export or file, it names it — every module added here is reached from an entry (`src/gltf.js`, `src/index.js`) or a test; fix the reach rather than adding an ignore. If Playwright's Chromium is installed, also run `npm run check` (the smoke boot) and expect it to pass unchanged — nothing here alters a demo page's mount.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md AGENTS.md test/partforge.test-d.ts
git commit -F - <<'EOF'
chore: release 0.147.0 — cached preview GLB, mountPreview, exportPreview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Self-review notes (for the executor)

- **Spec 1a** (writer) → Task 2. **1b** (`mount({preview})`, `previewActive`, held tools, swap keeps camera, malformed ignored) → Task 5; `mountPreview` → Task 7. **1c** (`exportPreview`) → Tasks 4 + 6; `resolveDefaultView` → Task 1. Version → Task 8. The cloud's version-floor line and prompt regeneration happen in partforge-cloud after this publishes.
- **Deliberate departures from the contract as first written**, each recorded in code comments:
  1. `resolveDefaultView` keeps its real signature `(part)` (`src/framework/default-view.js:33`): it reads `part.defaults`; a second `params` argument would be ignored.
  2. The decoded preview is NOT parented under the viewer's pivot: the pivot already rotates −90° about X (`src/framework/viewer.js:262-263`), so the GLB's root rotation would compound to −180°. The decoder undoes the root rotation and feeds model-frame payloads through `setSubGeometry`.
  3. `mount()` can only draw meshes named for sub-parts of the view on screen — the viewer allocates one mesh slot per `part.parts` key at construction (`viewer.js:161`, `:277-284`). Unknown names are dropped (one warning if none match); a file whose `partforgeView` differs from the view on screen is ignored. `mountPreview` builds its part from the file, so it shows every mesh.
  4. The view name lives in the file's top-level `extras` (three exposes them as `gltf.userData`) and the scene name, not `asset.extras`.
  5. `mountPreview` returns `ready` (decoding is async and `createViewer` needs the names first) and the subset of mount's sticky surface that applies without a part: `setActive`, `onContextLost`, `renderMode`, `environment`, plus no-op `setHostPane`/`setRailLayout`. mount's handle has no `setTheme`/`setViewerActive`/`setAppearance` (those are partforge-cloud relay names); theme is the persisted `partforge:theme` plus `elements.chrome.theme`.
  6. `exportPreview({ view })` can only encode the view on screen.

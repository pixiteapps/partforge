// Boots the Manifold WASM module in a Node process and returns a ready Manifold
// GeometryKernel — the one-call mirror of bootOcctKernel. (OCCT must NOT be booted
// in the same process — they crash together.)
import Module from "manifold-3d";
import { createManifoldKernel } from "../framework/geometry/manifold-backend.js";
import { resolveFonts } from "../framework/fonts.js";
import { normalizeOpentype, parseFont } from "../framework/geometry/opentype-interop.js";
import { ensureImports } from "../framework/imports.js";
import { ensureImages } from "../framework/images.js";
import { ensureVectors } from "../framework/vectors.js";
import { nodeAssetSources } from "./assets.js";
import { tessellateStepAssets } from "./step-mesh.js";

export async function bootManifoldKernel({ quality = "preview", fonts, imports, importMeshes, images, vectors } = {}) {
  const wasm = await Module();
  wasm.setup();
  const kernel = createManifoldKernel(wasm, { quality });
  if (fonts) { const opentype = normalizeOpentype(await import("opentype.js"));
    for (const [name, buf] of await resolveFonts(nodeAssetSources(fonts))) kernel._fonts.set(name, parseFont(opentype, buf, name)); }
  if (imports) {
    const decl = nodeAssetSources(imports);
    const { resolveImports } = await import("../framework/imports.js");
    const resolved = await resolveImports(decl);
    const stepEntries = [...resolved].filter(([, a]) => a.format === "step")
      .map(([name, a]) => ({ name, bytes: a.bytes, digest: a.digest }));
    const meshes = importMeshes ?? (stepEntries.length ? await tessellateStepAssets(stepEntries) : null);
    await ensureImports(kernel, decl, meshes);
  }
  // Third asset sibling: register declared images the same way as fonts/imports
  // above, so a part using `k.heightfield` builds headlessly instead of hitting
  // `heightfield: unknown image "…"` — file: sources need the same Node mapping
  // (global fetch can't read them) that fonts/imports get from nodeAssetSources.
  if (images && Object.keys(images).length) await ensureImages(kernel, nodeAssetSources(images));
  if (vectors) await ensureVectors(kernel, nodeAssetSources(vectors));
  return kernel;
}

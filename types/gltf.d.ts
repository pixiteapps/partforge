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

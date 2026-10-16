// partforge/gltf — the cached-preview writer. Worker-safe: no three.js, no DOM.

import type { SubPartDefinition } from "./part.js";

/** The slice of a part `encodePreviewGlb` reads; any `PartDefinition` satisfies it, so does a plain object. */
export interface PreviewPart {
  parts?: Record<string, { display?: SubPartDisplay }>;
  meta?: { background?: number; environment?: string };
}

type SubPartDisplay = NonNullable<SubPartDefinition["display"]>;

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
  /**
   * Feature-edge segments, endpoint pairs `[x0,y0,z0, x1,y1,z1, …]` in the same posed
   * frame as `positions` (encoder version 2+). Written as a LINES primitive on the
   * sub-part's mesh. Empty or absent writes none, and decodes as "no feature edges".
   */
  edges?: Float32Array | null;
}

export interface EncodePreviewInput {
  /** At least one; a zero-length mesh gets no node. */
  meshes: PreviewMesh[];
  /** Read for `parts[name].display` (materials) and `meta.background` / `meta.environment`. */
  part?: PreviewPart | null;
  /** The view these meshes show; names the scene and lands in the file's extras as `partforgeView`. */
  view?: string | null;
}

/** Bumped whenever the encoder writes different bytes for the same input (2: feature edges). */
export const PREVIEW_ENCODER_VERSION: number;

/** Encode one view's posed meshes as a welded, quantized, meshopt-compressed GLB (Y-up, millimetres). Deterministic. */
export function encodePreviewGlb(input: EncodePreviewInput): Promise<Uint8Array>;

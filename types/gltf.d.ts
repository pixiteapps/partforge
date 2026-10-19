// partforge/gltf — the cached-preview writer. Worker-safe: no three.js, no DOM.

import type { SubPartDefinition } from "./part.js";
import type { PreviewAnimationInput } from "./oracle.js";

export type { PreviewAnimationInput };

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
   * sub-part's mesh — since version 3, indices into the surface's own POSITION
   * accessor (each endpoint snapped to the surface vertex at its position, or
   * appended past the surface's vertices when it lies on none). Empty or absent
   * writes none, and decodes as "no feature edges".
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
  /**
   * The view's autoplay animation as `samplePreviewAnimation` returns it (encoder
   * version 4). Each sampled sub-part's node gets a rest transform `rel(0)` and,
   * when it moves, LINEAR `translation` + `rotation` channels in seconds, where
   * `rel(t) = M(t) · base⁻¹`; the top-level extras gain `partforgeAnimation`
   * `{ name, label, loop, duration, cues, opacity, steps, animated }`. Refused
   * (throws) for a non-rigid pose, samples not running from t = 0 to t = 1, a
   * sample missing a sub-part another has, or a sub-part with no mesh.
   */
  animation?: PreviewAnimationInput | null;
}

/** Bumped whenever the encoder writes different bytes for the same input (2: feature edges; 3: edges as indices into the surface's vertices; 4: animation channels + partforgeAnimation extras). */
export const PREVIEW_ENCODER_VERSION: number;

/** Encode one view's posed meshes as a welded, quantized, meshopt-compressed GLB (Y-up, millimetres). Deterministic. */
export function encodePreviewGlb(input: EncodePreviewInput): Promise<Uint8Array>;

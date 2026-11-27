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
  /**
   * A k.subdiv body's ties (encoder version 7), as the worker's `meshes` reply delivers them:
   * per vertex of `positions`, a limit triangle of the cage's smooth surface at `level` and the
   * weights of its corners A and B. `key` is the cage's topology key. `pose` (column-major, the
   * identity when absent) maps the cage's frame onto `positions`. Stored in the file's own vertex
   * order as `_PARTFORGE_TIE_TRI` / `_PARTFORGE_TIE_W` and the node extra `partforgeTies`; the
   * cage's points are not stored (a reader runs the part's cage code at `partforgeParams`).
   */
  ties?: { key: string; level: number; tri: Uint32Array; w: Float32Array; pose?: ArrayLike<number> | null } | null;
  /**
   * A declared line's tube rather than a sub-part (encoder version 8): the line's name in the
   * part's `lines` block, with `name` then `line:<that name>`. Written as a node whose extras carry
   * `partforgeLine` and this mesh's own `display` (not `part.parts[name].display`); it may have no
   * `edges` or `ties` and no animation channel. A reader decodes it into `lines`, never as a sub-part.
   */
  line?: string | null;
  /** A line's look (`{ color }`, 0xRRGGBB), read only with `line`. */
  display?: { color?: number } | null;
}

export interface EncodePreviewInput {
  /** At least one; a zero-length mesh gets no node. */
  meshes: PreviewMesh[];
  /**
   * The params the meshes sit at (encoder version 6): `{ ...defaults, ...live, ...autoplay t = 0 values }`
   * as `exportPreview` passes them. Only finite numbers, strings and booleans are written, as the
   * top-level extra `partforgeParams`; omitted (or nothing primitive) writes no extra, which a reader
   * takes as "posed at the part's defaults".
   */
  params?: Record<string, unknown> | null;
  /** Read for `parts[name].display` (materials) and `meta.background` / `meta.environment`. */
  part?: PreviewPart | null;
  /** The view these meshes show; names the scene and lands in the file's extras as `partforgeView`. */
  view?: string | null;
  /**
   * One of the view's animations as `samplePreviewAnimation` returns it — the autoplay one, or any named one since 0.194.0 (encoder
   * version 4). Each sampled sub-part's node gets a rest transform `rel(0)` and,
   * when it moves, LINEAR `translation` + `rotation` channels in seconds, where
   * `rel(t) = M(t) · base⁻¹`; the top-level extras gain `partforgeAnimation`
   * `{ name, label, loop, duration, cues, opacity, steps, animated }`. Refused
   * (throws) for a non-rigid pose, samples not running from t = 0 to t = 1, a
   * sample missing a sub-part another has, or a sub-part with no mesh.
   */
  animation?: PreviewAnimationInput | null;
}

/** Bumped whenever the encoder writes different bytes for the same input (2: feature edges; 3: edges as indices into the surface's vertices; 4: animation channels + partforgeAnimation extras; 6: partforgeParams; 7: a cage body's ties; 8: a declared line's tube). */
export const PREVIEW_ENCODER_VERSION: number;

/** Encode one view's posed meshes as a welded, quantized, meshopt-compressed GLB (Y-up, millimetres). Deterministic. */
export function encodePreviewGlb(input: EncodePreviewInput): Promise<Uint8Array>;

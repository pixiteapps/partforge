// The GeometryKernel contract. The op lists below are DATA, not just docs: the
// parity tests (test/kernel-contract.test.js and the OCCT twin in
// test/occt-backend.test.js) assert each backend exposes exactly these ops, so the
// contract can't silently drift from the implementations — the drift class that
// once broke the probe kernel (see probe.js). The @typedefs document signatures,
// options-object form first (the canonical calling convention — normalizers and
// exact valid-key lists live in op-options.js, wired in at kernel-front.js
// (finishKernel) and solid-sugar.js (addSugar); legacy positional forms stay
// silently accepted until a future breaking contract version removes them —
// contract v2 (partforge 0.59) did NOT remove them, it only changed `offset`
// semantics; see KERNEL-CONTRACT.md's Versioning section). The prose half of the contract —
// conventions, value semantics, conformance classes, versioning policy — is
// docs/KERNEL-CONTRACT.md; change either side and you must update the other.
// (2-D polygon helpers live in ./polygon.js.)

// The prose half's version: docs/KERNEL-CONTRACT.md's "Contract version" header
// must match this number (asserted in kernel-contract.test.js). Bump only on a
// breaking contract change — see the doc's Versioning section.
export const CONTRACT_VERSION = 4;

// Ops every backend kernel must implement.
export const KERNEL_OPS = [
  "cylinder", "boredCylinder", "sphere", "box", "prism", "extrude", "revolve",
  "loft", "sweep", "helixSweptTube", "screwSweep", "union", "shape2d", "text2d", "vector2d", "hull", "hullChain", "toSTEP",
  "roundedCylinder", "torus", "roundedBox", "import",
  // Additive in 0.84 (no CONTRACT_VERSION bump — the import-op precedent).
  "loftSmooth",
  // Additive in 0.92 (same precedent): both backends implement it.
  "heightfield",
  // Additive (same precedent): a compound default, so neither backend implements it.
  "tappedBore",
];

// Backend-optional kernel ops: the sub-part cache brackets + WASM lifetime hooks.
// Both in-repo backends implement the brackets (only `cleanup` is Manifold-specific —
// OCCT's replicad shapes need no dispose bookkeeping). jobs.js calls all of these via
// `?.`, so a third-party backend may simply omit them.
export const KERNEL_OPTIONAL_OPS = [
  "beginSubPart", "endSubPart", "sweepCache", "cacheStats", "resetCacheStats", "cleanup",
  // Drains the feature-skip warnings recorded since the last drain — a fillet or
  // chamfer the geometry defeated and the backend skipped rather than failed the
  // build over. Both backends implement it; a host that never calls it sees the
  // pre-0.69 behavior (console.warn only). See KERNEL-CONTRACT.md § "Feature-skip
  // warnings channel".
  "takeBuildWarnings",
];

// Ops every Solid must implement (including the sugar addSugar() attaches).
export const SOLID_OPS = [
  "cut", "cutAll", "intersect", "union", "clone", "label", "boundingBox", "volume",
  "translate", "rotate", "rotateX", "rotateY", "rotateZ", "rotateAbout", "along", "at",
  "mirror", "scale", "toMesh", "toSTL", "toIndexedMesh",
  "fillet", "chamfer", "shell", "roundAll",
];

// Backend-optional Solid queries: Manifold mesh-topology numbers (measure.js
// guards with `typeof`); OCCT has no cheap equivalent.
export const SOLID_OPTIONAL_OPS = ["genus", "isEmpty"];

// Public methods every Shape2D exposes (2-D boolean value; contract-linted).
// One shared implementation backs both backends (geometry/shape2d.js) — storage is
// the curve-native contour IR, so every op including `offset` is backend-identical
// by construction (offset runs the native contour-offset engine, not a backend's
// own 2-D engine).
export const SHAPE2D_OPS = [
  "union", "cut", "cutAll", "intersect", "offset", "area", "boundingBox", "toRegions", "simple", "regions", "clone",
  "extrude", "revolve",
  "translate", "rotate", "scale", "mirror", "toContours", "fillet", "chamfer", "simplify", "corners", "contains",
  "isEmpty",
];

// Solid ops a core (mesh) kernel MAY lack. solid-sugar generates KernelCapability-
// Error stubs for whichever of these a backend leaves undefined. The in-repo
// Manifold backend now implements fillet and chamfer natively (mesh-fillet.js —
// straight and circular-arc edge chains), so only `shell` is stubbed there.
export const OCCT_ONLY_OPS = ["fillet", "chamfer", "shell"];

// The subset the geometry-free probe still routes to a B-rep kernel up front.
// fillet/chamfer are NOT probe-routed anymore: the mesh backend attempts them
// and throws KernelCapabilityError (code NEEDS_OCCT) only for edge classes it
// cannot blend, which the framework's runtime reroute latch converts into a
// per-sub-part OCCT fallback (backend-select.js).
export const ROUTED_CAD_OPS = ["shell"];

/**
 * @typedef {Object} Solid  An opaque handle to a backend solid. `_`-prefixed keys are backend internals.
 * @property {(tool: Solid) => Solid} cut
 * @property {(tools: Solid[]) => Solid} cutAll      batch subtract (backend-optimized)
 * @property {(other: Solid) => Solid} intersect     boolean intersection (both backends)
 * @property {(other: Solid) => Solid} union         boolean union with one other solid (n-ary: k.union([...]))
 * @property {() => Solid} clone   independent copy (replicad consumes solids on transform)
 * @property {(name: string) => Solid} label   name this solid's surface for hover/pick feature attribution (survives transforms + booleans; same name on several solids merges into one feature)
 * @property {() => {min:number[],max:number[],center:number[],size:number[]}} boundingBox   axis-aligned bounds (query)
 * @property {(v: number[]) => Solid} translate
 * @property {(deg: number, center: number[], axis: number[]) => Solid} rotate   internal primitive — prefer rotateX/Y/Z / rotateAbout
 * @property {(deg: number) => Solid} rotateX   rotate about world X through the origin
 * @property {(deg: number) => Solid} rotateY   rotate about world Y through the origin
 * @property {(deg: number) => Solid} rotateZ   rotate about world Z through the origin
 * @property {(o:{axis:"X"|"Y"|"Z"|number[], deg:number, through?:number[]}) => Solid} rotateAbout   general rotation (legible)
 * @property {(dir:"+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z") => Solid} along   orient the canonical +Z build axis along dir
 * @property {(v:number[]) => Solid} at   place an origin-built solid at point v (alias of translate)
 * @property {(plane: "XY"|"XZ"|"YZ") => Solid} mirror
 * @property {(factor:number, center?:number[]) => Solid} scale   uniform scale about center (default origin)
 * @property {() => number} volume                   solid volume in mm³ (both backends; used by collision/overlap tests)
 * @property {(opts?: {quality?: "preview"|"print"}) => {positions:Float32Array, normals:Float32Array, indices?:Uint32Array, triangles:number, edges?:Float32Array}} toMesh
 *           `normals`/`edges` are authoritative shading intent from both backends — see docs/KERNEL-CONTRACT.md "Shading intent"; quality is advisory — the Manifold kernel bakes it at creation
 * @property {(opts?: {quality?: "preview"|"print"}) => Promise<ArrayBuffer>} toSTL
 * @property {() => {positions:Float32Array, indices:Uint32Array}} toIndexedMesh   indexed mesh, for 3MF
 * @property {(r:number|{r:number,edges?:object}) => Solid} fillet    round edges; mesh-native for straight/circular chains with automatic OCCT fallback; fillet(3) or fillet({r,edges}); legacy (r,selector) accepted for now (see file header)
 * @property {(d:number|{d:number,edges?:object}) => Solid} chamfer  bevel edges; mesh-native for straight/circular chains with automatic OCCT fallback; chamfer(1) or chamfer({d,edges}); legacy (d,selector) accepted for now (see file header)
 * @property {(o:{t:number,open:object}) => Solid} shell   hollow inward (OCCT only); legacy (thickness,openFaces) accepted for now (see file header)
 * @property {() => number} [genus]     through-hole count (Manifold only)
 * @property {() => boolean} [isEmpty]  no geometry at all (Manifold only)
 *
 * @typedef {Object} Shape2D  A 2-D boolean value. ONE shared implementation on both backends: storage is the curve-native contour IR (arcs/cubics survive every op), so results are backend-identical by construction, `offset` included. `_`-prefixed keys are internals.
 * @property {(other: Shape2D|number[][]) => Shape2D} union
 * @property {(other: Shape2D|number[][]) => Shape2D} cut
 * @property {(others: (Shape2D|number[][])[]) => Shape2D} cutAll   batch subtract
 * @property {(other: Shape2D|number[][]) => Shape2D} intersect
 * @property {(delta:number, opts?:{corners?:"round"|"chamfer"|"sharp",segs?:number}) => Shape2D} offset   grow (+) / shrink (−) by delta; backend-identical by construction like every other Shape2D op (native contour-offset engine, not a backend 2-D engine); `segs` accepted and ignored — throws when the shape collapses; empty in → empty out
 * @property {() => boolean} isEmpty   true when the shape has no regions (a cut/intersect removed everything); guard before extrude/revolve, which throw on an empty profile
 * @property {() => number} area   net area (outers minus holes), mm² — curve-exact, not tessellated
 * @property {() => {min:number[],max:number[]}} boundingBox   axis-aligned 2-D bounds (curve-exact)
 * @property {() => {outer:number[][],holes:number[][][]}[]} toRegions   materialize into point-ring region arrays (tessellated at the backend's LOD)
 * @property {() => {outer:number[][],holes:number[][][]}} simple   toRegions(), unwrapped — throws unless exactly 1 region
 * @property {() => Shape2D[]} regions   scission: each disjoint region as its own Shape2D
 * @property {() => {outer:object,holes:object[]}[]} toContours   the stored contour IR (curve-native, lossless) — a deep copy, safe to mutate
 * @property {() => Shape2D} clone   independent copy
 * @property {(v:number[]) => Shape2D} translate   translate by [dx,dy]
 * @property {(deg:number, center?:number[]) => Shape2D} rotate   rotate about center (default origin)
 * @property {(f:number|number[], center?:number[]) => Shape2D} scale   scale about center (default origin); a bare number scales uniformly, [sx,sy] scales each axis independently
 * @property {(axis:"x"|"y"|{point:number[],dir:number[]}) => Shape2D} mirror   reflect across an axis line
 * @property {(r:number|number[], opts?:{corners?:"all"|"convex"|"concave"|{indices:number[]}|{near:number[],count?:number}}) => Shape2D} fillet   round selected corners with true arcs
 * @property {(d:number|number[], opts?:{corners?:"all"|"convex"|"concave"|{indices:number[]}|{near:number[],count?:number}}) => Shape2D} chamfer   bevel selected corners with straight chords
 * @property {(tolerance:number) => Shape2D} simplify   corner-preserving decimation/refit within tolerance
 * @property {() => {index:number,point:number[],interiorAngleDeg:number,convex:boolean,segTypes:string[]}[]} corners   corner list (the positional order fillet/chamfer `{indices}` index into)
 * @property {(p:number[]) => boolean} contains   is point [x,y] inside the shape (holes excluded)
 * @property {(o?:{h:number,twist?:number,scaleTop?:number}) => Solid} extrude   sugar for k.extrude({profile:this,…})
 * @property {(o?:{degrees?:number}) => Solid} revolve   sugar for k.revolve({profile:this,…})
 *
 * @typedef {Object} GeometryKernel
 * @property {(o:{r?:number,d?:number,r1?:number,r2?:number,d1?:number,d2?:number,h:number,center?:boolean}) => Solid} cylinder   canonical: {r|d,h} straight, {r1,r2,h}|{d1,d2,h} cone; legacy (rBottom,rTop,h,opts) accepted for now (see file header)
 * @property {(o:{od:number,h:number,bore:number}) => Solid} boredCylinder   compound: bored-through cylinder (one cache node)
 * @property {(o:{r?:number,d?:number}) => Solid} sphere   sphere centred at the origin; {r|d}; bare sphere(r) stays valid
 * @property {(o:{r?:number,d?:number,h:number,center?:boolean,round:number|{top?:number,bottom?:number}}) => Solid} roundedCylinder   rim round-overs via one lathe revolve; options-only; round ≤ r, top+bottom ≤ h
 * @property {(o:{rMajor:number,rMinor:number}) => Solid} torus   centered at origin, tube centerline in the z=0 plane; 0 < rMinor < rMajor; options-only
 * @property {(o:{size:number[],center?:boolean,round:number|{side?:number,top?:number,bottom?:number}}) => Solid} roundedBox   selective edge rounding (side = vertical edges, top/bottom = rims); 0 < side < rim clamps rims down to side with a console.warn; options-only
 * @property {(o:{size?:number[],center?:boolean,min?:number[],max?:number[]}) => Solid} box   {size} = centered X/Y, base z=0 ({center:true} centers Z too) or {min,max}; legacy (min,max) accepted for now (see file header)
 * @property {(o:{points:number[][]|{start:number[],segments:object[]},h:number,twist?:number,scaleTop?:number}) => Solid} prism   extrude polygon from z=0; legacy (points,h,opts) accepted for now (see file header)
 * @property {(o:{profile:number[][]|{start:number[],segments:object[]}|{outer:number[][],holes?:number[][][]}|Shape2D,h:number,twist?:number,scaleTop?:number,bevel?:number|{bottom?:number,top?:number}}) => Solid} extrude   polygon-with-holes region from z=0; bevel = 45° rim bevel (any profile form incl. Shape2D, materialized to point rings; no twist/scaleTop); legacy (profile,h,opts) accepted for now (see file header)
 * @property {(o:{rings:{polygon?:number[][]|{start:number[],segments:object[]}|Shape2D,sides?:number,radius?:number,z:number,rotate?:number,scale?:number|number[]}[],ruled?:boolean,closed?:boolean,shading?:"smooth"|"faceted"}) => Solid} loft   stack polygon cross-sections; polygon accepts point lists, curve contours, or hole-free Shape2D; shading overrides facet-vs-smooth shading inference; legacy (rings,opts) accepted for now (see file header)
 * @property {(o:{profile:number[][],path:number[][],closed?:boolean,cornerRadius?:number,ruled?:boolean,smooth?:boolean}) => Solid} sweep   sweep a 2-D profile along a 3-D polyline; legacy (profile,path,opts) accepted for now (see file header)
 * @property {(o:{profile:number[][]|Shape2D,degrees?:number}) => Solid} revolve   revolve a lathe profile [[r,z],…] around Z; legacy (points,opts) accepted for now (see file header)
 * @property {(o:{pathR:number,profileR:number,pitch:number,turns:number,z0:number,lefthand:boolean}) => Solid} helixSweptTube
 * @property {(o:{profile:number[][],pitch:number,turns:number,lefthand?:boolean}) => Solid} screwSweep   screw-motion sweep of an axial [[r,z]] profile — threads; options-only
 * @property {(o:{d:number,pitch:number,turns:number,depth?:number,crest?:number,lefthand?:boolean,rootSink?:number,overshoot?:number}) => Solid} tappedBore   compound: a tapped hole as ONE cut tool — bore plus thread, root sunk inside the bore so the two never share a face
 * @property {(o:{sections:object[],stations?:number,samples?:number,shading?:string,closed?:boolean}) => Solid} loftSmooth   Catmull-Rom-densified loft of sparse control sections; options-only
 * @property {(nameOrGrid: string|{width:number,height:number,data:Uint16Array}, opts: {w:number,d:number,base?:number,maxZ?:number,pitch?:number,invert?:boolean,range?:number[],origin?:"center"|"corner"}) => Solid} heightfield   depth-map relief solid; nameOrGrid is a name declared in the part's `images` field or an inline grid
 * @property {(solids:Solid[]) => Solid} union
 * @property {(profile: number[][]|{outer:number[][],holes?:number[][][]}|{start:number[],segments:object[]}|Shape2D) => Shape2D} shape2d   2-D boolean value; one shared contour-storage implementation on both backends
 * @property {(inputs: (Shape2D|number[][]|{start:number[],segments:object[]})[]) => Shape2D} hull   convex hull of all inputs → a convex Shape2D (faceted; pure-JS monotone chain)
 * @property {(inputs: (Shape2D|number[][]|{start:number[],segments:object[]})[]) => Shape2D} hullChain   swept hull over an ordered sequence (≥2): union of hull([inᵢ,inᵢ₊₁])
 * @property {(named:{name:string,solid:Solid}[]) => Promise<ArrayBuffer>} toSTEP   OCCT only (Manifold throws KernelCapabilityError)
 * @property {(name: string) => Solid} import   imported geometry declared in the part's imports field (registered pre-build by the framework via the underscore-prefixed `_registerImport`/`_importDigest`/`_acceptsStep`/`_acceptsMesh` side-channel, not a part author's calling surface)
 * @property {(name:string) => void} [beginSubPart]   open a per-sub-part solid-cache round (both backends)
 * @property {() => void} [endSubPart]                close the cache round (always pair with beginSubPart)
 * @property {() => void} [sweepCache]   drop cache partitions idle for 3 rebinds; call once per setPart, never mid-bracket
 * @property {() => {hits:number,misses:number}} [cacheStats]
 * @property {() => void} [resetCacheStats]
 * @property {() => void} [cleanup]   free per-job WASM objects (Manifold backend); call after each job
 * @property {() => string[]} [takeBuildWarnings]   drain feature-skip warnings (a fillet/chamfer/roundAll the backend skipped rather than failing the build over); drain per sub-part to attribute each message
 */

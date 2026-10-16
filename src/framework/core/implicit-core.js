// The implicit engine on the native core (native/implicit_eval.cpp, …) — a
// SESSION per meshing run: the part's textures and emitted programs live in
// WebAssembly memory and every stage runs there, bit for bit what the JS in
// geometry/implicit/ computes (test/implicit-native-*.test.js hold each stage).
//
// Failure is contained (core.js): a trap or a failed allocation poisons the
// instance and the call throws CORE_FAULT, which the caller catches to run the
// JS instead. A REFUSAL (bad input, a texture or program the core will not take)
// is not a fault: it throws a plain Error and the instance stays usable. Memory views are re-read after every call into the module, since
// any call may grow (and so detach) its memory.
import { OUT_OF_MEMORY, poisonCore, releaseIfIdle } from "./core.js";
import { CLEANUP } from "../geometry/implicit/cleanup.js";
import { DETAIL_STRIDE } from "../geometry/implicit/detail.js";

const isFault = (err) => (typeof WebAssembly === "object" && err instanceof WebAssembly.RuntimeError) || err?.message === OUT_OF_MEMORY;
const isNumbers = (a) => ArrayBuffer.isView(a) || Array.isArray(a);
const isInt32 = (v) => Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;
const LEAF_SAMPLES = 125;   // (LEAF + 1)³, sparse.js's LEAF = 4

/** Thrown when the core faulted (or is already poisoned): run the JS path instead. */
export const CORE_FAULT = Object.freeze(new Error("partforge core: the implicit session faulted"));

export class NativeSession {
  constructor(c) {
    this.c = c;
    this.io = 0;      // one block: X, Y, Z, out — `cap` doubles each, reused across eval calls
    this.cap = 0;
    this.id = this.#call(() => c.x.ip_session_create());
    if (!this.id) throw CORE_FAULT;
    c.live++;         // a live session pins its instance, like a core BVH
  }

  // Runs `fn` against the module. A trap or a failed allocation poisons the
  // instance and becomes CORE_FAULT; anything else is rethrown untouched.
  #call(fn) {
    const c = this.c;
    if (c.poisoned) throw CORE_FAULT;
    try {
      return fn();
    } catch (err) {
      if (!isFault(err)) throw err;
      poisonCore(c, err);
      throw CORE_FAULT;
    }
  }

  /** A makeTexture() result ({ width, height, data: Float32Array }); returns its slot. */
  addTexture(t) {
    const { c } = this;
    if (!(t?.data instanceof Float32Array) || !Number.isInteger(t.width) || !Number.isInteger(t.height) || t.data.length !== t.width * t.height) {
      throw new Error("implicit: a texture needs integer width × height float32 texels");
    }
    const slot = this.#call(() => {
      const ptr = c.copyIn(t.data);
      try {
        return c.x.ip_tex_add(this.id, t.width, t.height, ptr);
      } finally {
        if (ptr) c.x.free(ptr);
      }
    });
    if (slot < 0) throw new Error(`implicit: the core refused a ${t.width}×${t.height} texture`);
    return slot;
  }

  /** An emitted program (program.js's Float64Array format); returns its index. */
  addProgram(prog) {
    const { c } = this;
    if (!(prog instanceof Float64Array)) throw new Error("implicit: a program is a Float64Array");
    return this.#call(() => {
      const ptr = c.copyIn(prog);
      try {
        return c.x.ip_prog_add(this.id, ptr, prog.length);
      } finally {
        if (ptr) c.x.free(ptr);
      }
    });
  }

  /** evalBatch(prog, textures, X, Y, Z, out) on the core: a fresh Float64Array of field values. */
  eval(progIndex, X, Y, Z) {
    const { c } = this;
    if (!Number.isInteger(progIndex) || !isNumbers(X) || !isNumbers(Y) || !isNumbers(Z)) throw new Error("implicit: eval takes a program index and X, Y, Z number arrays");
    const n = X.length;
    if (Y.length !== n || Z.length !== n) throw new Error("implicit: X, Y and Z must be the same length");
    let rc = 0;
    const out = this.#call(() => {
      if (n === 0) {   // still checks the program; no buffers needed
        rc = c.x.ip_eval(this.id, progIndex, 0, 0, 0, 0, 0);
        return new Float64Array(0);
      }
      if (n > this.cap) {
        if (this.io) c.x.free(this.io);
        this.io = 0;
        this.cap = 0;
        this.io = c.alloc(n * 32);
        this.cap = n;
      }
      const base = this.io, cap = this.cap;
      const f64 = new Float64Array(c.x.memory.buffer, base, cap * 4);
      f64.set(X, 0); f64.set(Y, cap); f64.set(Z, 2 * cap);
      rc = c.x.ip_eval(this.id, progIndex, base, base + cap * 8, base + cap * 16, n, base + cap * 24);
      return rc === 0 ? c.copyOut(Float64Array, base + cap * 24, n) : null;
    });
    if (rc !== 0) throw new Error(`implicit: the core refused program ${progIndex} (malformed, or a texture slot it lacks)`);
    return out;
  }

  /**
   * evaluateLeaves(plan) on the core: { vals: a Float32Array per leaf, clipped }. The
   * plan's textures and programs must already be in the session, added in plan order
   * (a leaf's progIndex is the session's program index). The samples stay in the
   * session for mesh(); with `readBack: false` they are not copied out (`vals` is null).
   */
  sample(plan, { readBack = true } = {}) {
    const { c } = this;
    const { origin, edge, n, leaves } = plan ?? {};
    if (!isNumbers(origin) || origin.length !== 3 || !origin.every(Number.isFinite) || !(edge > 0) || !Number.isFinite(edge)
      || !isNumbers(n) || n.length !== 3 || !n.every((v) => isInt32(v) && v >= 2) || !Array.isArray(leaves)) {
      throw new Error("implicit: sample takes a plan with origin, edge, n and leaves");
    }
    const count = leaves.length;
    const L = new Int32Array(count * 4);
    for (let k = 0; k < count; k++) {
      const { i0, j0, l0, progIndex } = leaves[k];
      // planLeaves only emits leaves whose first cell is a grid cell (i0 < n[0] − 1, …);
      // the mesher's weld keys rely on it. (A leaf may run past the grid's end — i0 + LEAF ≥ n
      // is normal near the far faces — the mesher clamps its cells there.)
      if (!isInt32(i0) || !isInt32(j0) || !isInt32(l0) || !isInt32(progIndex) || i0 < 0 || j0 < 0 || l0 < 0
        || i0 >= n[0] - 1 || j0 >= n[1] - 1 || l0 >= n[2] - 1) {
        throw new Error("implicit: a plan leaf needs integer i0, j0, l0 inside the grid's cells and a program index");
      }
      L[4 * k] = i0; L[4 * k + 1] = j0; L[4 * k + 2] = l0; L[4 * k + 3] = progIndex;
    }
    let rc = 0;
    const out = this.#call(() => {
      let pl = 0, po = 0, pn = 0;
      try {
        pl = c.copyIn(L);
        po = c.copyIn(Float64Array.from(origin));
        pn = c.copyIn(Int32Array.from(n));
        rc = c.x.ip_sample(this.id, pl, count, po, edge, pn);
      } finally {
        if (pl) c.x.free(pl);
        if (po) c.x.free(po);
        if (pn) c.x.free(pn);
      }
      if (rc !== 0) return null;
      const clipped = c.x.ip_clipped(this.id) === 1;
      return { all: readBack ? c.copyOut(Float32Array, c.x.ip_leaf_vals(this.id), count * LEAF_SAMPLES) : null, clipped };
    });
    if (rc !== 0) throw new Error("implicit: the core refused the plan (a program index the session lacks, or a program it will not run)");
    if (!readBack) return { vals: null, clipped: out.clipped };
    const vals = new Array(count);
    for (let k = 0; k < count; k++) vals[k] = out.all.subarray(k * LEAF_SAMPLES, (k + 1) * LEAF_SAMPLES);
    return { vals, clipped: out.clipped };
  }

  /**
   * meshStore on the core, over the samples of the last sample(): { positions:
   * Float64Array, indices: Uint32Array, vertLeaf: Int32Array }. The mesh stays in
   * the session for the later stages.
   */
  mesh() {
    const { c } = this;
    let rc = 0;
    const out = this.#call(() => {
      rc = c.x.ip_mesh(this.id);
      return rc === 0 ? this.#readMesh() : null;
    });
    if (rc !== 0) throw new Error("implicit: the core refused to mesh (nothing sampled yet)");
    return out;
  }

  // The session mesh as { positions, indices, vertLeaf } copies (inside #call).
  #readMesh() {
    const { c } = this;
    const nv = c.x.ip_vertex_count(this.id), ni = c.x.ip_index_count(this.id);
    return {
      positions: c.copyOut(Float64Array, c.x.ip_positions(this.id), nv * 3),
      indices: c.copyOut(Uint32Array, c.x.ip_indices(this.id), ni),
      vertLeaf: c.copyOut(Int32Array, c.x.ip_vert_leaf(this.id), nv),
    };
  }

  /**
   * Replaces the session mesh with `{ positions, indices, vertLeaf }` (after a
   * sample(); each vertLeaf names a leaf of that store), and its `normals` (xyz per
   * vertex) when given — so the later stages can run on a mesh the mesher did not make.
   */
  loadMesh({ positions, indices, vertLeaf, normals = null } = {}) {
    const { c } = this;
    if (!isNumbers(positions) || !isNumbers(indices) || !isNumbers(vertLeaf) || positions.length !== vertLeaf.length * 3 || indices.length % 3
      || (normals !== null && (!isNumbers(normals) || normals.length !== positions.length))) {
      throw new Error("implicit: loadMesh takes positions (xyz), indices (triangles), a vertLeaf per vertex and optional normals (xyz)");
    }
    let rc = 0;
    this.#call(() => {
      let pp = 0, pi = 0, pl = 0, pn = 0;
      try {
        pp = c.copyIn(Float64Array.from(positions));
        pi = c.copyIn(Uint32Array.from(indices));
        pl = c.copyIn(Int32Array.from(vertLeaf));
        // An empty mesh's normals still pass a real pointer (null means "none").
        if (normals) pn = normals.length ? c.copyIn(Float64Array.from(normals)) : c.alloc(8);
        rc = c.x.ip_mesh_load(this.id, pp, vertLeaf.length, pi, indices.length, pl, pn);
      } finally {
        if (pp) c.x.free(pp);
        if (pi) c.x.free(pi);
        if (pl) c.x.free(pl);
        if (pn) c.x.free(pn);
      }
    });
    if (rc !== 0) throw new Error("implicit: the core refused the mesh (nothing sampled, or an index or leaf out of range)");
  }

  /**
   * projectVertices on the session mesh, in place: `which` (default every vertex)
   * moved by one clamped Newton step; with `normals: true` the session's normals
   * (zeros where none was found) are written too. Returns { positions, normals }
   * (normals null when not asked for).
   */
  project({ maxStep, which = null, normals = false } = {}) {
    const { c } = this;
    if (!(typeof maxStep === "number") || Number.isNaN(maxStep) || (which !== null && !isNumbers(which))) {
      throw new Error("implicit: project takes a maxStep and an optional which (vertex indices)");
    }
    let rc = 0;
    const out = this.#call(() => {
      let pw = 0;
      try {
        // A null pointer means every vertex, so an empty `which` still passes a real one.
        if (which) pw = which.length ? c.copyIn(Int32Array.from(which)) : c.alloc(4);
        rc = c.x.ip_project(this.id, pw, which ? which.length : 0, maxStep, normals ? 1 : 0);
      } finally {
        if (pw) c.x.free(pw);
      }
      if (rc !== 0) return null;
      const nv = c.x.ip_vertex_count(this.id);
      return {
        positions: c.copyOut(Float64Array, c.x.ip_positions(this.id), nv * 3),
        normals: normals ? this.#normalsOut(nv) : null,
      };
    });
    if (rc !== 0) throw new Error("implicit: the core refused to project (no mesh, or a vertex index out of range or repeated)");
    return out;
  }

  #normalsOut(nv) {
    const { c } = this;
    const ptr = c.x.ip_normals(this.id);
    return ptr ? c.copyOut(Float64Array, ptr, nv * 3) : new Float64Array(nv * 3);
  }

  /**
   * cleanupMesh on the session mesh, in place: { positions, indices, vertLeaf,
   * normals }, or null with `readBack: false` (the result stays in the session).
   */
  cleanup(opts = CLEANUP, { readBack = true } = {}) {
    const { c } = this;
    const { collapseFrac, relaxPasses, relaxWeight, maxMoveCells } = opts ?? {};
    if (![collapseFrac, relaxWeight, maxMoveCells].every((v) => typeof v === "number") || !isInt32(relaxPasses)) {
      throw new Error("implicit: cleanup takes collapseFrac, relaxPasses (an integer), relaxWeight and maxMoveCells");
    }
    let rc = 0;
    const out = this.#call(() => {
      rc = c.x.ip_cleanup(this.id, collapseFrac, relaxPasses, relaxWeight, maxMoveCells);
      if (rc !== 0 || !readBack) return null;
      const m = this.#readMesh();
      return { ...m, normals: this.#normalsOut(m.vertLeaf.length) };
    });
    if (rc !== 0) throw new Error("implicit: the core refused to clean up (nothing meshed yet)");
    return out;
  }

  /**
   * applySurfaceDetail on the session mesh, in place, after cleanup(): `flat` is
   * flattenDetail(compiled) ({ entries: 28 doubles per entry, programs: the expr
   * heights }), whose programs are added to the session first. Returns { positions,
   * indices, vertLeaf, normals }, or null with `readBack: false`.
   */
  detail(flat, { readBack = true } = {}) {
    const { c } = this;
    const { entries, programs } = flat ?? {};
    if (!(entries instanceof Float64Array) || entries.length % DETAIL_STRIDE || !Array.isArray(programs)) {
      throw new Error(`implicit: detail takes flattenDetail's { entries (${DETAIL_STRIDE} doubles per entry), programs }`);
    }
    const index = Int32Array.from(programs, (p) => this.addProgram(p));
    let rc = 0;
    const out = this.#call(() => {
      let pe = 0, pp = 0;
      try {
        pe = c.copyIn(entries);
        pp = c.copyIn(index);
        rc = c.x.ip_detail(this.id, pe, entries.length / DETAIL_STRIDE, pp, index.length);
      } finally {
        if (pe) c.x.free(pe);
        if (pp) c.x.free(pp);
      }
      if (rc !== 0 || !readBack) return null;
      const m = this.#readMesh();
      return { ...m, normals: this.#normalsOut(m.vertLeaf.length) };
    });
    if (rc !== 0) throw new Error("implicit: the core refused the detail (no cleaned-up mesh, or a texture slot or expr program it cannot run)");
    return out;
  }

  /** The session's normals (double ×3 per vertex; zeros if none were written). */
  normals() {
    const { c } = this;
    return this.#call(() => this.#normalsOut(c.x.ip_vertex_count(this.id)));
  }

  /** Frees the session. Safe to call twice, and on a poisoned instance (nothing is touched then). */
  destroy() {
    const { c } = this;
    if (!this.id) return;
    const id = this.id, io = this.io;
    this.id = 0;
    this.io = 0;
    this.cap = 0;
    c.live--;
    if (!c.poisoned) {
      try {
        if (io) c.x.free(io);
        c.x.ip_session_destroy(id);
      } catch (err) {
        poisonCore(c, err);
      }
    }
    releaseIfIdle(c);
  }
}

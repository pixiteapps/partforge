// Times the native core's two passes on the reference parts — creasedNormals
// (core and JS) and the oracle's BVH (build, min-wall, closestPoint,
// distanceTo) — so a change to native/ can be measured before and after.
// Every core result is also compared with the JS, byte for byte, so a speedup
// that changed an answer fails here before the parity test.
//
//   npm run bench:core                     # all parts
//   BENCH_PARTS=screw,planter npm run bench:core
//   BENCH_BASELINE=/path/to/old/core-wasm.js npm run bench:core
//
// With BENCH_BASELINE (an older build's src/framework/core/core-wasm.js, e.g.
// `git show origin/main:src/framework/core/core-wasm.js > /tmp/base.js`), each
// pass runs on both modules, alternating rep by rep so machine load hits both
// alike, and the table shows base / new / speedup. Only the current build's
// answers are checked against the JS: a baseline may predate an algorithm
// change the JS made with it.
import { expect, test, vi } from "vitest";
import { bootManifoldKernel, buildView } from "../../src/testing.js";
import { core } from "../../src/framework/core/core.js";
import { creasedNormalsCore } from "../../src/framework/core/creased-normals-core.js";
import { buildCoreBVH } from "../../src/framework/core/bvh-core.js";
import { buildBVH, triangleVertices } from "../../src/framework/oracle/bvh.js";
import { minWall, MAX_SAMPLES } from "../../src/framework/oracle/min-wall.js";

const captured = [];
vi.mock("../../src/framework/geometry/creased-normals.js", async (importOriginal) => {
  const m = await importOriginal();
  const copy = (a) => (a == null ? a : a.slice());
  return {
    ...m,
    creasedNormals(g, opts) {
      captured.push({
        g: {
          numProp: g.numProp, vertProperties: copy(g.vertProperties), triVerts: copy(g.triVerts),
          runIndex: copy(g.runIndex), runOriginalID: copy(g.runOriginalID), runTransform: copy(g.runTransform),
          mergeFromVert: copy(g.mergeFromVert), mergeToVert: copy(g.mergeToVert),
        },
        opts,
      });
      return m.creasedNormals(g, opts);
    },
  };
});
const { creasedNormalsJS } = await import("../../src/framework/geometry/creased-normals.js");

const ALL = ["bracket", "demo", "faceted-vase", "filleted-box", "gasket", "hinged-box", "hull-sweep",
  "laser-box", "lattice-box", "lofted-bottle", "planter", "propeller", "screw"];
const PARTS = process.env.BENCH_PARTS ? process.env.BENCH_PARTS.split(",") : ALL;
const REPS = Number(process.env.BENCH_REPS ?? 7);

// A core instance from a core-wasm.js module's bytes (core.js's boot(), minus
// its bookkeeping) — how the baseline build is loaded beside the current one.
function instanceFrom(base64) {
  const stub = () => 0;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(base64, "base64")), {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: { fd_close: stub, fd_write: stub, fd_seek: stub },
  });
  const x = instance.exports;
  x._initialize?.();
  const scratch = x.malloc(32 * 8);
  return {
    x, scratch, live: 0, poisoned: false,
    alloc(bytes) { const p = x.malloc(bytes || 1); if (!p) throw new Error("out of memory"); return p; },
    f64: () => new Float64Array(x.memory.buffer, scratch, 32),
    copyIn(arr) {
      if (!arr || arr.length === 0) return 0;
      const ptr = this.alloc(arr.byteLength);
      new Uint8Array(x.memory.buffer, ptr, arr.byteLength).set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
      return ptr;
    },
    copyOut: (Ctor, ptr, len) => (ptr && len ? new Ctor(x.memory.buffer, ptr, len).slice() : new Ctor(0)),
  };
}

// Median wall time of each fn over REPS runs, interleaved, after a warm-up.
function times(...fns) {
  fns.forEach((f) => f());
  const t = fns.map(() => []);
  for (let i = 0; i < REPS; i++) fns.forEach((f, j) => { const s = performance.now(); f(); t[j].push(performance.now() - s); });
  return t.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
}
const same = (a, b) => (a == null && b == null) || (a && b && Buffer.compare(
  Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0);

// Deterministic query points around a box.
function points(rb, n) {
  let s = 12345;
  const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const pad = 0.2 * Math.max(rb[3] - rb[0], rb[4] - rb[1], rb[5] - rb[2]);
  return Array.from({ length: n }, () => [0, 1, 2].map((a) => rb[a] - pad + r() * (rb[a + 3] - rb[a] + 2 * pad)));
}

const COLS = ["cn", "bvhBuild", "minWall", "closest", "distance"];

test("core benchmark", async () => {
  const cur = core();
  expect(cur).not.toBeNull();
  const base = process.env.BENCH_BASELINE
    ? instanceFrom((await import(process.env.BENCH_BASELINE)).CORE_WASM_BASE64) : null;
  const cores = base ? [base, cur] : [cur];
  const rows = [];
  const kernel = await bootManifoldKernel();
  for (const name of PARTS) {
    const part = (await import(`../../src/parts/${name}.js`)).default;
    captured.length = 0;
    const built = buildView(kernel, part, Object.keys(part.views)[0]);
    const row = { part: name, tris: 0, cnJS: 0 };
    for (const k of COLS) row[k] = cores.map(() => 0);
    const add = (k, ts) => ts.forEach((t, i) => (row[k][i] += t));

    for (const { g, opts } of captured) {
      const want = creasedNormalsJS(g, opts);
      {
        const got = creasedNormalsCore(cur, g, opts);
        for (const k of ["positions", "normals", "edges", "featureIds"]) expect(same(got[k], want[k]), `${name} ${k}`).toBe(true);
      }
      row.tris += want.triangles;
      add("cn", times(...cores.map((c) => () => creasedNormalsCore(c, g, opts))));
      row.cnJS += times(() => creasedNormalsJS(g, opts))[0];
    }

    const meshes = built.map((b) => b.mesh).filter((m) => m.positions?.length);
    const js = meshes.map((m) => buildBVH(m));
    const make = (c, m) => buildCoreBVH(c, triangleVertices(m), () => buildBVH(m));
    add("bvhBuild", times(...cores.map((c) => () => meshes.forEach((m) => make(c, m).dispose()))));
    const bvhs = cores.map((c) => meshes.map((m) => make(c, m)));
    const qs = js.map((b) => points(b.rootBounds, 2000));
    const pairs = [];
    for (let i = 0; i < meshes.length; i++) for (let j = i + 1; j < meshes.length; j++) pairs.push([i, j]);
    const wall = (b) => b.minWall({ maxThickness: undefined, maxSamples: MAX_SAMPLES });
    {
      const set = bvhs[bvhs.length - 1]; // the current build's
      set.forEach((b, i) => {
        expect(wall(b)).toEqual(minWall(meshes[i], { maxSamples: MAX_SAMPLES, bvh: js[i] }));
        qs[i].slice(0, 200).forEach((p) => expect(b.closestPoint(p)).toEqual(js[i].closestPoint(p)));
      });
      pairs.forEach(([i, j]) => expect(set[i].distanceTo(set[j])).toEqual(js[i].distanceTo(js[j])));
    }
    add("minWall", times(...bvhs.map((set) => () => set.forEach(wall))));
    add("closest", times(...bvhs.map((set) => () => set.forEach((b, i) => qs[i].forEach((p) => b.closestPoint(p))))));
    if (pairs.length) add("distance", times(...bvhs.map((set) => () => pairs.forEach(([i, j]) => set[i].distanceTo(set[j])))));
    bvhs.flat().forEach((b) => b.dispose());
    rows.push(row);
  }
  kernel.cleanup?.();

  const cell = (v) => (base ? `${v[0].toFixed(1)}/${v[1].toFixed(1)} ${v[1] ? (v[0] / v[1]).toFixed(2) : "-"}x` : v[0].toFixed(2)).padStart(base ? 20 : 10);
  const lines = [`${"part".padEnd(15)}${"tris".padStart(8)}${COLS.map((k) => k.padStart(base ? 20 : 10)).join("")}${"cnJS".padStart(9)}`];
  const total = { part: "TOTAL (ms)", tris: "", cnJS: 0 };
  for (const k of COLS) total[k] = cores.map(() => 0);
  for (const r of [...rows, total]) {
    if (r !== total) { COLS.forEach((k) => r[k].forEach((v, i) => (total[k][i] += v))); total.cnJS += r.cnJS; }
    lines.push(`${r.part.padEnd(15)}${String(r.tris).padStart(8)}${COLS.map((k) => cell(r[k])).join("")}${r.cnJS.toFixed(1).padStart(9)}`);
  }
  process.stdout.write(`\n${lines.join("\n")}\n\n`);
});

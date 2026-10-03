# Recorded Param Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide which params a cached sub-part mesh, or an oracle measurement, depends on from what the real build read, not from the geometry-free probe's prediction. This fixes skipped rebuilds, wrongly dimmed controls and wrongly reused verify cases whenever a build branches on geometry, such as an `isEmpty()` guard.

**Architecture:**
- `resolveParams` gains an optional read sink. With one, it returns `p` and `d` as record-through Proxies, and expands derived-key reads to raw params through derive attribution.
- The worker uses this per sub-part and returns `reads: string[]` on each delivered mesh. The mesh cache stamps each sub-part with those keys, their values and the view.
- `measure()` threads one sink through its five param consumers and returns `reads`. `verify` reuses a measurement only when the case agrees with it on those keys.
- Display consumers (panel, pick, measure flash, `controlsFor`) share one helper that tries recorded reads first, then the probe prediction, then all params.

**Tech Stack:** Plain ES modules and vitest (`npm test`). Tests that need the Manifold WASM kernel use `bootManifoldKernel` from `src/testing.js`.

**Spec:** `docs/superpowers/specs/2026-10-03-recorded-param-deps-design.md`

## Global Constraints

- `part-model.js` stays a leaf: it may import only `derive.js` and the new import-free `read-recorder.js`.
- `pose-probe-core.js` must not import `part-model.js`, `derive.js` or `jobs.js` (`test/lint-purity.test.js`).
- The probe kernel (`geometry/probe.js`), lint (`runValidatingProbe`) and backend routing (`detectBackends`) are not modified.
- On the real path, the recorder wraps the resolved object itself (record-through). The probe path (`subPartReadKeys`) keeps its shallow clone.
- `meshes` replies change only additively, by adding `reads` per mesh. A mesh without `reads` means "unknown", which is treated as every param. `capture-meshes` is unchanged.
- No authoring API changes and no part file changes.
- `subPartReadKeys` and `relevantParamKeys` stay exported with the same signatures. Their comments are relabelled as a prediction.
- Value comparison always goes through `relevanceHash`, and so through `byteAwareReplacer`.
- Minor version bump, `0.139.0` → `0.140.0`, in this PR.

## Review Focus

1. **A build that spreads or iterates `p`** must count as reading every key. Pinned in Task 1.
2. **A best-effort stale delivery during animation playback** must drop the cache stamp, so a looping animation can't revalidate geometry built at other params. Pinned in Task 3.
3. **A sub-part toggled on by a gate**, before its first mesh lands, falls back to the probe for panel relevance. It never dims everything or nothing. Pinned in Task 5.
4. **A changed asset param** (a font, image or vector pick) rebuilds every sub-part in the job, even though `build()` never reads it. Pinned in Task 2.
5. **`measure()` given a prebuilt view without a sink** must not claim reads it didn't see. It returns `reads: undefined`, so the result is only reused on an exact match. Pinned in Task 6.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/framework/read-recorder.js` (new, leaf) | `recorder` Proxy, `newReadSink`, `expandReads`, `expandDerivedReads` |
| `src/framework/derive.js` | `resolveDerivedAttributed(part, p, { through })` |
| `src/framework/part-model.js` | `resolveParamsAttributed`, `recordedParams`, `resolveParams(…, reads)` |
| `src/framework/param-deps.js` | Uses the helpers. Adds `recordedRelevantKeys` and `subPartParamKeys`. Prediction labelling. |
| `src/framework/jobs.js` | `generate` records per-sub-part reads plus asset-declaration reads. `inspect` threads a sink into `buildView` and `measure`. |
| `src/framework/mesh-cache.js` | Stamps `{ keys, hash, view }`. Adds `record(name, reads)` and `readsOf(name)`. |
| `src/framework/pose-probe.js`, `pose-fast-path.js` | Pose probe reports `reads`. Repair records the union. |
| `src/framework/mount.js` | Passes `m.reads`. Forgets on stale-shown. Wires relevance, pick, measure and `controlsFor`. |
| `src/framework/selection/resolve.js`, `measure/measure-mode.js` | Go through `subPartParamKeys`. |
| `src/framework/oracle/build.js`, `assembly.js`, `oracle/gates.js`, `oracle/measure.js` | Accept an optional sink. `measure()` returns `reads`. |
| `src/framework/oracle/verify.js` | Reuse by recorded reads. |

---

### Task 1: Read recorder and attributed derive

**Files:**
- Create: `src/framework/read-recorder.js`
- Modify: `src/framework/derive.js`
- Modify: `src/framework/param-deps.js`. Delete the private `recorder` (lines 11-21) and `analyzeDerive` (lines 23-68), and use the new helpers instead.
- Test: `test/read-recorder.test.js`

**Interfaces:**
- Produces:
  - `recorder(obj, seen: Set<string>, { through = false } = {}): Proxy`. With `through: true` it wraps `obj` itself. By default it wraps a shallow clone.
  - `newReadSink(): { raw: Set<string>, dSeen: Set<string>, attribution: { depsOf, allInputs } | null }`
  - `expandDerivedReads(raw, dSeen, attribution): Set<string>`
  - `expandReads(sink): string[]` (sorted)
  - `resolveDerivedAttributed(part, p, { through = false } = {}): { d, depsOf: Map | null, allInputs: Set }`

- [ ] **Step 1: Write the failing tests**

```js
// test/read-recorder.test.js
import { expect, test } from "vitest";
import { recorder, newReadSink, expandReads, expandDerivedReads } from "../src/framework/read-recorder.js";
import { resolveDerived, resolveDerivedAttributed } from "../src/framework/derive.js";

test("get records the key and returns the real value", () => {
  const seen = new Set();
  const p = recorder({ a: 1, b: 2 }, seen);
  expect(p.a).toBe(1);
  expect([...seen]).toEqual(["a"]);
});

test("`in` counts as a read", () => {
  const seen = new Set();
  expect("a" in recorder({ a: 1 }, seen)).toBe(true);
  expect(seen.has("a")).toBe(true);
});

test("spreading, Object.keys, entries and JSON.stringify read every key", () => {
  for (const use of [(p) => ({ ...p }), (p) => Object.keys(p), (p) => JSON.stringify(p), (p) => Object.entries(p)]) {
    const seen = new Set();
    use(recorder({ a: 1, b: 2, c: 3 }, seen));
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  }
});

test("default recorder writes hit a clone; a through recorder writes the original", () => {
  const orig = { a: 1 };
  recorder(orig, new Set()).a = 9;
  expect(orig.a).toBe(1);
  recorder(orig, new Set(), { through: true }).a = 9;
  expect(orig.a).toBe(9);
});

test("expandDerivedReads: grouped attribution, and the fold-everything fallbacks", () => {
  const depsOf = new Map([["area", new Set(["w", "h"])]]);
  expect([...expandDerivedReads(new Set(["x"]), new Set(["area"]), { depsOf, allInputs: new Set(["w", "h", "z"]) })].sort())
    .toEqual(["h", "w", "x"]);
  expect([...expandDerivedReads(new Set(), new Set(["area"]), { depsOf: null, allInputs: new Set(["w", "z"]) })].sort())
    .toEqual(["w", "z"]);
  expect([...expandDerivedReads(new Set(), new Set(["nope"]), { depsOf, allInputs: new Set(["w", "z"]) })].sort())
    .toEqual(["w", "z"]);
});

test("expandReads returns the sink's raw keys sorted", () => {
  const sink = newReadSink();
  sink.raw.add("b"); sink.raw.add("a");
  expect(expandReads(sink)).toEqual(["a", "b"]);
});

const grouped = { derive: { base: (p) => ({ area: p.w * p.h }), vol: (p, d) => ({ vol: d.area * p.t }) } };
const single = { derive: (p) => ({ area: p.w * p.h }) };
const P = () => ({ w: 2, h: 3, t: 4, unused: 5 });

test("resolveDerivedAttributed produces the same d as resolveDerived", () => {
  expect(resolveDerivedAttributed(grouped, P()).d).toEqual(resolveDerived(grouped, P()));
  expect(resolveDerivedAttributed(single, P()).d).toEqual(resolveDerived(single, P()));
  expect(resolveDerivedAttributed({}, P())).toEqual({ d: {}, depsOf: null, allInputs: new Set() });
});

test("grouped attribution is transitive through earlier groups", () => {
  const { depsOf, allInputs } = resolveDerivedAttributed(grouped, P());
  expect([...depsOf.get("area")].sort()).toEqual(["h", "w"]);
  expect([...depsOf.get("vol")].sort()).toEqual(["h", "t", "w"]);
  expect(allInputs.has("unused")).toBe(false);
});

test("a group reading a not-yet-produced key throws the same error as resolveDerived", () => {
  const bad = { derive: { a: (p, d) => ({ x: d.missing }) } };
  expect(() => resolveDerived(bad, P())).toThrow(/derive: group read "missing"/);
  expect(() => resolveDerivedAttributed(bad, P())).toThrow(/derive: group read "missing"/);
});

test("through: a derive that writes to p leaves the write on p, as resolveDerived does", () => {
  const writer = { derive: (p) => { p.extra = p.w * 10; return { area: p.w }; } };
  const a = P(); resolveDerived(writer, a);
  const b = P(); resolveDerivedAttributed(writer, b, { through: true });
  expect(b.extra).toBe(a.extra);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/read-recorder.test.js`
Expected: FAIL. `read-recorder.js` cannot be imported.

- [ ] **Step 3: Implement `read-recorder.js`**

```js
// src/framework/read-recorder.js
// Read recording shared by the relevance PREDICTION (param-deps.js, against the
// probe kernel) and the REAL build path (part-model.js resolveParams, jobs.js,
// the oracle). A LEAF: no imports, so part-model.js may depend on it.
//
// Three traps record: get (p.x), has ("x" in p), ownKeys (Object.keys / spread /
// entries / JSON.stringify — enumerating p makes the result depend on every key).
// Default: a shallow CLONE, so a probe build can't mutate the caller's params.
// `through: true` wraps the object itself — the real path, where derive() and
// build() must see each other's writes exactly as they did unrecorded.
export function recorder(obj, seen, { through = false } = {}) {
  return new Proxy(through ? obj : { ...obj }, {
    get(target, key) {
      if (typeof key === "string") seen.add(key);
      return Reflect.get(target, key);
    },
    has(target, key) {
      if (typeof key === "string") seen.add(key);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      for (const k of keys) if (typeof k === "string") seen.add(k);
      return keys;
    },
  });
}

// One build's reads: raw param keys, derived keys, and the derive attribution
// that maps the second onto the first (set by resolveParams).
export function newReadSink() {
  return { raw: new Set(), dSeen: new Set(), attribution: null };
}

// Raw params behind a build's reads. With no per-key attribution (single-function
// derive, or a key no group produced) every derive input counts — coarser, sound.
export function expandDerivedReads(raw, dSeen, attribution) {
  const out = new Set(raw);
  if (dSeen.size === 0) return out;
  const depsOf = attribution?.depsOf;
  if (depsOf && [...dSeen].every((k) => depsOf.has(k))) {
    for (const k of dSeen) for (const dep of depsOf.get(k)) out.add(dep);
  } else {
    for (const dep of attribution?.allInputs ?? []) out.add(dep);
  }
  return out;
}

export function expandReads(sink) {
  return [...expandDerivedReads(sink.raw, sink.dSeen, sink.attribution)].sort();
}
```

- [ ] **Step 4: Implement `resolveDerivedAttributed`**

Add the following to `src/framework/derive.js` and import `recorder` from `./read-recorder.js`:

```js
// resolveDerived plus attribution: which raw params each derived key came from.
// MUST produce resolveDerived's `d`, throw its errors, and (with through) leave
// its writes on p — tests pin all three; the worker builds with this `d`.
// Grouped form: depsOf maps each key to its own group's raw reads, transitively
// through the earlier groups it read. Single-function form: depsOf is null.
export function resolveDerivedAttributed(part, p, { through = false } = {}) {
  const allInputs = new Set();
  const derive = part.derive;
  if (!derive) return { d: {}, depsOf: null, allInputs };
  if (typeof derive === "function") {
    return { d: derive(recorder(p, allInputs, { through })) ?? {}, depsOf: null, allInputs };
  }
  const d = {};
  const depsOf = new Map();
  for (const fn of Object.values(derive)) {
    const raw = new Set();
    const fromEarlier = new Set();
    const written = new Set();
    const dProxy = new Proxy(d, {
      get(t, key) {
        if (typeof key === "string" && key !== "then") {
          if (!(key in t)) throw new Error(`derive: group read "${key}" before any earlier group produced it`);
          fromEarlier.add(key);
        }
        return Reflect.get(t, key);
      },
      set(t, key, v) {
        if (typeof key === "string") written.add(key);
        return Reflect.set(t, key, v);
      },
    });
    const out = fn(recorder(p, raw, { through }), dProxy) ?? {};
    const deps = new Set(raw);
    for (const k of fromEarlier) for (const dep of depsOf.get(k) ?? []) deps.add(dep);
    for (const r of raw) allInputs.add(r);
    for (const key of [...Object.keys(out), ...written]) {
      depsOf.set(key, deps);
      if (Object.hasOwn(out, key)) d[key] = out[key];
    }
  }
  return { d, depsOf, allInputs };
}
```

- [ ] **Step 5: Point `param-deps.js` at the helpers**

- Delete the private `recorder` and `analyzeDerive`.
- Import `recorder` and `expandDerivedReads` from `./read-recorder.js`, and `resolveDerivedAttributed` from `./derive.js`.
- In `subPartReadKeys`, use `const { d: derived, depsOf, allInputs } = resolveDerivedAttributed(part, params);`. Do not pass `through`: the prediction must never mutate.
- Replace the `if (dSeen.size > 0) { … }` block and the `map.set(name, reads)` after it with `map.set(name, expandDerivedReads(reads, dSeen, { depsOf, allInputs }));`.

Rewrite the file's first comment line to read: `// PREDICTED param dependencies — computed before building, against the geometry-free probe kernel. The mesh cache, panel, pickers and oracle use the reads RECORDED from the real build and fall back to this only for sub-parts not yet built. It is wrong whenever a build branches on a geometry query (isEmpty, volume, …), which the probe answers with stand-ins.`

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/read-recorder.test.js test/param-deps-subpart.test.js test/selection-resolve.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/framework/read-recorder.js src/framework/derive.js src/framework/param-deps.js test/read-recorder.test.js
git commit -m "param-deps: extract the read recorder and attributed derive into leaves"
```

---

### Task 2: `resolveParams` sink, and the worker returns each mesh's reads

**Files:**
- Modify: `src/framework/part-model.js` (`resolveParams`, ~line 41)
- Modify: `src/framework/jobs.js`:
  - the `resolveParams` call (~176)
  - `fontsFor` (~242), `imagesFor` (~342) and `vectorsFor` (~383)
  - `posed` (~393)
  - the `generate` loop (~410)
- Create: `test/fixtures/guarded-part.js`
- Test: `test/recorded-reads-jobs.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `resolveParamsAttributed(part, params, sanitize?) → { p, d, attribution: { depsOf, allInputs } }` (plain objects)
  - `recordedParams({ p, d }, sink) → { p, d }` (record-through recorders into `sink.raw` / `sink.dSeen`)
  - `resolveParams(part, params, sanitize?, reads?)`. With a `reads` sink, it sets `reads.attribution` if that is unset and returns recorded `p` and `d`. Without one, it behaves as today.
  - Each mesh in a `{type:"meshes"}` reply carries `reads: string[]`.

- [ ] **Step 1: Create the fixture and write the failing tests**

```js
// test/fixtures/guarded-part.js
// The shape of feedback #158: a param read only past an isEmpty() guard. The
// probe answers isEmpty() with a truthy stand-in, so it never sees cellR; the
// real build does. Its own module so several test files can share it.
export const guarded = {
  defaults: { size: 20, cellR: 2, unused: 1 },
  views: { v: { label: "V" } },
  parts: {
    insert: { views: ["v"], build: (k, p) => {
      const body = k.box({ min: [0, 0, 0], max: [p.size, p.size, 4] });
      const region = k.box({ min: [2, 2, -1], max: [p.size - 2, p.size - 2, 5] });
      return region.isEmpty() ? body : body.cut(k.cylinder({ r: p.cellR, h: 10 }).translate([p.size / 2, p.size / 2, -2]));
    } },
  },
};
```

```js
// test/recorded-reads-jobs.test.js
import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { subPartReadKeys } from "../src/framework/param-deps.js";
import { resolveParams } from "../src/framework/part-model.js";
import { newReadSink, expandReads } from "../src/framework/read-recorder.js";
import { guarded } from "./fixtures/guarded-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const gen = async (part, subparts, params) => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view: "v", params }, post);
  return post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
};

test("a generate reply carries the keys the real build read, past a geometry guard", async () => {
  const reply = await gen(guarded, ["insert"], guarded.defaults);
  expect(reply.meshes[0].reads).toEqual(["cellR", "size"]);
});

test("the probe prediction misses the guarded param — why recording exists", () => {
  expect(subPartReadKeys(guarded, "v", guarded.defaults).get("insert").has("cellR")).toBe(false);
});

test("derived reads expand to the raw params of their own group", async () => {
  const part = {
    defaults: { w: 4, h: 5, t: 2, other: 9 },
    views: { v: { label: "V" } },
    derive: { area: (p) => ({ side: p.w + p.h }), deep: (p) => ({ depth: p.t * 2 }) },
    parts: { a: { views: ["v"], build: (k, p, d) => k.box({ min: [0, 0, 0], max: [d.side, d.side, 1] }) } },
  };
  expect((await gen(part, ["a"], part.defaults)).meshes[0].reads).toEqual(["h", "w"]);
});

test("place() reads count", async () => {
  const part = {
    defaults: { r: 3, lift: 7 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }),
      place: (s, { p }) => s.translate([0, 0, p.lift]) } },
  };
  expect((await gen(part, ["a"], part.defaults)).meshes[0].reads).toEqual(["lift", "r"]);
});

test("asset declaration reads are attributed to every sub-part in the job", async () => {
  const part = {
    defaults: { art: "", r: 3 },
    views: { v: { label: "V" } },
    vectors: (p) => ({ logo: p.art }),
    parts: {
      a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }) },
      b: { views: ["v"], build: (k) => k.cylinder({ r: 1, h: 2 }) },
    },
  };
  const reply = await gen(part, ["a", "b"], part.defaults);
  expect(reply.meshes.find((m) => m.name === "a").reads).toEqual(["art", "r"]);
  expect(reply.meshes.find((m) => m.name === "b").reads).toEqual(["art"]);
});

test("resolveParams with a sink records gate, build and derived reads", () => {
  const part = { defaults: { a: 1, b: 2, on: true }, derive: { g: (p) => ({ twice: p.b * 2 }) } };
  const sink = newReadSink();
  const { p, d } = resolveParams(part, {}, undefined, sink);
  void p.on; void d.twice;
  expect(expandReads(sink)).toEqual(["b", "on"]);
});
```

The asset test uses `""` as the vector source, so `""` must be a value the job accepts as "no source". Check `isNoVectorSource` in `src/framework/vector-source.js` and use whatever it accepts. The job logs "no vector source declared … skipping" and carries on.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/recorded-reads-jobs.test.js`
Expected: FAIL. `reads` is undefined and `resolveParams` ignores the sink. The probe-prediction test already passes.

- [ ] **Step 3: Implement in `part-model.js`**

Replace `resolveParams` and add the two helpers. Import `resolveDerivedAttributed` from `./derive.js` and `recorder` from `./read-recorder.js`:

```js
// resolveParams plus derive attribution, plain objects. `p` is passed to derive
// itself (through), so a derive that writes p behaves exactly as unrecorded.
export function resolveParamsAttributed(part, params, sanitize) {
  const p = { ...part.defaults, ...params };
  sanitize?.(p);
  const { d, depsOf, allInputs } = resolveDerivedAttributed(part, p, { through: true });
  return { p, d, attribution: { depsOf, allInputs } };
}

// Record-through views of a resolved (p, d) into one read sink. Everything that
// reads them — viewSubParts' enabled(), build(), place(), expect(p, d) — lands in
// the sink with no change to the reader.
export function recordedParams({ p, d }, sink) {
  return { p: recorder(p, sink.raw, { through: true }), d: recorder(d, sink.dSeen, { through: true }) };
}

// `reads` (optional): a newReadSink() (read-recorder.js). When given, the returned
// p/d record every key read into it, and the sink keeps the derive attribution
// expandReads needs. The single seam the oracle threads its sink through.
export function resolveParams(part, params, sanitize, reads) {
  if (!reads) {
    const p = { ...part.defaults, ...params };
    sanitize?.(p);
    return { p, d: resolveDerived(part, p) };
  }
  const resolved = resolveParamsAttributed(part, params, sanitize);
  reads.attribution ??= resolved.attribution;
  return recordedParams(resolved, reads);
}
```

Keep the existing doc comment above `resolveParams`. `buildPosed` is unchanged.

- [ ] **Step 4: Implement in `jobs.js`**

1. Import `resolveParamsAttributed` and `recordedParams` from `./part-model.js`, and `newReadSink` and `expandReads` from `./read-recorder.js`.
2. Change `const { p, d } = resolveParams(part, msg.params, (params) => { … });` to `const { p, d, attribution } = resolveParamsAttributed(part, msg.params, (params) => { … });`. Keep the sanitize body byte for byte.
3. Right after it, add:

```js
    // Params the ASSET declarations read (fonts/images/vectors may be functions
    // of p). A build names an asset, never the param that chose it, so these are
    // attributed to every sub-part this job builds — coarse, sound (spec §1).
    const assetSink = newReadSink();
    const assetP = recordedParams({ p, d }, assetSink).p;
```

4. Pass `assetP` to exactly the three declaration calls: `fontsFor(part, assetP)`, `imagesFor(part, assetP)` and `vectorsFor(part, assetP)`.
5. Under `posed`, add:

```js
    // A display build plus the sorted raw keys it read (spec §1): its own p/d
    // reads, derive-expanded, plus the job's asset-declaration reads.
    const posedWithReads = (name) => {
      const sink = newReadSink();
      sink.attribution = attribution;
      const rec = recordedParams({ p, d }, sink);
      const solid = buildPosed(kernel, part, name, { purpose: "display", view: msg.view, p: rec.p, d: rec.d });
      for (const key of assetSink.raw) sink.raw.add(key);
      return { solid, reads: expandReads(sink) };
    };
```

6. In the `generate` loop only, replace `const m = posed(name, "display").toMesh({ quality: "preview" });` with:

```js
          const { solid, reads } = posedWithReads(name);
          const m = solid.toMesh({ quality: "preview" });
```

   Then add `reads` as the last field of the object pushed into `meshes`. Leave `capture-generate` alone: `captureBuild` claims that reply before the cache sees it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/recorded-reads-jobs.test.js test/cache-jobs.test.js test/images-jobs.test.js test/vectors-jobs.test.js test/export-jobs.test.js test/import-jobs.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/part-model.js src/framework/jobs.js test/fixtures/guarded-part.js test/recorded-reads-jobs.test.js
git commit -m "worker: record the params each sub-part's real build reads and return them with its mesh"
```

---

### Task 3: The mesh cache stamps recorded reads (#158)

**Files:**
- Modify: `src/framework/mesh-cache.js` (whole file)
- Modify: `src/framework/mount.js`:
  - the `case "meshes"` fresh loop (~1065): `cache.record(m.name, m.reads)`
  - the stale-shown loop (~1120): add `cache.forget(m.name)`
- Modify: `test/framework/mount.test.js`, for synthetic replies whose assertions depend on skipping
- Test: `test/mesh-cache-recorded.test.js`

**Interfaces:**
- Consumes: `relevanceHash` (param-deps.js) and `m.reads` (Task 2).
- Produces: `createMeshCache(part, viewer, { params, getView, getParamsVersion, isCaching })` returns:
  - `isCurrent(name): boolean`
  - `record(name, reads?: Iterable<string>)`. When `reads` is `undefined`, the stamp covers every param.
  - `readsOf(name): Set<string> | null`. Returns `null` when nothing is stamped, or when the stamp covers every param.
  - `forget(name)`

- [ ] **Step 1: Write the failing tests**

```js
// test/mesh-cache-recorded.test.js
import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { createMeshCache } from "../src/framework/mesh-cache.js";
import { guarded } from "./fixtures/guarded-part.js";

const makeCache = (params, { caching = true } = {}) => {
  let version = 0, view = "v";
  const cache = createMeshCache(guarded, { hasSubMesh: () => true }, {
    params, getView: () => view, getParamsVersion: () => version, isCaching: () => caching,
  });
  return { cache, bump: () => { version++; }, setView: (v) => { view = v; } };
};

test("a recorded key's change makes the mesh stale (#158: this used to stay current)", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  cache.record("insert", ["cellR", "size"]);
  expect(cache.isCurrent("insert")).toBe(true);
  params.cellR = 3; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});

test("an unrecorded key never invalidates", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  cache.record("insert", ["cellR", "size"]);
  params.unused = 99; bump();
  expect(cache.isCurrent("insert")).toBe(true);
});

test("no reads (old worker / synthetic reply) stamps every param", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  cache.record("insert", undefined);
  expect(cache.readsOf("insert")).toBe(null);
  params.unused = 99; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});

test("the stamp is per view: a tab switch is never current off another view's stamp", () => {
  const { cache, setView } = makeCache({ ...guarded.defaults });
  cache.record("insert", ["size"]);
  setView("other");
  expect(cache.isCurrent("insert")).toBe(false);
});

test("readsOf and forget", () => {
  const { cache } = makeCache({ ...guarded.defaults });
  cache.record("insert", ["size", "size"]);
  expect([...cache.readsOf("insert")]).toEqual(["size"]);
  cache.forget("insert");
  expect(cache.readsOf("insert")).toBe(null);
  expect(cache.isCurrent("insert")).toBe(false);
});

test("caching off: any edit invalidates", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params, { caching: false });
  cache.record("insert", ["size"]);
  params.unused = 2; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
test("#158 end to end over the real worker", async () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  const post = vi.fn();
  await handle(k, guarded, { type: "generate", subparts: ["insert"], view: "v", params }, post);
  cache.record("insert", post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes").meshes[0].reads);
  params.cellR = 4; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});
```

Next, add a mount-level test for the stale-shown branch to `test/framework/mount.test.js`, next to the existing playback tests (`grep -n "lastAnimApplyVersion\|best-effort\|playback" test/framework/mount.test.js`). Model it on the closest existing test that delivers a stale reply during playback. Assert that after the stale-shown delivery the sub-part is no longer current: the next build counts it as rebuilt in the debug overlay, or whatever observable the neighbouring test uses.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/mesh-cache-recorded.test.js`
Expected: FAIL. The first test stays current, `readsOf` is not a function, and the view test passes as current.

- [ ] **Step 3: Implement**

```js
// src/framework/mesh-cache.js
import { relevanceHash } from "./param-deps.js";

// Whether each sub-part's cached display mesh is still valid ("Layer 1": skip
// regenerating sub-parts whose inputs didn't change). Each delivered mesh is
// stamped with the params its REAL build read (recorded in the worker, jobs.js),
// their values, and the view it was built for. It stays current while those are
// unchanged — sound for a deterministic build: unchanged reads replay the same
// path (spec 2026-10-03). Nothing is predicted; a sub-part with no stamp is not
// current. `params` is a stable object mutated in place; the rest are getters.
export function createMeshCache(part, viewer, { params, getView, getParamsVersion, isCaching }) {
  const stamps = {}; // name -> { keys: string[] | null (null = every param), hash, view }

  const hashOf = (keys) => {
    if (!isCaching()) return `v${getParamsVersion()}`; // caching off: any edit invalidates
    return relevanceHash(keys ?? Object.keys(params), params);
  };

  return {
    isCurrent: (name) => {
      const s = stamps[name];
      return viewer.hasSubMesh(name) && s != null && s.view === getView() && s.hash === hashOf(s.keys);
    },
    // Stamp a mesh built at the LIVE params (mount's fresh branch, or the pose
    // fast path's in-place repair). `reads` undefined = unknown → every param.
    record: (name, reads) => {
      const keys = reads == null ? null : [...new Set(reads)].sort();
      stamps[name] = { keys, hash: hashOf(keys), view: getView() };
    },
    readsOf: (name) => (stamps[name]?.keys ? new Set(stamps[name].keys) : null),
    forget: (name) => { delete stamps[name]; },
  };
}
```

In `mount.js`:
- In the fresh `meshes` loop, change `cache.record(m.name);` to `cache.record(m.name, m.reads);`.
- In the stale-shown loop (the one that calls `fastPath.forget(m.name)`), add `cache.forget(m.name);` beside that call, with this comment: `// the stamp described the last FRESH delivery; this mesh was built at other params, so no stamp may describe it (spec §2)`.

`pose-fast-path.js` keeps `cache.record(name);` for now, since an undefined stamp is safe. Task 4 replaces it.

- [ ] **Step 4: Run the full suite and fix synthetic fixtures**

Run: `npm test`

Mount tests feed synthetic `meshes` replies without `reads`, so those replies now stamp every param, and any test asserting skip or pose counts will fail. For example, `"a mixed edit reports the posed sub-part alongside the rebuilt one"` (`test/framework/mount.test.js` ~1098) fails on **"0 posed"**: an every-param stamp makes `arm` stale on the second height edit, and the fast path re-poses it.

For each failing test, add `reads` to its synthetic meshes, matching what that fixture's build actually reads. In the mixed test that is `body` → `["h"]` and `arm` → `["tilt"]` (see `makeMixedPart`). Do not change the expected counts: they are right, and the fixtures were the incomplete part.

Expected after the fixture updates: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/mesh-cache.js src/framework/mount.js test/mesh-cache-recorded.test.js test/framework/mount.test.js
git commit -m "mesh cache: stamp each delivered mesh with its real build's reads and view (#158)"
```

---

### Task 4: The pose fast path records the union of reads

**Files:**
- Modify: `src/framework/pose-probe.js` (`probePoses`)
- Modify: `src/framework/pose-fast-path.js` (`repair`)
- Test: `test/pose-probe.test.js` (append)

**Interfaces:**
- Consumes:
  - `recordedParams` and `resolveParamsAttributed` (Task 2)
  - `newReadSink` and `expandReads` (Task 1)
  - `cache.readsOf` and `cache.record` (Task 3)
- Produces: each trusted `probePoses(...)` entry gains `reads: string[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/pose-probe.test.js`:

```js
import { probePoses as probePosesWithReads } from "../src/framework/pose-probe.js";

test("a trusted pose probe reports the raw params build+place read, derive expanded", () => {
  const part = {
    defaults: { r: 3, lift: 7, other: 1 },
    views: { v: { label: "V" } },
    derive: { pose: (p) => ({ z: p.lift * 2 }) },
    parts: { a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }),
      place: (s, { d }) => s.translate([0, 0, d.z]) } },
  };
  const entry = probePosesWithReads(part, "v", part.defaults).get("a");
  expect(entry.trusted).toBe(true);
  expect(entry.reads).toEqual(["lift", "r"]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/pose-probe.test.js`
Expected: FAIL. `entry.reads` is undefined.

- [ ] **Step 3: Implement**

`pose-probe-core.js` is unchanged. It already uses whatever `p` and `d` it is given, so recording is the caller's job, and its import closure stays as it is.

In `pose-probe.js`, change the `resolveParams` import to `resolveParamsAttributed, recordedParams`, and import `newReadSink` and `expandReads` from `./read-recorder.js`. Then:

```js
    resolved = resolveParamsAttributed(part, params);
    assets = h("assets", JSON.stringify(assetSources(part, resolved.p), byteAwareReplacer));
  // …catch unchanged…
  for (const name of viewSubParts(part, view, params)) {
    const sink = newReadSink();
    sink.attribution = resolved.attribution;
    const rec = recordedParams(resolved, sink);
    const entry = probeSubPartPose(part.parts[name], { view, purpose: "display", p: rec.p, d: rec.d });
    out.set(name, entry.trusted
      ? { ...entry, baseHash: h("with-assets", entry.baseHash, assets), reads: expandReads(sink) }
      : entry);
  }
```

`resolved.p` is private to this call, so a probe build that writes to `p` affects nothing outside it, exactly as before.

In `pose-fast-path.js` `repair()`, replace `cache.record(name);` with:

```js
        // Same geometry, new pose: the delivered build's reads plus whatever
        // place() read at THIS pose (spec §2). An unknown stamp stays unknown.
        const had = cache.readsOf(name);
        cache.record(name, had ? [...had, ...(now.reads ?? [])] : undefined);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pose-probe.test.js test/lint-purity.test.js test/sheet-pose.test.js`, then `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/pose-probe.js src/framework/pose-fast-path.js test/pose-probe.test.js
git commit -m "pose fast path: re-stamp a re-posed mesh with the pose probe's reads too"
```

---

### Task 5: One ladder for display consumers; panel, pick, measure, `controlsFor`

**Files:**
- Modify: `src/framework/param-deps.js` (adds `subPartParamKeys` and `recordedRelevantKeys`)
- Modify: `src/framework/selection/resolve.js:27-36`
- Modify: `src/framework/measure/measure-mode.js:136-163`
- Modify: `src/framework/mount.js`:
  - `createMeasureMode` options (~596)
  - `getContext` (~793)
  - `updateRelevance` (~1251)
  - the fresh `meshes` branch
  - `makeHandle` (line 72 and the call that builds the handle)
- Test: `test/param-deps-subpart.test.js` and `test/selection-resolve.test.js` (append to both)

**Interfaces:**
- Consumes: `cache.readsOf` (Task 3).
- Produces:
  - `subPartParamKeys(part, view, params, readsOf: ((name) => Set|null) | undefined, name): string[]`. Tries recorded reads, then the prediction, then every key; the result is sorted.
  - `recordedRelevantKeys(part, view, params, readsOf): Set<string> | typeof RELEVANT_ALL`
  - `resolveSelection(part, ctx, hit)`, which now honours `ctx.readsOf`.
  - `createMeasureMode(viewer, { …, getReads?: (name) => Set|null })`
  - `handle.controlsFor(selection: { subPart: string }): string[]`

- [ ] **Step 1: Write the failing tests**

Append to `test/param-deps-subpart.test.js`:

```js
import { recordedRelevantKeys, subPartParamKeys } from "../src/framework/param-deps.js";

const gated = {
  defaults: { pattern: "random", cellR: 2, showLid: false, lidT: 1, size: 10 },
  views: { v: { label: "V" } },
  parts: {
    body: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.size, p.size, 1] }) },
    lid: { views: ["v"], enabled: (p) => p.showLid, build: (k, p) => k.box({ min: [0, 0, 0], max: [1, 1, p.lidT] }) },
  },
};

test("recorded relevance: union of on-screen recorded reads plus every in-view gate", () => {
  const readsOf = (n) => (n === "body" ? new Set(["size", "pattern"]) : null);
  const r = recordedRelevantKeys(gated, "v", gated.defaults, readsOf);
  expect([...r].sort()).toEqual(["pattern", "showLid", "size"]);   // cellR dims: the build never read it
});

test("recorded relevance: a sub-part not yet built contributes its prediction", () => {
  const params = { ...gated.defaults, showLid: true };
  const readsOf = (n) => (n === "body" ? new Set(["size"]) : null);
  const r = recordedRelevantKeys(gated, "v", params, readsOf);
  expect(r.has("lidT")).toBe(true);
  expect(r.has("size")).toBe(true);
});

test("subPartParamKeys: recorded, else predicted, else everything", () => {
  expect(subPartParamKeys(gated, "v", gated.defaults, () => new Set(["cellR"]), "body")).toEqual(["cellR"]);
  expect(subPartParamKeys(gated, "v", gated.defaults, () => null, "body")).toEqual(["size"]);
  expect(subPartParamKeys(gated, "v", gated.defaults, undefined, "nope")).toEqual(Object.keys(gated.defaults).sort());
});
```

Append to `test/selection-resolve.test.js`:

```js
test("scopeParams prefers the recorded reads in ctx.readsOf", () => {
  const part = { defaults: { a: 1, b: 2, c: 3 }, views: { v: { label: "V" } },
    parts: { s: { views: ["v"], build: (k, p) => k.cylinder({ r: p.a, h: 1 }) } } };
  const ctx = { view: "v", params: { a: 1, b: 2, c: 3 }, readsOf: () => new Set(["c"]) };
  const sel = resolveSelection(part, ctx, { subPart: "s", pointLocal: [0, 0, 0], normalLocal: [0, 0, 1] });
  expect(sel.params).toEqual({ c: 3 });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/param-deps-subpart.test.js test/selection-resolve.test.js`
Expected: FAIL. The new functions are not exported, and `sel.params` is `{ a: 1 }`.

- [ ] **Step 3: Implement both helpers in `param-deps.js`**

```js
// Which params one sub-part depends on, for DISPLAY consumers (pick scoping,
// measure flash, runtime.controlsFor): its last real build's recorded reads
// when there are any, else the prediction, else every param. The one ladder —
// feature-level precision lands here later (spec §5).
export function subPartParamKeys(part, view, params, readsOf, name) {
  const rec = readsOf?.(name);
  if (rec) return [...rec].sort();
  const reads = subPartReadKeys(part, view, params);
  const keys = reads === RELEVANT_ALL ? Object.keys(params) : [...(reads.get(name) ?? Object.keys(params))];
  return keys.sort();
}

// Panel relevance from RECORDED reads: the union over on-screen sub-parts (a
// not-yet-built one contributes its prediction — display only, so a wrong guess
// costs one build's dimming), plus the gate params of every in-view sub-part.
export function recordedRelevantKeys(part, view, params, readsOf) {
  try {
    const relevant = new Set();
    let predicted = null;
    for (const name of viewSubParts(part, view, params)) {
      const rec = readsOf(name);
      if (rec) { for (const k of rec) relevant.add(k); continue; }
      predicted ??= subPartReadKeys(part, view, params);
      if (predicted === RELEVANT_ALL) return RELEVANT_ALL;
      for (const k of predicted.get(name) ?? []) relevant.add(k);
    }
    for (const name of Object.keys(part.parts)) {
      const sp = part.parts[name];
      if (sp.views.includes(view) && sp.enabled) sp.enabled(recorder(params, relevant));
    }
    return relevant;
  } catch {
    return RELEVANT_ALL;
  }
}
```

- [ ] **Step 4: Route pick and measure through the ladder**

In `selection/resolve.js`, replace `scopeParams` with:

```js
// Only the params the clicked sub-part reads — "this geometry, at these inputs".
// Recorded from its last real build when the host passes ctx.readsOf (mount's
// mesh cache), else predicted (param-deps.subPartParamKeys).
function scopeParams(part, ctx, subPart) {
  const out = {};
  for (const k of subPartParamKeys(part, ctx.view, ctx.params, ctx.readsOf, subPart)) out[k] = ctx.params[k];
  return out;
}
```

Change its import to `subPartParamKeys`, and change its call site to `params: scopeParams(part, ctx, hit.subPart),`.

In `measure/measure-mode.js`:
- Add `getReads` to `createMeasureMode`'s destructured options.
- Replace the body of `readKeysFor` with:

```js
    const { view, params } = getContext();
    return subPartParamKeys(part, view, params, getReads, subPart);
```

- Delete the now-unused `readsFor` memo, its `readsKey`/`readsMap` state and its comment.
- Fix the imports: add `subPartParamKeys`, and drop `subPartReadKeys` and `RELEVANT_ALL` if they are no longer used.
- Keep `getParamsVersion` only if something else in the file still uses it (`grep` to check). If nothing does, remove it here and at its `mount.js` call site.

- [ ] **Step 5: Wire `mount.js`**

1. `createMeasureMode(viewer, { …, getReads: (name) => cache.readsOf(name) })`. The closure runs long after `const cache` initializes, so no thunk is needed.
2. `getContext` returns `{ view: view(), params, derived, readsOf: (name) => cache.readsOf(name) }`.
3. `updateRelevance`:
   - Import `recordedRelevantKeys` in place of `relevantParamKeys`.
   - Call `panel.refresh({ relevant: recordedRelevantKeys(part, view(), params, (n) => cache.readsOf(n)), derived })`.
   - Make `updateRelevance` a `let` declared before `createRegenLoop` (`let updateRelevance = () => {};`), and assign the real function where it is defined today. The message handler calls it, and a worker that replies synchronously must not hit the TDZ.
4. In the fresh `meshes` branch, call `updateRelevance();` after `refreshView();`, so dimming follows each delivery.
5. Add `controlsFor` to `makeHandle`'s parameter list and return object (`controlsFor: controlsFor ?? (() => [])`, following how `getPanelState` is defaulted). Pass it from mount:

```js
      // The param keys relevant to a pick — today the clicked sub-part's recorded
      // reads (spec §5). The one place a host asks "which controls shape this?".
      controlsFor: (selection) => subPartParamKeys(part, view(), params, (n) => cache.readsOf(n), selection?.subPart),
```

   Import `subPartParamKeys` into mount.js.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/param-deps-subpart.test.js test/selection-resolve.test.js`, then `npm test`
Expected: all PASS. A mount test that asserts dim state right after an edit will now see the change only after the synthetic `meshes` reply. Move that assertion after the reply. Do not change the expected state.

- [ ] **Step 7: Commit**

```bash
git add src/framework/param-deps.js src/framework/selection/resolve.js src/framework/measure/measure-mode.js src/framework/mount.js test/param-deps-subpart.test.js test/selection-resolve.test.js
git commit -m "panel, pick and measure share one recorded-first ladder; add runtime.controlsFor"
```

---

### Task 6: The oracle records `measure()`'s reads; verify reuses by them

**Files:**
- Modify: `src/framework/oracle/build.js` (`buildView`)
- Modify: `src/framework/assembly.js` (`assemblyOverlaps`)
- Modify: `src/framework/oracle/gates.js` (`partWallBands`, ~90)
- Modify: `src/framework/oracle/measure.js`:
  - `evaluateProbes` (~98)
  - `measure` (~218)
  - `sheetParams` (~262)
  - the `return` (~397)
- Modify: `src/framework/jobs.js` (the inspect job, ~566)
- Modify: `src/framework/oracle/verify.js` (~341-420)
- Test: `test/verify.test.js` (append, beside line 82)

**Interfaces:**
- Consumes: `resolveParams(…, reads)` (Task 2), `newReadSink`, `expandReads` and `relevanceHash`.
- Produces:
  - `buildView(kernel, part, view, params, { reads } = {})`
  - `assemblyOverlaps(kernel, part, view, params, { tolerance, reads } = {})`
  - `partWallBands(part, params, reads?)`
  - `measure(…, opts.reads?)`, whose result gains `reads: string[] | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `test/verify.test.js`, next to the dedup test (~82). Use that file's `k`, `tube`, `verify` and `measureReal`:

```js
// The #158 shape in the oracle: the build reads `cell` only past an isEmpty()
// guard, so the probe's read set at defaults never contained it and the
// "Fine" preset used to reuse the defaults measurement.
const guardedTube = () => ({
  meta: { title: "Guarded", units: "mm" },
  defaults: { cell: 2, label: "a" },
  parameters: [{ id: "b", presets: { Fine: { cell: 4 }, Relabel: { label: "z" } } }],
  views: { v: { label: "V" } },
  parts: { tube: { views: ["v"], build: (kk, p) => {
    const body = kk.cylinder({ r: 8, h: 10 });
    return body.isEmpty() ? body : body.cut(kk.cylinder({ r: p.cell, h: 14 }).translate([0, 0, -2]));
  } } },
});

test("cases differing only in a geometry-guarded param are measured separately", () => {
  const part = { ...guardedTube(), verify: { cases: ["defaults", "Fine", "Relabel"], expect: { tube: { holes: 1 } } } };
  let calls = 0;
  const measureFn = (...args) => { calls++; return measureReal(...args); };
  verify(k, part, { measureFn });
  expect(calls).toBe(2);   // defaults + Fine; Relabel (unread) still reuses defaults
});

test("measure() reports the params it read; a prebuilt view without a sink reports none", () => {
  const part = guardedTube();
  expect(measureReal(k, part, "v", {}).reads).toEqual(["cell"]);
  const built = buildView(k, part, "v", {});
  expect(measureReal(k, part, "v", {}, { built }).reads).toBe(undefined);
});

test("a stub measureFn without reads is reused only on identical params", () => {
  const part = { ...tube(12, 10), verify: { cases: ["defaults", "Relabel"], expect: { tube: { holes: 1 } } } };
  let calls = 0;
  const stub = (...args) => { calls++; return { ...measureReal(...args), reads: undefined }; };
  verify(k, part, { measureFn: stub });
  expect(calls).toBe(2);
});
```

Add `import { buildView } from "../src/framework/oracle/build.js";` to the file's imports.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/verify.test.js`
Expected: FAIL. The guarded part is measured once, and `reads` is undefined.

- [ ] **Step 3: Thread the sink through the five consumers**

- `oracle/build.js`: change the signature to `buildView(kernel, part, view, params = {}, { reads } = {})`, and change the first line to `const { p, d } = resolveParams(part, params, undefined, reads);`.
- `assembly.js`: change the `assemblyOverlaps` options to `{ tolerance = 1, reads } = {}`, and change the first line to `const { p, d } = resolveParams(part, params, undefined, reads);`.
- `oracle/gates.js`: change the signature to `partWallBands(part, params = {}, reads)`. Inside the function form, call `resolveParams(part, params, undefined, reads)`. Leave the case loop at ~37 alone.
- `oracle/measure.js`:
  - `evaluateProbes(kernel, part, params, reads)` should call `resolveParams(part, params, undefined, reads)`.
  - At the top of `measure`, add:

```js
  // Every param this measurement depends on (spec §4): one sink through all five
  // places it resolves params. A caller-supplied view (`opts.built`) is only
  // covered when the caller recorded its build into the same sink (opts.reads);
  // otherwise the result claims no reads and verify reuses it only on identical
  // params.
  const reads = opts.reads ?? newReadSink();
  const readsKnown = !opts.built || !!opts.reads;
```

  - Pass `{ reads }` to `buildView` and `reads` to `partWallBands`.
  - Use `resolveParams(part, params, undefined, reads)` for `sheetParams`. This also covers `printPoseBboxes`, which uses `sheetParams`.
  - Pass `reads` to `evaluateProbes` and `{ reads }` to `assemblyOverlaps`.
  - Add `reads: readsKnown ? expandReads(reads) : undefined,` to the returned object, beside `measuredMinWall`.
- `jobs.js` inspect (~566):

```js
      const reads = newReadSink();
      const built = buildView(kernel, part, view, msg.params ?? {}, { reads });
      const measured = measure(kernel, part, view, msg.params ?? {}, { …existing opts…, built, reads });
```

  This is the seed the cloud's quick lap reuses, so it must carry reads.

- [ ] **Step 4: Reuse by reads in `verify.js`**

Replace `readKeys`, `signature` and `memo` with an entry list:

```js
  // Reuse rule (spec §4): case B may reuse a measurement taken at params A when
  // B agrees with A on every param that measurement READ (recorded by measure()
  // itself). Sound for the same reason the mesh cache is: a deterministic build
  // whose reads are unchanged replays the same path. A result with no recorded
  // reads (a stub measureFn, or a caller-built view) is reused on identical
  // params only.
  const full = (params) => ({ ...part.defaults, ...(params ?? {}) });
  const entries = []; // { params: full params, result }
  const findEntry = (params) => entries.find((e) => {
    const keys = e.result?.reads ?? Object.keys({ ...e.params, ...params });
    return relevanceHash(keys, params) === relevanceHash(keys, e.params);
  });
```

- In the seed admission, change `memo.set(signature(...), seed.result)` to `entries.push({ params: full(seed.params), result: seed.result });`.
- Rewrite `measureCase`:

```js
  const measureCase = (params) => {
    const fp = full(params);
    const hit = findEntry(fp);
    if (hit) return hit.result;
    if (quick) return null;   // a case the seed does not cover — reported, never built
    const result = measureFn(kernel, part, view, params,
      { minWall: needMinWall, probes: false, overhang: overhangAngle, printBboxes: needPrintBboxes });
    entries.push({ params: fp, result });
    return result;
  };
```

- Update the comments near the seed (~380-384) that mention "signature" so they describe the reads rule.
- Keep the `relevanceHash` import. Remove `subPartReadKeys` and `RELEVANT_ALL` from verify.js's imports if nothing else uses them (check with `grep -n`).

- [ ] **Step 5: Run the oracle suite**

Run: `npx vitest run test/verify*.test.js test/oracle-cache.test.js test/lint-verify.test.js test/jobs-match.test.js` and any `test/*inspect*.test.js`
Expected: all PASS, including:
- the existing dedup test (~82: 3 cases, 2 measures);
- the seed test (~423: `Relabel` reuses the seed, 0 measures).

If a test with a stub `measureFn` now measures more often, that is the "identical params only" rule taking effect. Confirm the stub returns no `reads`, then update the expected count with a comment citing spec §4.

- [ ] **Step 6: Commit**

```bash
git add src/framework/oracle src/framework/assembly.js src/framework/jobs.js test/verify.test.js
git commit -m "oracle: measure() records the params it read; verify reuses a case only when they agree"
```

---

### Task 7: Soundness property test, docs, version

**Files:**
- Create: `test/recorded-reads-soundness.test.js`
- Modify: `docs/AUTHORING-PARTS.md` and/or `docs/KERNEL-CONTRACT.md`. To find the right place, run `grep -n "relevan\|dim\|isEmpty" docs/AUTHORING-PARTS.md docs/KERNEL-CONTRACT.md`.
- Modify: `package.json` and `package-lock.json` (the version)

**Interfaces:**
- Consumes: `handle` (Task 2), `relevanceHash`, `h` (`src/framework/geometry/solid-hash.js`) and `viewSubParts`.

- [ ] **Step 1: Write the property test**

```js
// test/recorded-reads-soundness.test.js
// The rule the cache and the oracle rest on: if a param change leaves every
// recorded read's value unchanged, a real rebuild produces the same mesh.
// Checked over shipped parts: build at defaults, nudge each param in turn.
import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { viewSubParts } from "../src/framework/part-model.js";
import { relevanceHash } from "../src/framework/param-deps.js";
import { h } from "../src/framework/geometry/solid-hash.js";
import { guarded } from "./fixtures/guarded-part.js";
import demo from "../src/parts/demo.js";
import bracket from "../src/parts/bracket.js";
import planter from "../src/parts/planter.js";
import hingedBox from "../src/parts/hinged-box.js";
import gasket from "../src/parts/gasket.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const nudge = (v) => (typeof v === "number" ? v + (Math.abs(v) > 1 ? 1 : 0.1) : typeof v === "boolean" ? !v : undefined);
const fingerprint = (m) => h(String(m.triangles), Array.from(m.positions).map((x) => x.toFixed(4)).join(","));

async function build(part, view, params) {
  const subparts = viewSubParts(part, view, { ...part.defaults, ...params });
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view, params, cache: false }, post);
  const reply = post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
  return reply ? new Map(reply.meshes.map((m) => [m.name, m])) : null;
}

for (const [label, part] of Object.entries({ guarded, demo, bracket, planter, hingedBox, gasket })) {
  test(`${label}: unchanged recorded reads ⇒ identical mesh`, async () => {
    const view = Object.keys(part.views)[0];
    const base = await build(part, view, {});
    expect(base, `${label} should build at defaults`).not.toBe(null);
    for (const [key, v] of Object.entries(part.defaults)) {
      const next = nudge(v);
      if (next === undefined) continue;
      const params = { ...part.defaults, [key]: next };
      const after = await build(part, view, params);
      if (!after) continue; // a nudge into an invalid value fails the build — not this test's subject
      for (const [name, m] of base) {
        if (!after.has(name)) continue;
        if (relevanceHash(m.reads, part.defaults) !== relevanceHash(m.reads, params)) continue;
        expect(fingerprint(after.get(name)), `${label}.${name} after ${key}`).toBe(fingerprint(m));
      }
    }
  }, 60_000);
}
```

Before running it, check two things:
- **The five shipped parts.** Confirm they exist and build in the test harness without fonts or images: `ls src/parts`, and look at how other tests import them. Replace any that needs assets with a sibling that doesn't.
- **`h`'s signature in `solid-hash.js`.** If it is not variadic over strings, join the parts before hashing.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/recorded-reads-soundness.test.js`
Expected: PASS. A failure means some build reads something outside `p` and `d`, or is nondeterministic. Investigate that build. Do not loosen the assertion.

- [ ] **Step 3: Docs**

Find where the docs describe panel dimming or the probe's role in it. If neither doc covers it, put this next to the `isEmpty()` guard example in AUTHORING-PARTS.md:

```md
**Which controls a sub-part depends on** is recorded from its real build. The worker notes every `p` and `d` key that `build()` and `place()` read:
- a derived key expands to the params its `derive` group read;
- a param read by a `fonts`, `images` or `vectors` declaration counts for every sub-part.

The viewer rebuilds a sub-part only when one of those values changes. The panel dims a control that no on-screen sub-part read. `verify` reuses a case's measurement only when the case agrees on the params that measurement read. Geometry-guarded branches such as `if (!pocket.isEmpty())` need no special handling.

Builds must stay pure functions of `(k, p, d)`. They receive `p` and `d` through a read-recording Proxy, so use them like plain objects. Don't `structuredClone` them.
```

- [ ] **Step 4: Version bump**

Run: `npm version 0.140.0 --no-git-tag-version`
Expected: both `package.json` and `package-lock.json` read `0.140.0`.

- [ ] **Step 5: Full suite plus lint**

Run: `npm test`, then whatever lint and knip scripts `package.json` defines (`grep -n '"lint\|"knip' package.json`).
Expected: all PASS. Fix anything this branch introduced. `relevantParamKeys` is still exported through `src/testing.js`, so knip should not flag it.

- [ ] **Step 6: Commit**

```bash
git add test/recorded-reads-soundness.test.js docs/ package.json package-lock.json
git commit -m "recorded param deps: soundness property test, docs, 0.140.0"
```

# Recorded param dependencies: track what the real build reads

**Status:** design, 2026-10-03
**Trigger:** partforge-cloud feedback #158. The mesh insert's lattice controls (cell size, web, pattern) stopped updating the model, and the panel dimmed them as unrelated.

## The problem

partforge decides which params each sub-part depends on **before** building it. It does this by running the build against the geometry-free probe kernel with `p` and `d` wrapped in read recorders (`subPartReadKeys`, `param-deps.js`). That prediction feeds:

- the mesh cache's Layer 1 skip (`mesh-cache.js`): a sub-part whose read params did not change is not rebuilt;
- panel dimming (`relevantParamKeys` → `panel.refresh`);
- the params a pick carries (`selection/resolve.js` `scopeParams`, which the cloud's pick prompt forwards to the agent);
- measure mode's control flash (`measure-mode.js` `readKeysFor`);
- the oracle's per-case rebuild memo (`oracle/verify.js` `signature`).

The probe returns stand-in answers for geometry queries, so it is wrong whenever the build branches on geometry. In #158 the part does:

```js
region.isEmpty() ? null : latticeHoles(region, p.cellR, p.web, p.pattern)
```

`isEmpty` is not stubbed. On the probe it returns a truthy proxy, so the probe takes the `null` branch and never reads `cellR`, `web` or `pattern`. Layer 1 then skips the rebuild when those change, and the panel dims them. The same failure happens with every query the probe cannot answer honestly:

- `isEmpty`, `contains`, `area`, `toRegions` and `genus` return proxies;
- `boundingBox` and `volume` return fixed dummies, so `if (s.volume() < min)` takes a fixed branch;
- a `while (!s.isEmpty())` loop is cut short.

The docs teach the `isEmpty()` guard (AUTHORING-PARTS.md, KERNEL-CONTRACT.md), so this is the pattern we tell authors to write.

Tuning the stubs does not fix this. Any fixed answer picks one branch and misses the reads on the others. Returning `false` for `isEmpty` would hang `while (!s.isEmpty())` loops, because `createProbeKernel` has no op cap.

## The idea

Stop predicting. **Record what the real build reads, and stamp the cached mesh with it.**

The worker already runs every sub-part's real `build()` (`jobs.js` → `buildPosed`). Wrap `p` and `d` there in the same read recorder `param-deps.js` uses. Send the read set back with each mesh, and let the mesh cache judge "is this still current?" against **the keys the build that produced it actually read**.

### Why this is sound, not just more accurate

This is the standard rule for incremental rebuilds (spreadsheets, build systems, React dependency arrays). Assume the build is deterministic: its result depends only on `p`, `d`, the kernel and declared assets. Then:

> If none of the values a build read have changed, re-running it takes exactly the same path and produces the same result.

Every branch condition, including `isEmpty()` and `volume() < x`, is computed from things the build read. A param read only on the other side of a branch cannot change the result without first changing something on the path that *was* read, and that change already triggers a rebuild. So the recorded set is the minimum safe dependency set for the geometry on screen, with no stub tuning and no special cases for loops.

The cache already depends on this determinism. Layer 2, the worker's op-hash solid memo, would serve wrong geometry without it.

## Design

### 1. Recording in the worker (`jobs.js`, `part-model.js`, `derive.js`)

**One seam: `resolveParams`.** Every place that turns raw params into what a build sees goes through `resolveParams(part, params)` in `part-model.js`: the worker's job, the oracle's `buildView`, `assemblyOverlaps`, `partWallBands`, `evaluateProbes` and the sheet facts. It gains an optional `reads` sink. When the sink is given, the returned `p` and `d` are read recorders, and `viewSubParts(part, view, p)`, `build` and `place` all record through them with no further changes. The sink holds three things: raw reads, derived-key reads, and the derive attribution. `expandReads(sink)` turns it into the sorted raw keys.

The recorder is `param-deps.js`'s `recorder`, which moves to a small leaf module so `part-model.js` stays a leaf. It gains two traps beyond `get`:
- `has`, so `"x" in p` counts;
- `ownKeys`, so `Object.keys(p)`, a spread and `JSON.stringify` count as reading every key.

**Record-through, not a clone, on the real path.** The probe's recorder wraps a shallow clone so a probe build can't mutate the caller's params. On the real path that would change behaviour: today `derive` receives the real resolved `p`, and build sees any write `derive` makes to it. The real path's recorder therefore wraps the resolved object itself, and writes land exactly where they land today. Builds receive `p` and `d` through a Proxy, so `structuredClone(p)` inside a build would throw. No shipped part does this, and the docs will say so.

**Derived reads.** With a sink, `resolveParams` gets `d` from a resolver that returns `{ d, depsOf, allInputs }`: `analyzeDerive`'s attribution, run once instead of as a second, separate evaluation. It must produce the same `d` as `resolveDerived`, throw the same errors, and leave the same writes on `p`. Tests will pin all three. A sub-part's `d` reads expand to raw params through `depsOf`, the same rule `subPartReadKeys` uses today:
- grouped derive: each derived key maps to the params its own group read;
- single-function derive, or a key no group produced: every derive input counts.

**Asset declarations.** `fonts`, `images` and `vectors` can be functions of `p` (`asset-decls.js`). A build refers to an asset by name, so the param that chose it is never read inside `build()`. The job records what each declaration reads and adds those reads to **every sub-part in the job**. This is coarse: changing an asset param rebuilds every sub-part. It is sound, assets change rarely, and attributing reads per asset kind can come later. The sanitize hook only rewrites values, so it records nothing.

**The gate.** On the main thread, `enabled()` reads keep feeding panel relevance directly, as they do today. They are cheap and pure, and they decide whether a sub-part is on screen at all, so a mesh stamp does not need them. The oracle does count them, through the recorded `p`, so a case that flips a gate is never reused.

**Wire shape.** Each entry in the `meshes` reply gains `reads: string[]`, the sorted raw param keys after derive and asset attribution. `capture-meshes` does not carry them: `captureBuild` claims that reply before the cache sees it, so nothing would read them. A reply without `reads` comes from an older worker or a host's synthetic reply, and it means "unknown", treated as every param. Old hosts and new hosts stay compatible in both directions.

### 2. The mesh cache keys on recorded reads (`mesh-cache.js`)

`createMeshCache` stops calling `subPartReadKeys`:

```js
record(name, reads)   // reads: string[] | undefined (undefined = every param)
isCurrent(name)       // hasSubMesh && stamp.view === view() && stamp.hash === relevanceHash(stamp.keys, params)
readsOf(name)         // Set of recorded keys, or null when nothing is recorded for this name
forget(name)
```

The stamp holds the keys, the hash and the view. The view closes an old hole: `viewer.hasSubMesh` is keyed by name only, and `place()` receives the view, so a sub-part shared between two tabs with a view-dependent pose could read as current across a tab switch. Because `meshes` is only recorded when `loop.buildDone()` reports the reply fresh, the live params are exactly the params the build ran at. That makes `relevanceHash(keys, params)` at record time correct, with no need to carry the dispatched snapshot. Turning caching off keeps today's `v${version}` behaviour.

**Meshes shown without a stamp.** During animation playback, a stale delivery is shown best-effort (mount.js, the `lastAnimApplyVersion` branch). Today only `fastPath.forget` runs there, so the cache stamp still describes the previous fresh delivery. A looping animation that comes back to the stamp's values would then read as current while showing geometry built at other params. That branch now also calls `cache.forget(name)`.

**The pose fast path.** `fastPath.repair()` re-poses a mesh and calls `cache.record(name)`. With recorded reads, the repair must also record the keys it re-stamps under, because `place()` may read different keys at the new pose. `probeSubPartPose` records its reads too, and `repair()` calls `cache.record(name, union)`, where `union` combines `cache.readsOf(name)` and the pose probe's reads. The pose probe only counts as trusted when it made no queries (`state.queried`), so it cannot reproduce the #158 failure.

### 3. Consumers move to recorded reads

| Consumer | Today | After |
| --- | --- | --- |
| Mesh cache (Layer 1) | probe prediction | recorded reads (§2) |
| Panel dimming (`relevantParamKeys`) | probe prediction | union of the recorded reads of on-screen sub-parts, plus gate reads of every in-view sub-part |
| Pick params (`selection/resolve.js`) | probe prediction | `cache.readsOf(subPart)` |
| Measure flash (`measure-mode.js`) | probe prediction | `cache.readsOf(subPart)` |
| Oracle case memo (`oracle/verify.js`) | probe prediction at defaults | reads recorded by each `measure()` (§4) |
| Backend routing (`detectBackends`) | probe | **unchanged**: must decide before building, and has a runtime OCCT fallback. A param only the probe reads can flip a sub-part's backend while the cache keeps it current. The geometry is the same, so the only effect is a tessellation difference until the next real rebuild. |
| Lint (`runValidatingProbe`) | probe | **unchanged** |
| Pose fast path (`probePoses`) | hashing probe | unchanged, plus read recording (§2) |

**One ladder, one function.** The pick, measure and `controlsFor` paths all answer "which params does this sub-part depend on?" in the same order: recorded reads, then the probe prediction, then every param. That ladder lives once, as `subPartParamKeys(part, view, params, readsOf, name)` in `param-deps.js`.

**Fallback for "never built".** Before a sub-part's first delivery, or after it is toggled on and before its mesh lands, there are no recorded reads. Panel dimming and pick scoping then fall back to the probe prediction (`subPartReadKeys`). These are display-only surfaces, so a wrong guess there costs a dimmed control for one build. The mesh cache never needs a fallback: no mesh means not current. `subPartReadKeys` stays exported and documented as a **prediction** for exactly these cases.

**What dimming means now.** A dimmed control reads as "doesn't affect what's on screen right now". With pattern set to random circles, Cell size dims, which is correct. Switching to hexagon un-dims it once that build lands, because `pattern` was read and its change triggered the build. The panel refresh moves from the param-change path to mesh delivery as well, so relevance never lags behind the geometry. Gate params stay relevant at all times, since toggling one changes which sub-parts exist.

There is a brief lag: between an edit that changes the build's path and that build landing, the panel shows the old build's relevance. Dimmed controls remain editable (dimming is only visual), so the user is never blocked. This also gets cheaper: the panel used to run a probe build on every slider input event, and now it takes a union of stored sets.

### 4. The oracle memo

`verify.js` decides whether case B can reuse case A's measurement by comparing a signature computed from the probe's read set **at defaults**. That is the same bug in a worse place: a case that differs only in a param behind an `isEmpty` guard reuses the wrong geometry and gets a wrong verdict.

`measure()` resolves params in five places: `buildView`, `assemblyOverlaps`, `partWallBands`, `evaluateProbes` and the sheet facts. All five go through `resolveParams`, so `measure()` threads one sink through them and returns `reads: string[]` beside `measuredMinWall`. The inspect job builds the view itself and hands it in as `opts.built`, so it passes the same sink to that `buildView` call and to `measure` (`opts.reads`).

The memo becomes a list of `{ params, result }` entries, where `params` are the full resolved params. Case B reuses entry A when `relevanceHash(A.result.reads, B) === relevanceHash(A.result.reads, A.params)`. This is the cache's rule applied to a list. A result without `reads`, such as a test's stub `measureFn`, is reused only on an exact match of the full params. The seed enters the list the same way. The cloud's quick lap therefore keeps covering presets that change only params the part never reads, such as a label text (the `Relabel` cases pinned in `test/verify.test.js`). A simpler full-params key was considered and rejected, because the quick lap would have reported those presets as "not measured".

### 5. Groundwork for "click a part, see its controls"

The goal: clicking a region shows the controls that shape **that feature**, not the whole sub-part. The measure-mode comment already notes that a sub-part's full read set is "far too coarse" for this. This change lays three pieces of groundwork without building the feature:

1. **One answer, one place.** A new `controlsFor(selection)` on the mount runtime returns the param keys relevant to a pick. In this phase it answers at sub-part level from `cache.readsOf`. Pick scoping, measure flash and any future host UI (the cloud's pick bubble or a panel highlight) all call it. Feature-level precision then lands behind one function, without re-plumbing consumers.
2. **Reads travel beside features.** Each delivered mesh already carries `features` (the `.label()` names) and per-triangle `featureIds`. The `reads` field sits on the same mesh record, so a later `featureReads` field (label → keys) has an obvious home and the same freshness and staleness rules.
3. **A sound candidate set.** Feature-level attribution needs to know which params *could* matter, so it has something to narrow down. The recorded sub-part read set is that set: small, and exact for the current path. The probe's set is not, because it can miss reads entirely.

Getting from sub-part to feature is out of scope here. Three directions are on the table, and the follow-up spec chooses among them:

- **Nudge and re-hash on the pose probe** (`pose-probe-core.js`). Hash each labelled solid at `.label()`, nudge one candidate param, and see which hashes move. It needs no geometry. But any geometry query marks the probe untrusted, and those are exactly the parts that motivated this spec. It also attributes a param to how a labelled solid was *built*, so a later cut that carves into a labelled face is missed.
- **Read watermarks on real ops.** Give the recorder a running counter, and stamp each new solid in the worker with the reads made since the previous op. A label's params are then the union over its solid's ancestor ops. This is cheap, runs on the real kernel, and works when the build makes geometry queries. It goes wrong for the common `const { w, h } = p;` at the top of a build, though, which charges every read to the first op.
- **Nudge on the real kernel**, using Layer 2's op hashes to see which labelled solids change. This is exact on the current path and works when the build makes geometry queries, but costs one cached rebuild per candidate param. It would run in the background, after delivery.

Whichever wins, the answer comes out of `controlsFor` and travels as `featureReads` next to `features`.

## Assumptions and limits

- **Determinism.** `build`, `place`, `derive` and asset declarations must be pure functions of their inputs, with no randomness, clocks or mutable module state. Layer 2 already assumes this. Builds that violate it are already broken under caching, and this change does not make that worse.
- **Reads through other channels.** A build that captures params in a closure from somewhere other than `p` and `d` cannot be tracked. Neither the probe nor the cache supports that today, and the authoring docs pass params only through `p` and `d`.
- **Value identity.** `relevanceHash` compares values with `byteAwareReplacer`, as today, so byte-valued image and font params keep their fingerprinting.
- **Cost.** Proxy `get` adds tens of nanoseconds per read. A build reads params hundreds to thousands of times against milliseconds of geometry work, so the overhead is negligible. A unit benchmark guards it.

## What this does not change

- The probe kernel, its stubs, and lint's use of it.
- Backend routing.
- The regen loop, debounce, or the stale or superseded protocol.
- Any authoring API. Parts do not change.

## Testing

- **Regression fixture.** A part shaped like #158: a sub-part guards `latticeHoles(…cellR…)` with `region.isEmpty()`. Assert:
  - changing `cellR` makes the sub-part not current;
  - `relevantParamKeys` after delivery includes `cellR`;
  - the probe prediction does not include it, which documents why the change exists.
- **Soundness.** For a set of fixture parts, including the reference parts, build at params A, record, and change one param at a time. Assert that whenever the cache says "current", a real rebuild produces an identical mesh hash. This is the property test for the rule.
- **Path change.** With pattern `random`, the `cellR` dim state is dimmed. Switch to `hex` and deliver: un-dimmed.
- **Derive attribution.** The grouped and single-function forms produce the same `d` as `resolveDerived`, and the read expansion matches today's `subPartReadKeys` on the existing `param-deps-subpart.test.js` cases.
- **Asset decl reads** rebuild every sub-part in the job.
- **Old-worker reply** (no `reads`): the sub-part is treated as reading everything.
- **Pose fast path:** a `place()` that reads a different key at the new pose re-stamps with the union.
- **Oracle memo:**
  - two cases differing only in a guarded param are both measured, not reused;
  - `Relabel` (an unread param) still reuses the seed, both measured and on the quick lap.
- **Stale-shown animation delivery:** the cache stamp is dropped, not left describing older geometry.
- **Derive writing to `p`:** the write is still visible to build on the recording path.

## Rollout

- A partforge minor release. The `meshes` payload changes only additively. The new `controlsFor` is on the runtime, and its contract states that pick params narrow or widen to the recorded reads.
- **partforge-cloud** needs only the pin bump plus regenerated prompts. Picks forwarded to the agent then carry the recorded params. The cloud has no other consumer of the read sets. Reply to and close #158 after deploy, and fix the forge's `cellR` `when` rule separately: it hides Cell size in hex mode, a part bug unrelated to this change.

## Open questions for review

1. **Panel lag vs. prediction.** *Settled in review:* recorded-only. The lag lasts one build and doesn't block editing, and the panel no longer runs a probe on every input event.
2. **Asset-decl granularity.** Attributing declaration reads to every sub-part in the job is sound but coarse. Is it worth recording which asset kinds a build touched (`text2d`, `vector2d`, image ops) to narrow this now, or leave it for later?
3. **`ownKeys` as read-all.** A build that iterates `Object.keys(p)` without reading values becomes dependent on every param. That is conservative and correct. Is any shipped part pattern common enough for this to cost real cache hits?

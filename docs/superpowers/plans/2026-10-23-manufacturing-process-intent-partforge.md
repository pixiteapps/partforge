# Manufacturing process intent, partforge half: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Printing becomes a registered process whose checks are tiered into gates, costs and advisories; overhang becomes a cost armed by the process alone; a footprint cost catches a piece standing on nothing; `verify.accept` records the costs a user accepted.

**Architecture:** Print processes (`fdm`, `resin`) get descriptor folders under `src/framework/process/` and a separate `PRINT_PROCESSES` list, because nine tests and every sheet consumer read `PROCESSES` as "the sheet processes" (exporter parity, destinations, `SHEET_METRICS`). The DFM numbers move INTO the descriptors and `dfm-profiles.js` keeps every export by reading them back through the registry, so no caller changes. A cost is a metric whose `kind` is `"cost"`: `check()` gives it status `"cost"`, `verify()` lists it under `costs`, and `ok` ignores it. The footprint reading comes out of the bed-contact pass PR #299 added, which already walks the posed mesh.

**Tech Stack:** Node 22/24, vitest, tsc for the `.d.ts` surface, eslint, knip. All new code is DOM-free like the rest of `src/framework/oracle/`.

**Spec:** `partforge-cloud/docs/superpowers/specs/2026-10-23-manufacturing-process-intent-design.md` (sections 1, 2, 6). The plan deviates from it in two named places: the registry split (above) and tiers living on the metric entry's `kind` rather than a separate `tiers` table on the descriptor (one spelling, not two).

## Global Constraints

- Base: `origin/claude/print-bed-contact` (PR #299, 0.163.0) merged into main. Branch from main after that merge; if #299 is still open, branch from its head and say so in the PR.
- Version: bump to `0.164.0` in `package.json` (and the lockfile) in the last task; re-bump if another release lands first.
- Descriptor import rule (`test/sheet-layering.test.js:54-62`): a `process/<id>/descriptor.js` imports only `src/framework/sheet/constants.js` and `src/framework/lint/finding.js`. The profile numbers therefore live inside the descriptor.
- Only `process/registry.js` and `process/exporters.js` may import a file under `process/<id>/` (`test/sheet-layering.test.js:40-52`).
- `PROCESSES`, `PROCESS_IDS`, `SHEET_METRICS`, `PROCESS_LINT_RULES`, `DESTINATIONS` and `EXPORTER_LOADERS` keep their current meaning (sheet processes only). Print processes never appear in them.
- Every registry metric entry keeps a `hint` of at most 500 characters; every `pattern` resolves to an `## <id>` heading in `docs/ERROR-PATTERNS.md` (`test/error-patterns.test.js:164-176`).
- `types/part.d.ts` `SubPartExpectations` must declare exactly `Object.keys(SUBPART_METRICS)`, and `DfmProfileName` exactly `Object.keys(PROFILES)` (`test/types-surface.test.js:232-245`).
- Every lint rule id appears in `docs/AUTHORING-PARTS.md`'s rule catalog (`test/lint-registry.test.js:30-33`).
- Cost ids are exactly `supports` (overhang) and `footprint`; the FDM profiles' `footprint` floor starts at `5` (percent of the posed base area) and is adjusted only with the golden diff in front of you.
- No new key on the verify block but `accept`. No new status but `"cost"`. No new descriptor field but `costs` (and the print-only `profiles`).
- Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run lint:dead` before the PR; the golden re-record is `PARTFORGE_RECORD_VERIFY_GOLDEN=1 npx vitest run test/verify-golden.test.js`.

## Review Focus

- A forge whose `verify.process` is an inline object with `base: "fdm-pla"` must arm overhang and footprint exactly as the string form does, and `{ base: "fdm-pla", overhang: null }` must still switch overhang off entirely (Task 2 tests both).
- A forge with `verify.process: "resin"` must report no overhang, bed-contact or footprint cost, and `accept: ["supports"]` on it must lint as unknown, since resin defines no costs (Tasks 2, 3, 4).
- A sheet-only forge that declares `footprintPct` gets the PRINT_ONLY skip, not an "unavailable" warning (Task 3).
- A cost's `accepted: true` must survive a quick lap (`unevaluated` copy) and must never move a check into `warnings` or `failures` (Task 2).
- A piece with `exportable: false` is judged for neither bed contact nor footprint, and a piece whose export pose fails to build gets the `bedContactError` skip for footprint too (Task 3).

---

### Task 1: Print process descriptors and the registry split

**Files:**
- Create: `src/framework/process/fdm/descriptor.js`
- Create: `src/framework/process/resin/descriptor.js`
- Modify: `src/framework/process/registry.js`
- Modify: `src/framework/oracle/dfm-profiles.js:22-38` (PROFILES becomes a read-through)
- Modify: `test/sheet-layering.test.js:64-74` (folder rule), `test/routed-registry.test.js:10` (unchanged assertion, confirm it still holds)
- Test: `test/print-registry.test.js` (new), `test/dfm-profiles.test.js` (unchanged, must stay green)

**Interfaces:**
- Produces: `FDM` and `RESIN` descriptors `{ id: "fdm" | "resin", label, stock: "filament" | "resin", docId: "printed-parts", profiles: { [profileId]: DfmProfile }, costs: { [costId]: metricName }, metrics: {}, lintRules: [] }`. `FDM.profiles` holds `fdm-pla` and `fdm-petg` exactly as `PROFILES` holds them today plus `footprint: 5`; `RESIN.profiles.resin` is today's resin object. `FDM.costs = { supports: "overhangArea", footprint: "footprintPct" }`; `RESIN.costs = {}`.
- Produces in `registry.js`: `PRINT_PROCESSES = [FDM, RESIN]`, `PRINT_PROCESS_IDS`, `ALL_PROCESSES = [...PROCESSES, ...PRINT_PROCESSES]`, `PRINT_PROFILES` (the merged `{ "fdm-pla", "fdm-petg", "resin" }` map, frozen), `printProcessFor(profileSpec)` → the descriptor owning the profile id (a string, or an object's `base`, recursively) or `null`, and `printProcessById(id)`.
- `dfm-profiles.js` keeps every export; `PROFILES` is now `PRINT_PROFILES` re-exported, so `Object.keys(PROFILES)` is unchanged.

- [ ] **Step 1: Write the failing tests** in `test/print-registry.test.js`

```js
import { PRINT_PROCESSES, PRINT_PROCESS_IDS, ALL_PROCESSES, PROCESSES, PRINT_PROFILES, printProcessFor } from "../src/framework/process/registry.js";
import { PROFILES } from "../src/framework/oracle/dfm-profiles.js";
import { FDM } from "../src/framework/process/fdm/descriptor.js";

test("print processes are their own list and never join the sheet list", () => {
  expect(PRINT_PROCESS_IDS).toEqual(["fdm", "resin"]);
  expect(PROCESSES.map((d) => d.id)).toEqual(["laser", "cnc-router"]);
  expect(ALL_PROCESSES.map((d) => d.id)).toEqual(["laser", "cnc-router", "fdm", "resin"]);
});
test("the DFM profiles are the descriptors' profiles", () => {
  expect(PROFILES).toBe(PRINT_PROFILES);
  expect(Object.keys(PROFILES)).toEqual(["fdm-pla", "fdm-petg", "resin"]);
  expect(PROFILES["fdm-pla"].footprint).toBe(5);
  expect(PROFILES.resin.footprint).toBeUndefined();
});
test("printProcessFor resolves a string, an inline base, and nothing else", () => {
  expect(printProcessFor("fdm-petg")).toBe(FDM);
  expect(printProcessFor({ base: "fdm-pla", overhang: null })).toBe(FDM);
  expect(printProcessFor("laser")).toBeNull();
  expect(printProcessFor({ bed: [1, 1, 1] })).toBeNull();
  expect(printProcessFor(undefined)).toBeNull();
});
test("a print descriptor carries no sheet-only fields and no exporter", () => {
  for (const d of PRINT_PROCESSES) {
    expect(d.docId).toBe("printed-parts");
    expect(d.metrics).toEqual({});
    expect(d.lintRules).toEqual([]);
    expect(d.destinations).toBeUndefined();
  }
  expect(FDM.costs).toEqual({ supports: "overhangArea", footprint: "footprintPct" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/print-registry.test.js`
Expected: FAIL, "does not provide an export named 'PRINT_PROCESSES'".

- [ ] **Step 3: Create the two descriptors**

`src/framework/process/fdm/descriptor.js` exports `FDM` with the fields in Interfaces; move the two FDM profile objects out of `dfm-profiles.js:22-33` verbatim and add `footprint: 5` to each, with the header comment from `dfm-profiles.js:1-21` moved with them. `src/framework/process/resin/descriptor.js` exports `RESIN` the same way from `dfm-profiles.js:34-37`. Neither file imports anything.

- [ ] **Step 4: Extend `registry.js` and make `dfm-profiles.js` read through it**

Add the exports named in Interfaces to `registry.js`; `printProcessFor(spec)` walks `typeof spec === "string" ? spec : spec?.base` until it reaches a string and returns the descriptor whose `profiles` has that key. In `dfm-profiles.js` replace the `PROFILES` literal with `export { PRINT_PROFILES as PROFILES } from "../process/registry.js"` (import it for `resolveProfile`'s own use); nothing else in the file changes.

- [ ] **Step 5: Widen the folder rule and run the registry tests**

In `test/sheet-layering.test.js:64-74`, the folder set becomes the sorted ids of `ALL_PROCESSES`; the `docId` allowlist gains `"printed-parts"`; the "must be in PROCESSES" assertion becomes "in ALL_PROCESSES". Leave `test/routed-registry.test.js` untouched.

Run: `npx vitest run test/print-registry.test.js test/sheet-layering.test.js test/routed-registry.test.js test/dfm-profiles.test.js test/kit-export-guards.test.js test/kit-layering.test.js test/verify-metrics.test.js test/sheet-constants.test.js test/worker-layering.test.js test/types-surface.test.js`
Expected: PASS. (`dfm-profiles.test.js:4-11` deep-equals `fdm-pla` against a literal without `footprint`; update that literal to include `footprint: 5` and nothing else.)

- [ ] **Step 6: Commit**

```bash
git add src/framework/process/fdm src/framework/process/resin src/framework/process/registry.js src/framework/oracle/dfm-profiles.js test/print-registry.test.js test/sheet-layering.test.js test/dfm-profiles.test.js
git commit -m "Register fdm and resin as print processes; DFM profiles read through the registry"
```

---

### Task 2: The cost tier, `costs` on the verify result, and `accept`

**Files:**
- Modify: `src/framework/verify-metrics.js:107-110` (overhangArea), plus a `costId` on the entry
- Modify: `src/framework/oracle/verify.js:124-175` (`check()`), `:276-347` (`evaluateCase`), `:359-540` (`verify()` result)
- Modify: `src/framework/oracle/dfm-profiles.js:77-89` (`overhangAngleFor`)
- Modify: `types/part.d.ts:639-657` (`VerifyBlock.accept`), `types/testing.d.ts:598,600-631,640-660`
- Test: `test/verify.test.js:550-557, :590-591`, `test/dfm-profiles.test.js:31`, `test/verify-metrics.test.js:11-18`, new `test/costs.test.js`

**Interfaces:**
- Consumes: `printProcessFor(spec)` from Task 1.
- Produces: metric entries may carry `kind: "cost"` and `costId: string`. `check()` yields `status: "cost"` for a failed cost metric. `verify()` returns `{ ok, view, cases, failures, warnings, costs, unevaluated, declared, evaluated }`, where `costs` is `all.filter((c) => c.status === "cost")`, each entry carrying `accepted: boolean` (true when `part.verify.accept` includes the metric's `costId`). `evaluateCase` takes one more option, `accept: string[]`. `ok` is unchanged by costs. `overhangAngleFor(part, process, { expanded })` returns the profile's angle whenever the resolved profile carries one (the process alone arms it); `orientation: "print"` no longer takes part in that decision.

- [ ] **Step 1: Write the failing tests** in `test/costs.test.js`, using the same fixture style as `test/verify.test.js:540-600` (a part whose one sub-part has a 60° underside under `process: "fdm-pla"`):

```js
test("overhang is a cost under an FDM profile with no orientation key", () => {
  const v = verify(kernel, overhungPart);               // verify: { process: "fdm-pla" }
  const c = v.costs.find((c) => c.metric === "overhangArea");
  expect(c).toMatchObject({ status: "cost", kind: "cost", accepted: false });
  expect(v.warnings.find((c) => c.metric === "overhangArea")).toBeUndefined();
  expect(v.failures).toEqual([]);
  expect(v.ok).toBe(true);
});
test("accept marks the cost accepted and changes nothing else", () => {
  const v = verify(kernel, { ...overhungPart, verify: { process: "fdm-pla", accept: ["supports"] } });
  expect(v.costs[0]).toMatchObject({ metric: "overhangArea", accepted: true });
  expect(v.ok).toBe(true);
});
test("an inline base arms it; overhang: null switches it off", () => {
  expect(verify(kernel, { ...overhungPart, verify: { process: { base: "fdm-pla" } } }).costs).toHaveLength(1);
  expect(verify(kernel, { ...overhungPart, verify: { process: { base: "fdm-pla", overhang: null } } }).costs).toEqual([]);
});
test("resin reports no overhang cost", () => {
  expect(verify(kernel, { ...overhungPart, verify: { process: "resin" } }).costs).toEqual([]);
});
test("a quick lap lists the cost under unevaluated, accepted flag intact", () => {
  const v = verify(kernel, { ...overhungPart, verify: { process: "fdm-pla", accept: ["supports"] } }, { quick: true });
  const u = v.unevaluated.find((c) => c.metric === "overhangArea");
  expect(u).toMatchObject({ accepted: true, unevaluated: true });
  expect(v.costs).toEqual([]);
});
test("evaluated counts a cost; declared counts it", () => {
  const v = verify(kernel, overhungPart);
  expect(v.declared).toBeGreaterThanOrEqual(1);
  expect(v.evaluated).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/costs.test.js`
Expected: FAIL on `v.costs` being undefined.

- [ ] **Step 3: Implement the tier**

In `verify-metrics.js` set `overhangArea` to `kind: "cost", costId: "supports"`. In `check()` (`verify.js:159`) the status becomes `pass ? "pass" : reg.kind === "warn" ? "warn" : reg.kind === "cost" ? "cost" : "fail"`, and the check carries `accepted: reg.kind === "cost" ? accept.includes(reg.costId) : undefined` (thread `accept` from `evaluateCase`'s new option into `checksFor` and `check`). In `evaluateCase` the overhang line in `merged` stays `overhangArea: "<=1"`. In `verify()` read `const accept = Array.isArray(part?.verify?.accept) ? part.verify.accept : []`, pass it to `evaluateCase`, add `costs = all.filter((c) => c.status === "cost")` and return it beside `warnings`; `failures` and `warnings` filters are unchanged, so a cost appears in neither. In `overhangAngleFor` return the profile's angle whenever it is a finite number, keep the `expanded` fallback (an authored `overhangArea` under a profile with no angle still measures against 45), and keep the orientation validation throw. Update `test/dfm-profiles.test.js:31` to expect `45`, `test/verify.test.js:550-557` to read `v.costs` and status `"cost"`, and `:590-591` to expect the cost present under FDM without the key.

- [ ] **Step 4: Types**

`types/part.d.ts` `VerifyBlock` gains `accept?: ("supports" | "footprint")[]` with a doc comment: costs the user accepted; still measured and reported, no longer raised. `types/testing.d.ts`: `CheckStatus` gains `"cost"`, `VerifyCheck.kind` gains `"cost"` and the interface gains `accepted?: boolean`, `VerifyReport` gains `costs: VerifyCheck[]`. Rewrite `SubPartExpectations.overhangArea`'s comment (part.d.ts:541-604) and `VerifyBlock.orientation`'s (:639-657) so neither says the key arms overhang; orientation now only declares that `build()` is the print pose.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/costs.test.js test/verify.test.js test/dfm-profiles.test.js test/verify-metrics.test.js test/bed-contact.test.js test/types-surface.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/verify-metrics.js src/framework/oracle/verify.js src/framework/oracle/dfm-profiles.js types/part.d.ts types/testing.d.ts test/costs.test.js test/verify.test.js test/dfm-profiles.test.js
git commit -m "verify: overhang becomes a cost armed by the process; costs list and accept"
```

---

### Task 3: The footprint cost

**Files:**
- Modify: `src/framework/oracle/bed-contact.js:76-126` (return the posed base)
- Modify: `src/framework/oracle/measure.js:160-171` (`printPoseUnderside`), `:140-148` (`exportPoseBedContact`), `:445-450` (stamps)
- Modify: `src/framework/oracle/dfm-profiles.js` (add `footprintFor`), `src/framework/oracle/gates.js` (add `partFootprint`)
- Modify: `src/framework/oracle/verify.js:217-218` (PRINT_ONLY), `:318-323` (`merged`), the `bedContactError`/quick-lap substitutions at `:333-345` to cover `footprintPct`
- Modify: `src/framework/verify-metrics.js` (new entry), `types/part.d.ts` (`DfmProfile.footprint`, `SubPartExpectations.footprintPct`), `types/testing.d.ts` (`SubPartFacts.footprintPct`, `footprintAt`, `MeasureReport.measuredFootprint`)
- Test: `test/bed-contact.test.js` (new cases), `test/footprint.test.js` (new), `test/verify-metrics.test.js:62-63` (PRINT_METRICS list)

**Interfaces:**
- Consumes: `kind: "cost"` and `costId` from Task 2; `FDM.profiles.*.footprint = 5` from Task 1.
- Produces: `bedContact(mesh, opts)` returns `{ pct, contactArea, hoverArea, gap, at, base: [dx, dy], lowestAt: [x, y, z] }` where `base` is the posed mesh's xy extent and `lowestAt` the lowest vertex. Each printed sub-part fact gains `footprintPct` (`100 * contactArea / (dx * dy)`, `null` when not measured or `dx * dy === 0`) and `footprintAt` (`lowestAt` mapped back to display coordinates like `bedHoverAt`). `measuredFootprint: boolean` on the report, equal to `measuredBedContact` (one pass measures both). `footprintFor(part, process, { expanded })` → the profile's `footprint` floor, or `null` when the profile has none (resin, no profile), or the default `5` when an authored `footprintPct` expectation exists under a floorless profile; exported `DEFAULT_FOOTPRINT = 5`. `SUBPART_METRICS.footprintPct = { kind: "cost", costId: "footprint", extract: (s) => s.footprintPct, locate: (s) => s.footprintAt, pattern: "piece-stands-on-nothing", hint }`.

- [ ] **Step 1: Write the failing tests**

In `test/bed-contact.test.js`, beside the existing ball (`:347`) and roller (`:335`) cases, assert the new fields: a 20×20×5 box flat on the bed returns `base: [20, 20]` and a footprint of 100; a sphere of radius 5 tangent to the bed returns `pct: 100` (unchanged) and `contactArea` under 1. In `test/footprint.test.js`:

```js
test("a sphere-tipped rod standing on its end is a footprint cost", () => {
  const v = verify(kernel, rodPart);                     // cylinder r=2 h=30 on a sphere r=2, process fdm-pla
  const c = v.costs.find((c) => c.metric === "footprintPct");
  expect(c).toMatchObject({ status: "cost", accepted: false, pattern: "piece-stands-on-nothing" });
  expect(c.actual).toBeLessThan(5);
  expect(v.ok).toBe(true);
});
test("a plate reads 100 and reports no footprint cost", () => {
  expect(verify(kernel, platePart).costs.filter((c) => c.metric === "footprintPct")).toEqual([]);
});
test("accept: [\"footprint\"] marks it accepted", () => {
  const v = verify(kernel, { ...rodPart, verify: { process: "fdm-pla", accept: ["footprint"] } });
  expect(v.costs.find((c) => c.metric === "footprintPct").accepted).toBe(true);
});
test("resin and an exportable:false piece are not judged", () => {
  expect(verify(kernel, { ...rodPart, verify: { process: "resin" } }).costs).toEqual([]);
  expect(verify(kernel, nonExportableRodPart).costs.filter((c) => c.metric === "footprintPct")).toEqual([]);
});
test("declared on a sheet part it is a PRINT_ONLY skip", () => {
  const v = verify(kernel, sheetPartDeclaringFootprint);
  const c = v.unevaluated.find((c) => c.metric === "footprintPct");
  expect(c.message).toMatch(/cut, not printed/);
});
test("a failed export pose skips footprint like bed contact", () => {
  const v = verify(kernel, badExportPosePart);
  expect(v.unevaluated.find((c) => c.metric === "footprintPct").message).toMatch(/print \(export\) pose did not build/);
});
```

Use `test/bed-contact.test.js:217-357`'s fixtures for the export-pose and `exportable: false` cases.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/footprint.test.js test/bed-contact.test.js`
Expected: FAIL (no `footprintPct` on the facts; `base` undefined).

- [ ] **Step 3: Implement the reading**

In `bedContact()` track min/max x and y and the lowest vertex over the same positions loop and add `base` and `lowestAt` to both return shapes (the `pct: 100` early return included). In `measure.js` compute `footprintPct` from `bc.contactArea` and `bc.base` where `bc` is chosen (`:384-388`), map `lowestAt` through the same inverse the hover centroid uses, and stamp the two fields beside the bed-contact stamps; stamp `measuredFootprint: bedArmed`. The memo key is unchanged: the pass is the same one.

- [ ] **Step 4: Arm and register it**

`footprintFor` in `dfm-profiles.js` mirrors `bedContactFor`'s shape with the floor read off `resolveProfile(spec).footprint`; `partFootprint` in `gates.js` wraps it like `partBedContact`. In `verify.js` add `footprintPct: \`>=${footprint}\`` to `merged` under the same `printedNames` guard as bed contact, add it to `PRINT_ONLY` and its hint sentence, and extend the `bedContactError` and quick-lap substitutions to `footprintPct`. Add the `verify-metrics.js` entry (hint under 500 characters: what the number is, that a line contact reads near zero, and the three remedies: lay it on its flat face, add a foot, or print with a brim). Add `footprintPct` to `PRINT_METRICS` in `test/verify-metrics.test.js:62-63`, the `.d.ts` members named in Interfaces, and the `DfmProfile.footprint?: number | null` field.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/footprint.test.js test/bed-contact.test.js test/costs.test.js test/verify.test.js test/verify-metrics.test.js test/measure-memo.test.js test/types-surface.test.js test/error-patterns.test.js && npm run typecheck`
Expected: PASS except `test/error-patterns.test.js`, which fails until Task 5 adds the `piece-stands-on-nothing` heading; that is expected here and noted in the commit.

- [ ] **Step 6: Commit**

```bash
git add src/framework/oracle/bed-contact.js src/framework/oracle/measure.js src/framework/oracle/dfm-profiles.js src/framework/oracle/gates.js src/framework/oracle/verify.js src/framework/verify-metrics.js types/part.d.ts types/testing.d.ts test/footprint.test.js test/bed-contact.test.js test/verify-metrics.test.js
git commit -m "measure: footprintPct, a cost for a printed piece standing on almost nothing"
```

---

### Task 4: Lint: `verify-unknown-accept`, and the orientation hint

**Files:**
- Modify: `src/framework/lint/rules-verify.js:274` (VERIFY_RULES), `:405-416` (orientation hint), `:188-218` (`checkProcessSpec`: confirm print ids are not in `PROCESS_IDS`, so nothing changes there; add a test proving it)
- Test: `test/lint-verify.test.js`

**Interfaces:**
- Consumes: `printProcessFor` and `FDM.costs` from Task 1.
- Produces: rule `verify-unknown-accept`: an error for a non-array `accept`, and one error per entry that is not a key of the resolved print process's `costs` (resin: none), path `verify.accept[<i>]`, hint listing the known ids for that process. A process that does not resolve produces no finding from this rule (`verify-unknown-process` already covers it).

- [ ] **Step 1: Write the failing tests** in `test/lint-verify.test.js`, next to the orientation block at `:268-279`:

```js
test("verify-unknown-accept refuses an id the process does not define", () => {
  const r = lintPart({ ...base, verify: { process: "fdm-pla", accept: ["supports", "bridges"] } });
  expect(r.errors.map((e) => e.rule)).toEqual(["verify-unknown-accept"]);
  expect(r.errors[0].path).toBe("verify.accept[1]");
  expect(r.errors[0].hint).toMatch(/supports, footprint/);
});
test("resin defines no costs, so any accept is unknown", () => {
  expect(lintPart({ ...base, verify: { process: "resin", accept: ["supports"] } }).errors[0].rule).toBe("verify-unknown-accept");
});
test("a non-array accept is one error at verify.accept", () => {
  expect(lintPart({ ...base, verify: { process: "fdm-pla", accept: "supports" } }).errors[0].path).toBe("verify.accept");
});
test("accept with no process is left to verify-unknown-process", () => {
  expect(lintPart({ ...base, verify: { accept: ["supports"] } }).errors).toEqual([]);
});
test("the orientation hint no longer claims to arm overhang", () => {
  const r = lintPart({ ...base, verify: { orientation: "sideways" } });
  expect(r.errors[0].hint).not.toMatch(/overhang/);
  expect(r.errors[0].hint).toMatch(/"print"/);
});
test("fdm-pla is not treated as a sheet process id", () => {
  expect(lintPart({ ...base, verify: { process: "fdm-pla" } }).errors).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/lint-verify.test.js`
Expected: FAIL on the three new rule tests and the hint wording.

- [ ] **Step 3: Implement the rule and reword the hint**

Append `verify-unknown-accept` to `VERIFY_RULES` in the `{ id, run(ctx) }` shape, reading `ctx.part?.verify?.accept` and resolving the process with `printProcessFor`. Reword `verify-unknown-orientation`'s hint parenthetical to "(declares that `build()` is the print pose: Z up, bed at the lowest Z)".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/lint-verify.test.js test/lint-registry.test.js`
Expected: `lint-verify` PASS; `lint-registry` FAILS on the catalog until Task 5 (expected).

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-verify.js test/lint-verify.test.js
git commit -m "lint: verify-unknown-accept; orientation hint no longer names overhang"
```

---

### Task 5: Docs, error pattern, AGENTS.md

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (new `## Printed parts` section placed directly before `## Sheet parts` at `:1922`; the `## Self-verification` block at `:4297-4450`; the rule catalog's verify list at `:4009-4012`)
- Modify: `docs/ERROR-PATTERNS.md` (new `## piece-stands-on-nothing` after `## piece-hovers-above-bed` at `:207`)
- Modify: `AGENTS.md:308-334` (process layout), `:357-372` (oracle file list), `:373-415` (add a "Printed parts in the oracle" paragraph)
- Test: `test/error-patterns.test.js:20+` (BASELINE_IDS), `test/lint-registry.test.js`, `test/sheet-docs.test.js:69-81`, new assertions in `test/print-registry.test.js`

**Interfaces:**
- Consumes: every name introduced in Tasks 1 to 4.
- Produces: the `printed-parts` slug the cloud's `docs:generate` derives from the `## Printed parts` heading; the ERROR-PATTERNS id the `footprintPct` metric cites.

- [ ] **Step 1: Write the failing test additions**

In `test/error-patterns.test.js` add `"piece-stands-on-nothing"` to `BASELINE_IDS`. In `test/print-registry.test.js` add:

```js
test("AUTHORING-PARTS carries the printed-parts section and the accept key", () => {
  const md = readFileSync("docs/AUTHORING-PARTS.md", "utf8");
  expect(md).toMatch(/^## Printed parts$/m);
  expect(md).toMatch(/verify-unknown-accept/);
  expect(md).toMatch(/accept: \["supports"\]/);
  expect(md).not.toMatch(/ONLY with this is overhang checked/);
  expect(md).not.toMatch(/a warning, never a gate/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/error-patterns.test.js test/print-registry.test.js test/lint-registry.test.js`
Expected: FAIL on the missing heading, id and rule.

- [ ] **Step 3: Write the docs**

`## Printed parts` (the `printed-parts` docId): what a print process is and how it is declared (`verify.process`, string or inline `base`); the three tiers as a table, gates (bed fit, bed contact), costs (overhang → `supports`, footprint → `footprint`), advisories (min wall, wall); `accept` and the difference from switching a measurement off; orientation-first authoring (largest flat face down, split at the widest flat, `build()` is the print pose, a `print` view spreads pieces); what costs supports and what does not (overhangs past the profile angle, bridges past `bridge`, downward-opening cavities; chamfers under 45° and teardrop bores do not); ball joints for FDM as split sockets or pinned clevises; small features against `minWall`, with a verify case at each end of a scale parameter; fits by class from the profile; first-layer details (elephant-foot chamfer, a flat under a knuckle, nothing embossed on the underside). Keep it the length of `## Routed parts` (about 8 KB). In `## Self-verification` replace the overhang paragraph (`:4320-4342`, which also wrongly says "DISPLAY pose") with the cost wording and `accept`, add `footprint` to the inline profile comment at `:4303-4305`, add `footprintPct` to the `expect` list at `:4399`, and rewrite "Gates vs. warnings" (`:4445-4450`) as "Gates, costs and warnings". Add `verify-unknown-accept` to the rule catalog. Write `## piece-stands-on-nothing` in ERROR-PATTERNS in the existing Symptom / Cause / Fix shape. Update the three AGENTS.md ranges.

- [ ] **Step 4: Run the doc tests**

Run: `npx vitest run test/error-patterns.test.js test/print-registry.test.js test/lint-registry.test.js test/sheet-docs.test.js test/routed-docs.test.js test/verify-metrics.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md AGENTS.md test/error-patterns.test.js test/print-registry.test.js
git commit -m "docs: printed parts section, cost tier, accept, piece-stands-on-nothing"
```

---

### Task 6: Golden re-record, version, full suite

**Files:**
- Modify: `test/fixtures/verify-golden.json`, `package.json`, `package-lock.json`

- [ ] **Step 1: Re-record the golden and read the diff**

Run: `PARTFORGE_RECORD_VERIFY_GOLDEN=1 npx vitest run test/verify-golden.test.js && git diff --stat test/fixtures/verify-golden.json`
Expected: every FDM part's `overhangArea` check moves from `warnings` to `costs` with status `"cost"`; new `footprintPct` checks appear. Write down, for the PR body, each `src/parts/*.js` view that gained a footprint cost and whether the piece really stands on almost nothing. If a flat-bottomed piece reads under 5, the floor is wrong, not the forge: lower `footprint` in both FDM profiles, re-record, and update the Task 1 test. No `ok` may change.

- [ ] **Step 2: Bump the version**

Set `"version": "0.164.0"` in `package.json` and `package-lock.json` (both occurrences in the lockfile's root entry).

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run lint:dead`
Expected: all green; eslint's seven pre-existing warnings only.

- [ ] **Step 4: Commit and open the PR**

```bash
git add test/fixtures/verify-golden.json package.json package-lock.json
git commit -m "Release 0.164.0: print processes, cost tier, footprint, accept"
```

PR body in the project's reader-friendly style: what changed for an author (overhang is a cost now, not a nag you opt into; a piece standing on nothing is reported; `accept` records a choice), the golden verdict change with the per-forge footprint list from Step 1, and the downstream note: partforge-cloud pins `^0.164.0` and runs `npm run docs:generate && npm run prompt:generate`.

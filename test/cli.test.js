import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync, readFileSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

// Render into a per-file output dir, not the shared default `render/`. Two CLI test
// files both rendering to (and rmSync-ing) `render/` race under vitest's parallel
// file execution — one file's afterAll deletes it mid-render in the other.
const OUT = "test/.cli-render";

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

test("CLI measure prints a report and exits 0 — no file unless --out asks for one", () => {
  const out = run(["measure", "src/parts/demo.js"]);
  expect(out).toMatch(/Spacer \/ spacer/);
  expect(out).toMatch(/watertight ✓/);
  expect(existsSync("measure-spacer-spacer.json")).toBe(false); // no droppings in the consumer's cwd
});

test("CLI measure --out writes the JSON report where asked", () => {
  const out = run(["measure", "src/parts/demo.js", "--out", `${OUT}/report.json`]);
  expect(out).toMatch(/wrote test\/\.cli-render\/report\.json/);
  const report = JSON.parse(readFileSync(`${OUT}/report.json`, "utf8"));
  expect(report.ok).toBe(true);
  expect(report.subparts[0].name).toBe("spacer");
});

test("an unknown flag fails loudly instead of being silently ignored", () => {
  let err;
  try { run(["render", "src/parts/demo.js", "spacer", "--viwes", "iso"]); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(`${err.stderr}`).toMatch(/viwes/); // the typo is named, with usage
  expect(`${err.stderr}`).toMatch(/usage: partforge render/);
});

test("--process without a value fails loudly instead of dropping the profile", () => {
  let err;
  try { run(["measure", "src/parts/demo.js", "--process"]); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(`${err.stderr}`).toMatch(/process/);
});

test("CLI render writes a PNG for the requested angle", () => {
  const out = run(["render", "src/parts/demo.js", "spacer", "--views", "iso", "--out", OUT]);
  expect(out).toMatch(/wrote test\/\.cli-render\/spacer-spacer-iso\.png/);
  expect(existsSync(`${OUT}/spacer-spacer-iso.png`)).toBe(true);
});

test("CLI exits non-zero on a bad part path", () => {
  expect(() => run(["measure", "src/parts/does-not-exist.js"])).toThrow();
});

const runFail = (args) => {
  try { run(args); } catch (e) { return e; }
  throw new Error("expected non-zero exit");
};

test("measure --json crash contract: structured JSON on stdout, exit 1", () => {
  const err = runFail(["measure", "test/fixtures/no-such-part.js", "--json"]);
  const payload = JSON.parse(`${err.stdout}`);   // stdout is PURE JSON on the crash path
  expect(payload.ok).toBe(false);
  expect(payload.error.message).toMatch(/cannot load part/);
});

test("measure crash without --json keeps the human message on stderr", () => {
  const err = runFail(["measure", "test/fixtures/no-such-part.js"]);
  expect(`${err.stderr}`).toMatch(/measure failed: cannot load part/);
});

test("failing verify checks carry hints in the written report", () => {
  runFail(["measure", "test/fixtures/bad-verify-part.js", "--out", `${OUT}/bad.json`]);
  const report = JSON.parse(readFileSync(`${OUT}/bad.json`, "utf8"));
  expect(report.verify.failures.length).toBeGreaterThan(0);
  for (const f of report.verify.failures) expect(f.hint, `${f.metric} lacks a hint`).toBeTruthy();
});

test("human verify output appends hint lines on failures", () => {
  const err = runFail(["measure", "test/fixtures/bad-verify-part.js"]);
  expect(`${err.stdout}`).toMatch(/hint: /);
});

test("CLI measure prints near-misses (report-only — exit stays 0)", () => {
  const out = run(["measure", "test/fixtures/gap-part.js"]);
  expect(out).toMatch(/near-misses: left×right \(0\.20mm at \[/);
});

test("measure preloads a part's declared fonts before building", () => {
  // Regression: bootKernel ignored part.fonts, so a part using a named font
  // built in the browser but died headlessly with `unknown font "heading"`.
  const out = run(["measure", "test/fixtures/font-part.js"]);
  expect(out).toMatch(/FontRig \/ v/);
  expect(out).toMatch(/watertight ✓/);
});

test("CLI measure prints 'near-misses: none' on a clean part", () => {
  const out = run(["measure", "src/parts/demo.js"]);
  expect(out).toMatch(/near-misses: none/);
});

test("--out writes the measure half even when a later verify throw crashes the run", () => {
  // unknown-metric-part.js's defect (a bad metric name in a *static* verify.expect)
  // is now caught statically by the `verify-unknown-metric` lint rule, before the
  // kernel even boots — so with lint on, `measure` never reaches the late-throw
  // path this test exists to cover. unknown-metric-in-case-part.js instead makes
  // `verify.expect` a function of (p, d) that only names the bad metric for a
  // non-default preset case; the lint gate only resolves `expect` once, against
  // the part's defaults (see resolveExpectOnce/lintContext), so it sees a clean
  // `{ holes: 1 }` and passes, while verify() itself still expands every case
  // (src/framework/oracle/cases.js) and re-resolves `expect` per case, hitting the bad
  // metric name — after measure() has already printed and `--out` has already
  // been written once. This keeps the test on a real lint-enabled production path
  // instead of requiring --no-lint.
  const err = runFail(["measure", "test/fixtures/unknown-metric-in-case-part.js", "--json", "--out", `${OUT}/um.json`]);
  // A throw after printMeasure appends the crash JSON after the human lines, so
  // stdout is not pure JSON — parse the trailing JSON object (pretty-printed).
  const payload = JSON.parse(`${err.stdout}`.match(/\{[\s\S]*\}\s*$/)[0]);
  expect(payload.ok).toBe(false);
  expect(payload.error.message).toMatch(/unknown subpart metric/);
  // The measure half landed on disk before the verify throw; no `verify` key.
  const report = JSON.parse(readFileSync(`${OUT}/um.json`, "utf8"));
  expect(report.subparts).toBeTruthy();
  expect(report.verify).toBeUndefined();
});

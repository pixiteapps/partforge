// The `lint` command and measure's auto-lint. Exercised as a subprocess because
// exit codes are half the contract — agents and CI branch on them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// fileURLToPath (not URL#pathname) because this repo's path contains a space
// ("Robot KB") — .pathname leaves it percent-encoded, which then fails to
// resolve as a literal file path when passed to execFileSync.
const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pf-lint-"));

// Write a part module to a temp file and return its path.
const partFile = (name, source) => {
  const file = join(dir, `${name}.js`);
  writeFileSync(file, source);
  return file;
};

// Run the CLI, returning { status, stdout, stderr } without throwing on non-zero.
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stderr: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const CLEAN = `export default {
  meta: { title: "Clean" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
};`;

const BROKEN = `export default {
  meta: { title: "Broken" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ sizes: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
};`;

const WARNS = `export default {
  meta: { title: "Warns" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" }, orphan: { label: "Orphan" } },
};`;

test("lint exits 0 on a clean part", () => {
  const r = run(["lint", partFile("clean", CLEAN)]);
  expect(r.status).toBe(0);
});

test("lint exits 1 and names the rule on a broken part", () => {
  const r = run(["lint", partFile("broken", BROKEN)]);
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/invalid-op-options/);
  expect(r.stdout + r.stderr).toMatch(/did you mean size\?/);
});

test("lint --json emits a machine-readable report", () => {
  const r = run(["lint", partFile("broken2", BROKEN), "--json"]);
  const report = JSON.parse(r.stdout);
  expect(report.ok).toBe(false);
  expect(report.errors.map((f) => f.rule)).toContain("invalid-op-options");
  expect(report.errors[0].hint.length).toBeGreaterThan(0);
});

test("lint --out writes the report to a file", () => {
  const out = join(dir, "report.json");
  run(["lint", partFile("broken3", BROKEN), "--out", out]);
  expect(JSON.parse(readFileSync(out, "utf8")).ok).toBe(false);
});

test("warnings alone exit 0, but --strict exits 1", () => {
  const file = partFile("warns", WARNS);
  expect(run(["lint", file]).status).toBe(0);
  expect(run(["lint", file, "--strict"]).status).toBe(1);
});

test("measure refuses a lint-broken part without booting a kernel", () => {
  const r = run(["measure", partFile("broken4", BROKEN)]);
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/invalid-op-options/);
  // The kernel never booted, so no measure table was printed.
  expect(r.stdout).not.toMatch(/watertight/);
});

test("measure --no-lint skips the gate", () => {
  // Without the lint gate this reaches the kernel and fails there instead, so the
  // assertion is only that the failure is no longer the lint gate.
  const r = run(["measure", partFile("broken5", BROKEN), "--no-lint"]);
  expect(r.stdout + r.stderr).not.toMatch(/lint:/);
});

test("usage lists the lint command", () => {
  const r = run(["nonsense"]);
  expect(r.stderr).toMatch(/lint/);
});

test("a build that throws only after a stubbed query loads: lint --strict exits 0", () => {
  const truss = fileURLToPath(new URL("./fixtures/stub-query-truss-part.js", import.meta.url));
  const r = run(["lint", truss, "--strict"]);
  expect(r.status).toBe(0);
});

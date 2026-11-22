// The import-demo reference part (Task 14 — the living-documentation example
// for docs/AUTHORING-PARTS.md's "Importing geometry" section) — `lint` clean
// and `measure` exit 0 on the real, checked-in part file, run as subprocesses
// the same way an agent or CI would invoke the CLI. Not a temp-file copy: this
// exercises the actual `src/parts/import-demo.js` + its checked-in asset at
// `src/parts/assets/import-demo-scan.stl`, so a regression in either file
// trips this test.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// fileURLToPath (not URL#pathname) — see test/lint-cli.test.js's header for why.
const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const PART = fileURLToPath(new URL("../src/parts/import-demo.js", import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stderr: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("import-demo lints clean", () => {
  const r = run(["lint", PART]);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("import-demo measure passes on the default (assembly) view", () => {
  const r = run(["measure", PART, "--json"]);
  expect(r.status).toBe(0);
  const report = JSON.parse(r.stdout);
  expect(report.ok).toBe(true);
  expect(report.verify.ok).toBe(true);
  // Both import uses present: a real-component sub-part (mount, cut by the
  // import) and a reference-bound rebuild (body) whose deviation facts are
  // all exactly zero at the defaults (box vs. box, byte-for-byte matching
  // dimensions) — well inside the gates' margins.
  const body = report.subparts.find((s) => s.name === "body");
  expect(body.deviation.ref).toBe("ref");
  expect(body.deviation.xorVolume).toBeLessThan(5);
  const mount = report.subparts.find((s) => s.name === "mount");
  expect(mount.holes).toBe(1); // the socket cut clean through
  expect(report.overlaps).toEqual([]);
}, 120000);

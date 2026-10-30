import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });
// No cleanup needed: measure only writes a file when --out asks for one.

test("measure --process runs verify, prints checks, exits 0 for a sound part", () => {
  const out = run(["measure", "src/parts/demo.js", "--process", "fdm-pla"]);
  expect(out).toMatch(/verify/);
  expect(out).toMatch(/all gates passed/);
});

test("a too-thin wall prints a ⚠ warning but still exits 0", () => {
  const out = run(["measure", "test/fixtures/thin-wall-part.js"]);
  expect(out).toMatch(/⚠/);
  expect(out).toMatch(/minWall/);
  expect(out).toMatch(/warning/);
});

test("a cost check prints $ with its hint, and exits 0", () => {
  const out = run(["measure", "test/fixtures/overhang-cost-part.js", "--no-lint"]);
  expect(out).toMatch(/\$ tee overhangArea /);
  expect(out).toMatch(/hint: .*verify\.accept: \["supports"\]/);
  expect(out).toMatch(/1 cost\(s\)/);
});

test("an accepted cost is marked (accepted) and prints no hint", () => {
  const out = run(["measure", "test/fixtures/accepted-overhang-part.js", "--no-lint"]);
  expect(out).toMatch(/\$ tee overhangArea .*\(accepted\)/);
  expect(out).not.toMatch(/hint: /);
  expect(out).toMatch(/1 cost\(s\)/);
});

test("measure exits 1 when a verify gate fails", () => {
  try {
    run(["measure", "test/fixtures/bad-verify-part.js"]);
    throw new Error("expected non-zero exit");
  } catch (e) {
    expect(e.status).toBe(1);
    expect(String(e.stdout)).toMatch(/✗/);
  }
});

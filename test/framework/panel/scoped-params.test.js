import { expect, test } from "vitest";
import { scopedParams } from "../../../src/framework/panel/scoped-params.js";

const store = (initial) => {
  let value = initial;
  const writes = [];
  return {
    read: () => structuredClone(value),
    write: (next) => { writes.push(structuredClone(next)); value = next; },
    current: () => value,
    writes,
  };
};

test("reads and writes at a path inside the value, writing the whole value back", () => {
  const s = store([{ q: 0, h: 10 }, { q: 1, h: 14 }]);
  const p = scopedParams({ read: s.read, write: s.write, path: "1" });
  expect(p.h).toBe(14);
  expect("h" in p).toBe(true);
  expect(Object.keys(p)).toEqual(["q", "h"]);
  p.h = 20;
  expect(s.current()).toEqual([{ q: 0, h: 10 }, { q: 1, h: 20 }]);
  expect(s.writes).toHaveLength(1);
});

test("an empty path scopes to the root; a dotted path walks objects", () => {
  const s = store({ walls: { north: true, south: false } });
  const root = scopedParams({ read: s.read, write: s.write, path: "" });
  expect(Object.keys(root)).toEqual(["walls"]);
  const walls = scopedParams({ read: s.read, write: s.write, path: "walls" });
  walls.south = true;
  expect(s.current().walls.south).toBe(true);
});

test("a write whose parent does not exist is refused and reported, never thrown", () => {
  const s = store([{ q: 0 }]);
  const errors = [];
  const p = scopedParams({ read: s.read, write: s.write, path: "7", onError: (m) => errors.push(m) });
  expect(p.h).toBeUndefined();
  expect(() => { p.h = 1; }).not.toThrow();
  expect(s.writes).toHaveLength(0);
  expect(errors[0]).toMatch(/no value at path "7"/);
});

test("Object.assign (a preset bundle) writes each key through the proxy", () => {
  const s = store([{ q: 0, h: 1 }]);
  const p = scopedParams({ read: s.read, write: s.write, path: "0" });
  Object.assign(p, { q: 5, h: 6 });
  expect(s.current()).toEqual([{ q: 5, h: 6 }]);
});

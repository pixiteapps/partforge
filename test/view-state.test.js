import { afterEach, beforeEach, expect, test } from "vitest";
import {
  loadCamera, saveCamera, loadView, saveView,
  loadTheme, saveTheme,
  loadRenderMode, saveRenderMode, loadEnvironment, saveEnvironment,
} from "../src/framework/view-state.js";

function mockStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = mockStorage();
  globalThis.sessionStorage = mockStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});

test("camera round-trips pos/target; null when absent", () => {
  expect(loadCamera()).toBeNull();
  saveCamera({ pos: [1, 2, 3], target: [4, 5, 6] });
  expect(loadCamera()).toEqual({ pos: [1, 2, 3], target: [4, 5, 6] });
});

test("view round-trips per part key in sessionStorage; null when absent", () => {
  expect(loadView("Planter")).toBeNull();
  saveView("Planter", "assembly");
  expect(loadView("Planter")).toBe("assembly");
  expect(globalThis.sessionStorage.getItem("partforge:view:Planter")).toBe("assembly");
});

test("a view saved for one part is not visible to another", () => {
  saveView("Planter", "assembly");
  expect(loadView("Bracket")).toBeNull();
});

test("the view is never written to localStorage", () => {
  saveView("Planter", "assembly");
  expect(globalThis.localStorage.getItem("partforge:view:Planter")).toBeNull();
  expect(globalThis.localStorage.getItem("partforge:view")).toBeNull();
});

test("an absent or empty part key is a no-op for load and save", () => {
  expect(loadView("")).toBeNull();
  expect(loadView(undefined)).toBeNull();
  saveView("", "assembly");
  saveView(undefined, "assembly");
  expect(globalThis.sessionStorage.getItem("partforge:view:")).toBeNull();
  expect(globalThis.sessionStorage.getItem("partforge:view:undefined")).toBeNull();
});

test("theme round-trips light/dark; defaults to dark when absent", () => {
  expect(loadTheme()).toBe("dark");      // absent → default dark
  saveTheme("light");
  expect(loadTheme()).toBe("light");
  saveTheme("dark");
  expect(loadTheme()).toBe("dark");
});

test("corrupt stored theme → loadTheme returns the dark default", () => {
  globalThis.localStorage.setItem("partforge:theme", "neon");
  expect(loadTheme()).toBe("dark");
});

test("corrupt camera JSON → loadCamera returns null", () => {
  globalThis.localStorage.setItem("partforge:camera", "{not json");
  expect(loadCamera()).toBeNull();
});

test("non-finite camera value → loadCamera returns null", () => {
  globalThis.localStorage.setItem("partforge:camera", '{"pos":[1,2,null],"target":[0,0,0]}');
  expect(loadCamera()).toBeNull();
});

test("saveCamera skips invalid input (no write, no throw)", () => {
  saveCamera({ pos: [1, 2, 3] });        // missing target
  expect(loadCamera()).toBeNull();
  saveCamera({ pos: [1, 2], target: [0, 0, 0] }); // wrong length
  expect(loadCamera()).toBeNull();
});

test("storage that throws → loads return defaults, saves are no-ops", () => {
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  globalThis.localStorage = throwing;
  globalThis.sessionStorage = throwing;
  expect(loadCamera()).toBeNull();
  expect(loadView("Planter")).toBeNull();
  expect(loadTheme()).toBe("dark");
  expect(() => {
    saveCamera({ pos: [1, 2, 3], target: [0, 0, 0] });
    saveView("Planter", "x");
    saveTheme("light");
  }).not.toThrow();
});

test("render mode persists and nothing stored reads as null", () => {
  localStorage.clear();
  expect(loadRenderMode()).toBeNull();
  saveRenderMode("realistic");
  expect(loadRenderMode()).toBe("realistic");
  saveRenderMode("bogus");
  expect(loadRenderMode()).toBe("realistic");
});

test("environment persists and an unknown stored id reads as null", () => {
  localStorage.clear();
  expect(loadEnvironment()).toBeNull();
  saveEnvironment("workshop");
  expect(loadEnvironment()).toBe("workshop");
  localStorage.setItem("partforge:environment", "moon");
  expect(loadEnvironment()).toBeNull();
});

test("render mode and environment tolerate storage that throws", () => {
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  globalThis.localStorage = throwing;
  expect(loadRenderMode()).toBeNull();
  expect(loadEnvironment()).toBeNull();
  expect(() => { saveRenderMode("realistic"); saveEnvironment("workshop"); }).not.toThrow();
});

// The styled CPU renderer and the data it shares with the viewer must stay free
// of three: they run in Node (and the oracle's closure) with no WebGL, and the
// viewer's THREE half (contact-shadow-plane.js) is deliberately kept apart from
// the pure mask in contact-shadow.js. Guards the whole transitive closure.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const FW = `${ROOT}/src/framework`;
const entries = [
  `${FW}/renderStyles.js`,
  `${FW}/style-camera.js`,
  `${FW}/contact-shadow.js`,
  ...readdirSync(`${FW}/softrender`).filter((f) => f.endsWith(".js")).map((f) => `${FW}/softrender/${f}`),
];

test.each(entries)("%s does not import three", (entry) => {
  const { bare, importer } = walk(entry, "no-three walk");
  const three = [...bare].filter((s) => s === "three" || s.startsWith("three/"));
  expect(three.length, three.length ? `three reached:\n  ${chainTo(three[0], importer, ROOT)}` : "").toBe(0);
});

// test/fixtures/implicit-native-cases.js
// The case list the native stage parity tests share (implicit-native-sample/-mesh):
// every small tree, the vase, the hand, every ADVERSARIAL spec and PR 1's
// exactly-touching-faces cases, each at the grid edges it is held at.
import { core } from "../../src/framework/core/core.js";
import { NativeSession } from "../../src/framework/core/implicit-core.js";
import { TREES } from "./implicit-small-trees.js";
import { vaseSpec, handSpec, ADVERSARIAL } from "./implicit-trees.js";

const EDGES = [0.5, 1.0];
const TOUCHING = {
  mirrorHalfBox: { root: { kind: "mirror", plane: "yz", child: { kind: "box", size: [10, 10, 10], at: [5, 0, 0] } } },
  coincidentFaces: ADVERSARIAL.coincidentFaces,
  repeatTouching: { root: { kind: "repeat", linear: { count: 3, step: [4, 0, 0] }, child: { kind: "box", size: [4, 4, 4] } } },
  flushTouchingTool: { root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [20, 20, 10], at: [0, 0, 10] }] } },
  flushPocket: { root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [4, 4, 10], at: [0, 0, 5] }] } },
};

/** [{ name, spec, images, edges }]. */
export function nativeCases() {
  const vase = vaseSpec();
  return [
    ...Object.entries(TREES).map(([k, spec]) => ({ name: k, spec, images: new Map(), edges: EDGES })),
    { name: "vase", spec: vase.spec, images: vase.images, edges: EDGES },
    { name: "hand", spec: handSpec(), images: new Map(), edges: [1.5, 0.8] },
    ...Object.entries(ADVERSARIAL).map(([k, spec]) => ({ name: `adversarial ${k}`, spec, images: new Map(), edges: EDGES })),
    ...Object.entries(TOUCHING).map(([k, spec]) => ({ name: `touching ${k}`, spec, images: new Map(), edges: EDGES })),
  ];
}

/** A native session holding the plan's textures and programs, in plan order. */
export function sessionFor(plan) {
  const s = new NativeSession(core());
  for (const t of plan.textures) s.addTexture(t);
  for (const p of plan.programs) s.addProgram(p);
  return s;
}

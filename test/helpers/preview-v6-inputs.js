// The inputs behind the version 6 preview fixtures (test/fixtures/preview-v6.glb and
// preview-v6-animated.glb), written by the 0.201.0 encoder (version 6). A version 7
// encoder must write the same bytes for them apart from the version digit
// (test/gltf-encode-ties.test.js): a mesh without ties is unchanged by version 7.
import { boxEdges, boxSoup, indexedBox } from "./preview-glb.js";
import { box, input } from "./preview-animation-fixture.js";

const part = {
  parts: { base: { display: { color: 0xff0000 } }, lid: {}, glass: { display: { opacity: 0.4 } } },
  meta: { background: 0x202020 },
};

export const inputs = {
  // Soup and indexed meshes, feature edges, display, meta and params.
  still: () => ({
    meshes: [
      { ...boxSoup("base", [0, 0, 0], [4, 2, 6]), edges: boxEdges([0, 0, 0], [4, 2, 6]) },
      { ...indexedBox("lid", [0, 0, 6], [4, 2, 7]), edges: boxEdges([0, 0, 6], [4, 2, 7]) },
      boxSoup("glass", [5, 0, 0], [6, 1, 1]),
    ],
    part,
    view: "assembly",
    params: { width: 40, label: "A", lid: true },
  }),
  // A baked animation: the lid swings, the base is still.
  animated: () => ({ meshes: [box("base"), box("lid", 24)], view: "box", animation: input(), params: { open: 0 } }),
};

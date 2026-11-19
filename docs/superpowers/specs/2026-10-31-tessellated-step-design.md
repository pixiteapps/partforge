# Tessellated STEP for organic parts

Date: 2026-10-31. Branch: from `feat/implicit`, a PR into it (#297's last feature).
Replaces "Routing and tessellated STEP" (§5, PR 4) of
`2026-10-14-implicit-organic-parts-design.md`. Facts below were checked against the code
at `ff7faf5d`.

## Why

People build hybrid parts: some sub-parts are ordinary exact solids (a mounting plate, a
bracket, a threaded boss), some are `k.implicit` organic bodies (a grip, a hand, a
sculpted shell). They want ONE STEP file of the whole part, to open in a CAD or CAM tool,
cut it on a CNC, or pass it on to another tool. Today a STEP export of any part with a
`k.implicit` sub-part fails: every STEP job goes to the OCCT worker
(`export-controller.js` `backendForFormat`), and OCCT throws on `k.implicit`
(`occt-backend.js`), after booting and building.

## Goals

1. A STEP export of a part with organic sub-parts succeeds and writes one file: the
   ordinary sub-parts as exact B-rep solids, exactly as today; each organic sub-part as a
   closed tessellated body carrying its mesh at export quality.
2. Each tessellated body keeps its sub-part's name, colour and export pose, and sits in
   the file's product structure the same way a solid body does.
3. The file follows the STEP standard (AP242's tessellated geometry), so any conforming
   reader can open it. No single CAD tool is the target.
4. The rest of a STEP export is unchanged: a part with no `k.implicit` writes the same
   file as before (the same DATA section; OCCT stamps the time in the header).

## Non-goals

- Converting the mesh to exact (NURBS) surfaces. A tessellated body stays a mesh.
- A STEP export from the CLI (there is no export verb today).
- A "which sub-parts will export tessellated" report in `measure` or lint (the original
  design listed it; deferred, my call).
- Mesh simplification or a triangle cap. CAM needs the full export-quality mesh; a big
  mesh makes a big file, and the docs say so.
- Letting OCCT *build* `k.implicit`. OCCT still throws on it; this design only gets the
  Manifold-built mesh into OCCT's file. Lint's `implicit-needs-manifold` stays as is.

## Anti-goals

- No change to any existing STEP file's bytes, and no change to STL, 3MF or the cut kit.
- No custom OCCT build. The design works with the installed `replicad-opencascadejs`
  (OCCT 7.6), whose STEP writer has no tessellated entities and whose bindings have no
  `BRep_Builder` (so a triangulation cannot be attached to a face from JS).
- No silent fallback: if an organic sub-part cannot be meshed or written, the export
  fails with a message that names it.

## What "organic sub-part" means

A sub-part whose build calls `k.implicit` (directly, or anywhere in its build). It is
built WHOLE on Manifold, including any ordinary ops in it (a `k.implicit` body unioned
with a box is one mesh body). It is detected per sub-part from the geometry-free probe,
the same probe lint and backend routing already run, at the export's params. A sub-part
with no `k.implicit` call is an ordinary sub-part and goes to OCCT as today.

- **The probe can miss a call** (one gated on a geometry query the probe answers with a
  placeholder, the same way it can miss a `shell`). Such a sub-part then builds on OCCT
  and fails. There is no runtime reroute: the failure names the sub-part and says it
  calls `k.implicit` where the geometry-free probe cannot see it. (My call: a reroute
  latch like `NEEDS_OCCT`'s doubles the orchestration for a rare case.)
- **A sub-part that is both organic and calls `shell`** cannot build anywhere; the
  export fails naming it, and suggests `onion` for a shelled organic body.
- **`meta.backend` does not change the STEP split.** Today STEP ignores the pin, and it
  still does: under a `"manifold"` pin (which the organic guide recommends) the ordinary
  sub-parts still go to OCCT as exact solids, and organic sub-parts are meshed on
  Manifold whatever the pin says. Lint's `implicit-needs-manifold` stands, because an
  `"occt"` pin or a `shell` still breaks the preview and the other exports.

## How it works

**1. Mesh the organic sub-parts on Manifold.** For a STEP export, the export path asks
the Manifold worker for each organic sub-part's mesh: the export pose
(`purpose: "export"`), the export (print) tier, as JS-owned `positions` / `indices`
arrays, transferred. This is the reverse of the existing `tessellate-imports` crossover
(OCCT meshes STEP imports for Manifold); it should follow that job's shape and its
failure handling. Both the app's export button (`mount.js`) and headless
`exportParts()` (`export-controller.js`) go through it, so the policy lives in one place,
next to `backendForFormat`. partforge-cloud exports only through `runtime.exportParts`
(checked: it never posts `export-step` to a worker itself), so the orchestration can
live on the main thread. An `export-step` message with no meshes keeps exactly today's
behaviour.

**2. Build and write on OCCT.** The `export-step` job on the OCCT worker gains the
organic meshes as input. It builds only the ordinary sub-parts, lays every piece out as
today (`layoutExportPieces`; an organic piece's bounds come from its mesh), and writes
the file.

**3. Put the meshes in the file.** OCCT 7.6 cannot write tessellated geometry, so
partforge writes those entities itself and splices them into OCCT's STEP text, under
OCCT's own product structure. The entities are AP242's: a `TESSELLATED_SOLID` (or
`TESSELLATED_SHELL`) of `TRIANGULATED_FACE`s over a `COORDINATES_LIST`, in its own
shape representation, with the body's name and colour.

The preferred way to get the product structure, naming and colour right with the least
hand-written STEP: OCCT writes a small placeholder solid for each organic sub-part, named
and coloured like it, and the writer then replaces that placeholder's geometry with the
tessellated representation. Whether that splice is clean — or whether writing the
product, placement and style entities directly is simpler — is the builder's first task
to settle, by a short spike, before the rest is built on it.

**4. Errors.** An export either succeeds or fails with a message naming the sub-part, as
an STL export does today (`exportPieceError`). There is no warning path: a Manifold body
is closed by construction, and an empty `k.implicit` already throws at build, so every
organic mesh is written as a closed `TESSELLATED_SOLID`. No new field is added to the
export's reply.

## Checking the file

No reader that CI can run opens tessellated STEP (OCCT 7.6 cannot read it either). So:

- **In CI:** the writer's output is held to the standard by structure. A small test-only
  STEP reader parses the file and checks: every entity reference resolves; each
  organic sub-part has exactly one product with its name, one tessellated body, and one
  colour; the triangle count and vertex coordinates match the mesh it was given (to the
  file's number precision); every triangle index is in range; the solid sub-parts'
  entities are the same as an export without the organic ones.
- **Once, by hand, before merge:** open a hybrid export (the hand beside a plain box) in
  one standards-following reader and record what it shows in the PR. My call: FreeCAD
  (its OCCT 7.7+ reads AP242 tessellated geometry), because it is free and runs locally.
  If it rejects something the structure test passed, that is a bug in the writer.

## Size

A print-tier hand is ~100–180k triangles; its tessellated body is a text block of roughly
10–20 MB. That is acceptable for a CAM hand-off and is stated in the docs. Writing it must
stream into the output rather than build one giant string, so the OCCT worker's memory
stays bounded (the builder picks how).

## Tests

- A hybrid part (a box sub-part and a `k.implicit` sub-part) exports STEP; the file passes
  the structure check; the box's entities are unchanged.
- A part with no `k.implicit` exports byte-identical STEP to before.
- An organic sub-part's name and colour reach the file; its export pose is applied.
- An organic sub-part that throws fails the export naming it.
- `exportParts({ format: "step" })` and the app path both reach the new route.
- OCCT and Manifold never boot in one test process (an AGENTS.md invariant): the
  Manifold half's meshes cross into OCCT tests as fixtures or through a child process.

## Docs

- `docs/domains/organic.md` "Backend": STEP export of organic sub-parts writes them as
  tessellated bodies; what that means (a mesh, at the export grid; file size).
- `docs/AUTHORING-PARTS.md` export section: one line on hybrid STEP.
- `docs/KERNEL-CONTRACT.md`: the implicit rows lose "OCCT throws until tessellated STEP";
  the OCCT error text loses "not supported yet". (The final contract entry and version
  decision stay with the release PR.)
- `docs/ERROR-PATTERNS.md`: an entry for an organic sub-part that fails to export.

## Left to the builder

- The splice approach (placeholder replacement vs writing product entities directly),
  settled by the first task's spike.
- The crossover job's name, message shape and where the per-sub-part probe runs.
- Number formatting in the coordinates list (enough digits to round-trip the mesh's
  float32 coordinates).
- The structure-check reader's scope (only what the tests need).

## Calls I made (not discussed)

- Organic sub-parts are detected per sub-part by the probe; a sub-part with any
  `k.implicit` is a mesh body as a whole.
- No triangle cap and no simplification.
- No measure/lint "exports tessellated" report.
- The manual check uses FreeCAD.
- No runtime reroute when the probe misses a `k.implicit`; a named failure instead.
- `meta.backend` pins do not change the STEP split.
- No warning path and no open-shell body: every organic mesh is closed.

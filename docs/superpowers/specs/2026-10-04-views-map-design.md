# Views as a map of poses — design

Date: 2026-10-04. Status: proposed. Follows `2026-10-03-place-only-pose-design.md` (0.141)
and partforge PR #254 (0.142: per-view display poses allowed, overhang read in the print
pose). Motivated by partforge-cloud feedback #161 and #162 (the Lattice Box).

## Problem

A multi-piece part that wants (a) a tab per piece, (b) an animated assembled view and (c)
a view of every piece laid out on the bed has no clean expression today. `place(solid,
{ purpose, view, p, d })` must branch on two axes, and the model writes if-chains:

```js
place: (s, { purpose, view, p }) => purpose === "export" ? s
  : view === "print" ? s.translate([p.w + 10, 0, 0])
  : closedAndHinged(s, p),
```

Until 0.142 the `view` branch was a lint error that blocked loading, so the agent
duplicated every piece (`printLid` + `lidAsm`, 13 sub-parts for 5 pieces), built the
assembly copies pre-rotated, and drew diagonal layer lines. The branching itself remains
the confusing part for the model.

## Decision

Each sub-part's `views` becomes a **map from view name to pose**. `place` and `purpose`
retire from the docs.

```js
lid: {
  build: (k, p) => makeLid(k, p),                                  // as it prints
  views: {
    assembly: (s, p, d) => swing(s.rotateX(180).translate([0, p.d, p.h + p.t]), p, d),
    lid: true,
    print: (s, p, d) => s.translate([p.w + d.gap, 0, 0]),
  },
},
```

### Rules (as taught)

1. One sub-part per physical piece — never separate "print" and "assembled" copies.
2. `build()` makes the piece **as it prints**: at the origin, flat face on the bed
   (z = 0). That is what is exported and the direction layer lines run.
3. `views` maps view name → `true` (shown as built) or `(s, p, d) => s` that only
   translates/rotates its argument — no geometry queries, no `scale`/`mirror`, no new
   solid. A view absent from the map does not show the piece.
4. A param that moves a piece (hinge angle, slide, explode distance) is read only in view
   entries; it then animates at frame rate.
5. List `assembly` first (default tab; what headless `verify` checks), piece tabs next,
   `print` last.
6. A piece that is not printed (a filament pin, a bearing) is `exportable: false` and
   appears in `assembly` only.
7. Sheet pieces keep `sheetPart`'s `pose`; their entries are `true`; they stay out of
   `print`.

### Decisions taken (Scott, 2026-10-04)

- **No second concept for print orientation.** "Build it as it prints" is already the
  documented rule (AUTHORING-PARTS "Printed parts that key into sheets", `laser-box.js`
  hinge, the cloud prompt's flat-lid example). A `print:` pose key would be `purpose`
  renamed; a reserved `print` view name is magic by string; auto-orientation has no
  helper, is wrong for parts without a dominant flat face, and would be a geometry query
  that drops animations off the pose fast path. `src/parts/hinged-box.js` — the one
  example built assembled — is rewritten.
- **Pose signature `(s, p, d)`**, matching `build(k, p, d)`. The context object only
  existed to carry `view`/`purpose`.
- **Export is unchanged in what it selects**: every sub-part checked in the export list,
  regardless of the active tab, each **as built** (the canonical solid — its print
  orientation). STL stays one file per piece.
- **3MF and STEP lay the selected pieces out automatically.** Both write every selected
  piece into one file; as built, each sits at its own origin and they would overlap. The
  exporter arranges them by XY bounding box with a fixed gap (below). Authored view poses
  never reach an export.

## Export layout (3MF and STEP)

- Input: each selected piece's export solid and its bounding box.
- Each piece is translated so its bbox min Z is 0 (it rests on the bed) — a no-op for a
  piece built as it prints, and a guard for one that is not.
- XY placement reuses `export/layout.js`'s deterministic first-fit-decreasing-height
  shelf packer (the cut kit's), without rotation, `spacing` = 10 mm, across a width of
  the part's process bed X when `verify.process` names one (`dfm-profiles.js` `bed`),
  else the larger of 220 mm and the widest piece. A layout that overflows the bed's Y is
  still written (a slicer can split plates); the export reports no error for it.
- Translation only, so layer lines, overhang and the per-piece STL are unaffected, and
  the piece set dedupe in the cut kit (identical export solids) still holds.
- Legacy parts (array `views` + `place`): the export solid is `place(…, "export")` as
  today; the same layout then replaces whatever translation the author gave it. An
  authored print layout in a legacy part's export branch is therefore discarded in 3MF
  and STEP — accepted, since the layout exists to stop overlaps and an authored one is
  re-derived to the same end.

## Compilation — one normalization at load

`part-model.js` normalizes every sub-part once, at load, into the record every consumer
already reads:

```
{ views: string[], place(s, { view, purpose, p, d }) }
```

- Map form: `views` = the map's keys in order; `place` = `purpose === "export" ? s :
  (entry === true ? s : entry(s, p, d))` for the entry of `view`.
- Array form (legacy) passes through untouched. Both forms stay supported for saved
  forges; only the map is documented (array form moves to the Legacy section, or the
  regenerated cloud corpus teaches both).
- A sub-part declaring both a map and `place` is a lint error (`views-and-place`).

Consumers that read `sp.views` / `sp.place` and must see the normalized record
(file:line from the 2026-10-04 review): `param-deps.js:26,47,51,104`,
`default-view.js:7`, `rules-shape.js:84,103` (its fix text "list the view name in the
sub-part's `views` array" changes), `rules-animations.js:249,527`, `rules-place.js:24`,
`sheet/constants.js:26` (`SUBPART_PASSTHROUGH_KEYS` passes `views` verbatim),
`sheet/part.js:85` (`generatedPlace` must call the view entry after the sheet pose).
Lint runs on the raw object today; it must lint the normalized record and additionally
validate the raw map's shape.

## Lint

- `view-entry-invalid` (error): an entry that is neither `true` nor a function
  (`false`, `null`, a string, an object). Message names the view and the allowed forms.
- `view-pose-not-rigid` (error) replaces `place-not-rigid`: each entry is probed alone on
  the canonical token (place scope); `baseHash !== CANONICAL` is an error. Absolute
  rather than display-vs-export, which is what the old rule meant — today a `scale` on
  both purposes passes. Legacy `place` keeps `place-not-rigid`.
- `views-and-place` (error): both forms on one sub-part.
- Notes unchanged: `animation-track-rebuilds` fires only for an entry the probe cannot
  read.

## Runtime and oracle changes

- `materials/print-frame.js`: for a map-form sub-part the canonical delivery's print
  frame is identity (mesh-local IS the print frame) — two probes per sub-part dropped. A
  posed (untrusted-entry) delivery: inverse of its full-scope pose when trusted, else
  identity, as today. Update the `mount.js` ~985-1000 comment.
- `oracle/measure.js`: `printPoseBboxes` reads the canonical bbox (no second build);
  0.142's `printPoseOverhang` is identity for map-form parts and needs no change.
- `oracle/verify.js:293` hint rewording (names `place()` / `purpose "export"`).
- `jobs.js` `posed(name, "export")` returns the canonical solid for map-form parts via
  the normalized `place`; the 3MF/STEP branches call the layout above.
- Known transient, accepted: a posed delivery (untrusted entry) built for view A shows
  A's pose after a switch to B until the regen loop rebuilds it
  (`pose-fast-path.js:93`) — same class as today's stale-shown branch.
- Offscreen captures (`captureView(name)`), `assembly.js`, `oracle/build.js` are per view
  already.

## Docs and examples

- `AUTHORING-PARTS.md` "The PartDefinition contract": the map replaces `views` array +
  `place` + `purpose`; the seven rules above; a Legacy subsection keeps the old form.
- `ERROR-PATTERNS.md`: entries for the three new lint ids; `place-not-rigid` points at
  the legacy section.
- Rewrite `src/parts/hinged-box.js` (lid built flat, `assembly` entry places it) and
  `src/parts/laser-box.js` (`hingePlace` → entries). Every other example with `place`
  migrates; a test asserts no example under `src/parts/` uses `place` or array `views`.
- Worked Lattice Box (body, lid, lattice insert, nameplate, filament pin; `assembly`
  animated by `lidAngle` through a shared `swing` helper in `lib/pose.js`; piece tabs;
  `print`) lands as an example part, and its `verify` exercises overlaps in `assembly`.

## Cloud follow-up (partforge-cloud)

- Pin bump + `npm run docs:generate && npm run prompt:generate`; read the prompt diff.
- Replace PR #420's "Assemblies, animations and print orientation" section with the
  seven rules and the lid example; recheck the compact byte cap.
- `evals/cases/create/hinged-lattice-box.js`: add "and a print view with every piece laid
  out on the bed"; its `onePiecePerPart` and `printPoseIgnoresAnimation` checks keep
  their meaning (the latter reads the export solid, now canonical).
- `render_part_views`' `views` means camera angles, so the agent cannot look at the Print
  tab headlessly — out of scope here; noted for the render tool.

## Testing

- Normalization: map → record equivalence with the hand-written `place` it replaces,
  for every example part (same meshes, same poses per view, same export solids).
- Each consumer listed above: one test reading a map-form part.
- Lint: the three new rules, positive and negative; legacy rules unchanged on array
  parts.
- Export layout: no two selected pieces' bboxes intersect in 3MF/STEP; translation only
  (each piece's mesh equals its STL up to translation); bed width from the profile;
  deterministic order.
- Pose ladder: a map-form animation track plays at frame rate (no rebuild) and the
  print frame is identity; a tab switch re-poses without a worker job.
- Oracle: overhang and bed-fit on a map-form part read the canonical solid.

## Rollout

partforge minor (0.143.0) with the cloud pin bump and prompt change as the next cloud
PR; the eval case above re-run on Flash, `-compact` arms, before merge. Saved forges are
unaffected (legacy form) except for the 3MF/STEP layout rule.

## Open questions

1. Bed width when no process is declared: 220 mm (the FDM profiles' X) or unbounded
   single row? Proposed: 220 mm, widened to fit the widest piece.
2. A view-level `layout: "bed"` that arranges `true` entries automatically in the
   viewer (the export packer, shown) — deferred until evals show the agent getting
   `print` translates wrong; it would retire per-piece `print` entries from the docs.

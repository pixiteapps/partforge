// Animation reference part — a box with a hinged lid. Worked example for
// docs/AUTHORING-PARTS.md "Animations": animations are VIEW-OWNED (declared
// under `views.box.animations`, so the transport bar belongs to that view),
// they drive pose-only params (lidAngle, lidLift) through place(), and
// `assemble` opens with an OPACITY fade that brings the lid in from nothing
// before any motion. Also shown: an intro camera + markdown description on
// `open`, a looping autoplay `cycle`, and per-step cameras on `assemble`.
export default {
  meta: { title: "Hinged Box", units: "mm", environment: "workshop" },
  parameters: [
    {
      id: "box",
      title: "Box",
      description: "Outer dimensions of the base. The lid is a flat plate of the same wall thickness.",
      advanced: [
        { key: "width", label: "Width", unit: "mm", min: 20, max: 120, step: 1,
          description: "Outer width (X)." },
        { key: "depth", label: "Depth", unit: "mm", min: 20, max: 120, step: 1,
          description: "Outer depth (Y). The hinge runs along the rear edge." },
        { key: "height", label: "Height", unit: "mm", min: 10, max: 80, step: 1,
          description: "Outer height of the base (Z)." },
        { key: "wall", label: "Wall", unit: "mm", min: 1.2, max: 5, step: 0.2,
          description: "Wall and lid thickness." },
      ],
    },
    {
      id: "pose",
      title: "Pose",
      description: "Presentation pose. The **Open lid** and **Assemble** animations drive these — both are pose-only, so animating them never rebuilds geometry.",
      advanced: [
        { key: "lidAngle", label: "Lid angle", unit: "°", min: 0, max: 110, step: 1,
          description: "Hinge opening angle about the rear top edge." },
        { key: "lidLift", label: "Lid lift", unit: "mm", min: 0, max: 60, step: 1,
          description: "Assembly explode offset: raises the lid straight up off the hinge." },
      ],
    },
  ],
  defaults: { width: 60, depth: 40, height: 24, wall: 2, lidAngle: 0, lidLift: 0 },
  parts: {
    base: {
      label: "Base",
      views: ["box"],
      export: { name: "base" },
      display: { material: "walnut" },
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.width, p.depth, p.height] })
          .cut(k.box({ min: [p.wall, p.wall, p.wall], max: [p.width - p.wall, p.depth - p.wall, p.height + 1] })),
    },
    lid: {
      label: "Lid",
      views: ["box"],
      export: { name: "lid" },
      display: { material: "walnut" },
      build: (k, p) => k.box({ min: [0, 0, p.height], max: [p.width, p.depth, p.height + p.wall] }),
      // Display: swing about the hinge line (rear top edge, axis +X through
      // [0, depth, height]; negative angle opens upward), then the assembly
      // lift. Export: the lid prints flat beside the base. Both poses are
      // rigid motions of the same solid, and neither reads `view` — the two
      // invariants lint's place rules hold every part to.
      place: (s, { purpose, p }) =>
        purpose === "export"
          ? s.translate([p.width + 10, 0, -p.height])
          : s.rotate(-p.lidAngle, [0, p.depth, p.height], [1, 0, 0]).translate([0, 0, p.lidLift]),
    },
  },
  views: {
    box: {
      label: "Box",
      animations: {
        open: {
          label: "Open lid",
          description: "Swings the lid to **110°** about the rear hinge line.\n\nPose-only: playback runs at frame rate with no geometry rebuild.",
          camera: "front",
          duration: 1.2,
          tracks: { lidAngle: [[0, 0], [1, 110]] },
        },
        cycle: {
          label: "Open / close",
          duration: 2.4,
          loop: true,
          easing: "linear",
          autoplay: true,
          tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] },
        },
        assemble: {
          label: "Assemble",
          description: "How the parts come together: the lid fades in above the base, drops on, then swings open to check hinge clearance.",
          steps: [
            // The lidLift hold-track pins the lift at 40 while the lid fades in,
            // so step 2's drop starts from where the fade showed it. Without it
            // the lift would hold step 2's FIRST keyframe — also 40 — but
            // stating it makes the pose explicit and survives a retune of step 2.
            { label: "Lid appears", camera: "iso", duration: 0.8,
              opacity: { lid: [[0, 0], [1, 1]] },
              tracks: { lidLift: [[0, 40], [1, 40]] } },
            { label: "Lower the lid", camera: "left", duration: 1.0,
              tracks: { lidLift: [[0, 40], [1, 0]] } },
            { label: "Open to check clearance", camera: "iso", duration: 1.0,
              tracks: { lidAngle: [[0, 0], [1, 110]] } },
          ],
        },
      },
    },
  },
  verify: {
    process: "fdm-pla",
    expect: {
      base: { bbox: "<=[200,200,200]" },
      _view: { overlaps: 0 },
    },
  },
};

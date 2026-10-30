// Printed robot finger: three links on pin joints, posed by one limb. The kinematics
// reference part and the worked example of the kinematics domain guide.
//
// Each link is built as a link frame wants it: its own joint pin at the origin, the
// link running along +Y, its bending side toward -Z. derive() declares the finger once
// with limb() and poses it from p.curl; the assembly view hands every link to
// d.finger.place(s, "<joint>"), which carries it through every joint above it. curl is
// read only in derive, and d.finger only in views, so the Close animation is pose-only:
// no link rebuilds while it plays.
import { limb } from "partforge/kinematics";

// Link section and joint geometry, mm. A link is W wide and 2R thick. Its proximal end
// is a tongue (the middle third of the width) rounded about the pin; its distal end is
// a fork (the outer thirds) rounded about the next pin, so the next link's tongue
// swings between the cheeks. GAP is the running clearance on every side of a tongue.
const W = 18, R = 6, GAP = 0.4, PIN_R = 1.6;
const TONGUE = W / 3;
// Ranges stop at 90°: past that a link's square end would swing into the fork behind it.
const RANGE = { mcp: [0, 90], pip: [0, 90], dip: [0, 80] };

/** A link of length `len` in its link frame; `fork` = it carries the next joint's cheeks. */
function link(k, len, fork) {
  const box = (min, max) => k.box({ min, max });
  // A boss about the X axis (the bend axis) centred at y, spanning x0..x1.
  const boss = (y, x0, x1, r = R) => k.cylinder({ r, h: x1 - x0 }).along("+X").at([x0, y, 0]);
  const t = TONGUE / 2, near = R + GAP;              // the tongue's half width; where the full body starts
  const parts = [
    box([-t, 0, -R], [t, near, R]), boss(0, -t, t),   // tongue on this link's own pin
  ];
  if (fork) {
    const far = len - R - GAP;                       // where the full body ends and the cheeks begin
    parts.push(box([-W / 2, near, -R], [W / 2, far, R]));
    for (const [x0, x1] of [[-W / 2, -t - GAP], [t + GAP, W / 2]]) {
      parts.push(box([x0, far, -R], [x1, len, R]), boss(len, x0, x1));
    }
  } else {
    parts.push(box([-W / 2, near, -R], [W / 2, len - R, R]), boss(len - R, -W / 2, W / 2));   // rounded fingertip
  }
  let solid = k.union(parts).cut(boss(0, -W, W, PIN_R));
  if (fork) solid = solid.cut(boss(len, -W, W, PIN_R));
  return solid;
}

// Laid flat for printing: each link's -Z face on the bed (z = 0), spaced along X.
const print = (i) => (s) => s.translate([i * (W + 10), 0, R]);

export default {
  meta: { title: "Robot finger", units: "mm" },
  parameters: [
    { id: "links", title: "Links", description: "Pin-to-pin length of each link.", controls: [
      { key: "proximal", label: "Proximal", unit: "mm", min: 35, max: 60, step: 1, description: "Base pin (mcp) to the middle pin (pip)." },
      { key: "middle", label: "Middle", unit: "mm", min: 25, max: 40, step: 1, description: "Middle pin (pip) to the end pin (dip)." },
      { key: "distal", label: "Distal", unit: "mm", min: 18, max: 30, step: 1, description: "End pin (dip) to the fingertip." },
    ] },
    { id: "pose", title: "Pose", description: "Pose-only: moving it never rebuilds a link.", controls: [
      { key: "curl", label: "Curl", min: 0, max: 1, step: 0.01, description: "0 is straight, 1 is every joint at the end of its range; the end joint follows the middle one." },
    ] },
  ],
  defaults: { proximal: 45, middle: 30, distal: 24, curl: 0.3 },
  derive: (p) => ({
    finger: limb("finger", {
      at: [0, 0, R],                                  // the base pin, one link-radius up
      toward: [0, 0, 1],                              // the straight finger stands up
      bendToward: [0, -1, 0],                         // and curls toward -Y
      joints: [
        { name: "mcp", range: RANGE.mcp },
        { name: "pip", range: RANGE.pip },
        { name: "dip", range: RANGE.dip, follow: { joint: "pip", ratio: 0.75 } },
      ],
      lengths: [p.proximal, p.middle, p.distal],
    }).pose({ curl: p.curl }),
  }),
  parts: {
    proximal: {
      label: "Proximal link",
      build: (k, p) => link(k, p.proximal, true),
      views: { assembly: (s, p, d) => d.finger.place(s, "mcp"), print: print(0) },
    },
    middle: {
      label: "Middle link",
      build: (k, p) => link(k, p.middle, true),
      views: { assembly: (s, p, d) => d.finger.place(s, "pip"), print: print(1) },
    },
    distal: {
      label: "Distal link",
      build: (k, p) => link(k, p.distal, false),
      views: { assembly: (s, p, d) => d.finger.place(s, "dip"), print: print(2) },
    },
  },
  views: {
    assembly: {
      label: "Assembly",
      animations: {
        close: { label: "Close", duration: 1.5, tracks: { curl: [[0, 0], [1, 1]] } },
      },
    },
    print: { label: "Print" },
  },
  // The links never interpenetrate, and each tongue keeps its running clearance to the
  // fork it swings in (GAP on each side) — the near miss there is intended.
  verify: {
    process: "fdm-pla",
    expect: { _view: { overlaps: 0, clearance: { "proximal×middle": ">=0.3", "middle×distal": ">=0.3" } } },
  },
};

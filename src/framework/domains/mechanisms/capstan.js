// capstan: a rope drive between a small input drum and a larger output pulley. The rope
// is terminated on the output at both ends and wound round the drum in between, so turning
// the drum winds one side on and the other off. A point source and a placer like the other
// helpers, plus the rope itself: its path (lineInfo) and what a designer asks of it (report).
// Spec 2026-11-20-lines-rope-and-cable-design.md.
//
// The rope is solved as two halves that meet at the drum's middle, M:
//   half 1  output (terminated) -> span -> drum, ending at M
//   half 2  drum, starting at M -> span -> output (terminated)
// With `cross` (the default, a drum set beside the pulley like a friction wheel) each span
// is an inner tangent and the two members turn opposite ways; without it the spans are
// outer tangents, as a belt's are, and they turn the same way.
import { failer, vec3, unit, num, memberName, frameFor, onCircle, placeIn, json3, dot } from "./frame.js";
import { solveTaut } from "../../lines/taut.js";
import { resolveRope } from "../../lines/materials.js";

const RAD = Math.PI / 180;
const r3 = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };
// The report keys a member's name sits beside (in `halves[i]`, `bend` and `travel`).
const REPORT_KEYS = new Set(["length", "span", "fleet", "runOff", "required", "ok", "inside"]);

/**
 * `rope`: `{ d, material?, mu?, EA?, minBendRatio? }` (mm; EA in N).
 * `input`: `{ name, radius, center, axis = [0, 0, 1], turns = 3, lead = rope.d }`: the drum.
 *   `turns` whole turns of rope on it beyond what the two tangents leave; `lead` the helix's
 *   advance per turn (a close-wound rope advances its own diameter).
 * `output`: `{ name, radius, center, axis = [0, 0, 1], wrap = 90 }`: the pulley. `wrap` is the
 *   degrees of rope on it past each tangent point at drive angle 0, before each termination.
 * `drive`: `{ member, angle }` (degrees, unreduced): either member.
 * `cross` (default true), `fixed` (default true: the rope is pinned to the drum at M; false: it
 * holds by friction alone, and the report adds `holding`).
 * Radii are the GROOVE radii the rope sits on; the rope's centreline runs d / 2 outside them.
 */
export function capstan(def) {
  const fail = failer("capstan");
  if (!def || typeof def !== "object") fail("", "takes { rope, input, output, drive }");
  const rope = resolveRope(fail, def.rope);
  const seen = new Set();
  const member = (key, q) => {
    if (!q || typeof q !== "object") fail(key, "must be { name, radius, center }");
    const axis = unit(fail, `${key}.axis`, q.axis ?? [0, 0, 1]);
    const name = memberName(fail, `${key}.name`, q.name, seen);
    if (REPORT_KEYS.has(name)) fail(`${key}.name`, `${JSON.stringify(name)} is a field of the report; give the member another name`);
    return {
      name,
      radius: num(fail, `${key}.radius`, q.radius, { positive: true }),
      center: vec3(fail, `${key}.center`, q.center),
      axis, frame: frameFor(fail, `${key}.axis`, axis),
    };
  };
  const input = member("input", def.input), output = member("output", def.output);
  if (Math.abs(Math.abs(dot(input.axis, output.axis)) - 1) > 1e-9) fail("output.axis", "must be parallel to the input's axis");
  const turns = def.input.turns ?? 3;
  if (!Number.isInteger(turns) || turns < 0) fail("input.turns", `must be a whole number of turns, 0 or more, got ${JSON.stringify(def.input.turns)}`);
  const lead = def.input.lead == null ? rope.d : num(fail, "input.lead", def.input.lead);
  const outWrap = def.output.wrap == null ? 90 : num(fail, "output.wrap", def.output.wrap, { positive: true });
  const cross = def.cross !== false, fixed = def.fixed !== false;
  const pretension = def.pretension == null ? null : num(fail, "pretension", def.pretension, { positive: true });
  const { drive } = def;
  if (!drive || typeof drive !== "object" || (drive.member !== input.name && drive.member !== output.name)) {
    fail("drive.member", `must name the input or the output, got ${JSON.stringify(drive?.member)}`);
  }
  const driveAngle = num(fail, "drive.angle", drive.angle);

  // pitch radii, and the way each member is wrapped (about the INPUT's axis)
  const rIn = input.radius + rope.d / 2, rOut = output.radius + rope.d / 2;
  // The pulley's centre from the drum's: along the axis (the spans then lean, also at rest)
  // and across it. Crossed or open, two members whose pitch circles meet cannot be roped.
  const between3 = output.center.map((c, j) => c - input.center[j]);
  const axial = dot(between3, input.axis);
  const across = Math.sqrt(Math.max(0, dot(between3, between3) - axial * axial));
  if (across < rIn + rOut - 1e-9) fail("output.center", `the members overlap: their centres are ${r3(across)} apart across the axis, and the rope's circles need ${r3(rIn + rOut)}`);
  const sOut = 1, sIn = cross ? -1 : 1;
  const sign = sIn / sOut;                       // output turn per input turn, by direction
  const ratio = rOut / rIn;                      // input turns per output turn
  const flip = dot(input.axis, output.axis) < 0 ? -1 : 1; // the pulley's own angle is about its own axis
  // theta (drum) and phi (pulley) are both about the INPUT's axis
  const theta = drive.member === input.name ? driveAngle : (sign * flip * driveAngle * rOut) / rIn;
  const phi = (sign * theta * rIn) / rOut;
  const angles = new Map([[input.name, theta], [output.name, flip * phi]]);

  const side = (s) => (s > 0 ? "ccw" : "cw");
  const wM = dot(input.center, input.axis);
  const drum = (extra) => ({ kind: "drum", name: input.name, center: input.center, axis: input.axis, radius: input.radius, side: side(sIn), lead, w: wM, ...extra });
  const pulley = (w, extra) => ({ kind: "drum", name: output.name, center: output.center, axis: input.axis, radius: output.radius, side: side(sOut), w, ...extra });

  // What the tangents alone leave on the drum between the two spans: M sits half-way round
  // it, plus `turns` whole turns shared between the two sides.
  const bare = (a, b) => solveTaut({ d: rope.d, through: [a, b] });
  const in1 = bare(pulley(0, { fixed: { wrap: 0 } }), drum({ fixed: { wrap: 0 } })).wraps[1].entry;
  const out2 = bare(drum({ fixed: { wrap: 0 } }), pulley(0, { fixed: { wrap: 0 } })).wraps[0].exit;
  const between = (((sIn * (out2 - in1)) % 360) + 360) % 360;
  const half = (between + 360 * turns) / 2;      // degrees of rope each side of M, at angle 0
  // The pulley's two grooves sit either side of its own centre, as far apart as the rope's
  // two ends on the drum at angle 0: a pulley level with the drum has no fleet at rest.
  const wA = wM + axial - (lead * half) / 360, wB = wM + axial + (lead * half) / 360;

  const solve = (th, ph) => [
    solveTaut({ d: rope.d, through: [pulley(wA, { fixed: { wrap: outWrap - sOut * ph } }), drum({ fixed: { wrap: half + sIn * th } })] }),
    solveTaut({ d: rope.d, through: [drum({ fixed: { wrap: half - sIn * th } }), pulley(wB, { fixed: { wrap: outWrap + sOut * ph } })] }),
  ];
  const halves = solve(theta, phi), rest = solve(0, 0);
  const total = (hs) => hs[0].length + hs[1].length;
  const length = total(halves), restLength = total(rest);

  // How far the drum can turn each way before one side has no rope left on a member.
  const limit = Math.min(half, (outWrap * rOut) / rIn);
  const inside = Math.abs(theta) <= limit + 1e-9;

  const who = (op, name) => (name === input.name ? input : name === output.name ? output : fail("", `${op}: unknown member ${JSON.stringify(name)}`));

  function report() {
    const drift = length - restLength;
    const bend = { [input.name]: r3((2 * input.radius) / rope.d), [output.name]: r3((2 * output.radius) / rope.d) };
    if (rope.minBendRatio != null) { bend.required = rope.minBendRatio; bend.ok = Math.min((2 * input.radius) / rope.d, (2 * output.radius) / rope.d) >= rope.minBendRatio; }
    const out = {
      ratio: r3(ratio), turnsTogether: !cross,
      angles: { [input.name]: r3(theta), [output.name]: r3(flip * phi) },
      length: r3(length), restLength: r3(restLength), drift: r3(drift),
      halves: halves.map((h, i) => {
        const [a, b] = h.wraps;
        const onDrum = i === 0 ? b : a, onPulley = i === 0 ? a : b;
        return { length: r3(h.length), span: r3(h.spans[0].length), fleet: r3(h.spans[0].fleet),
          [input.name]: { wrap: r3(onDrum.angle), turns: r3(onDrum.turns) }, [output.name]: { wrap: r3(onPulley.angle) },
          runOff: a.runOff || b.runOff };
      }),
      bend,
      // The rope is pinned at M, so the wound band shifts along the drum as it turns: over
      // the travel each side reaches its rest turns plus the travel.
      drumWidth: r3((Math.abs(lead) * 2 * (half + limit)) / 360 + rope.d),
      travel: { [input.name]: [r3(-limit), r3(limit)], [output.name]: [r3((-limit * rIn) / rOut), r3((limit * rIn) / rOut)], inside },
    };
    if (!fixed) {
      // The capstan equation: the tension ratio a friction wrap holds, e^(mu · wrap). Nothing
      // pins the rope at M, so the wrap is everything on the drum between the two spans:
      // both sides together, the same at every angle.
      const whole = 2 * half * RAD;
      out.holding = rope.mu == null ? { needs: "rope.mu" } : { mu: rope.mu, wrap: r3(2 * half), ratio: r3(Math.exp(rope.mu * whole)) };
    }
    if (rope.EA != null) {
      // Each half as a spring over its WHOLE length (the wrapped rope stretches too, held
      // back by friction, so this reads soft); the two halves act together on the pulley.
      const k = halves.map((h) => rope.EA / h.length);
      out.stiffness = { rope: k.map(r3), joint: r3((k[0] + k[1]) * rOut * rOut), unit: "N/mm, N·mm/rad", upperBound: rope.bound };
      out.tensionChange = r3((rope.EA * drift) / restLength);
      if (pretension != null) out.slack = pretension + (rope.EA * drift) / restLength <= 0;
    }
    return out;
  }

  return {
    /** Input turns per output turn: the pitch radii's ratio. */
    ratio,
    /** The member's angle about its own axis, degrees, unreduced. */
    angleOf: (name) => angles.get(who("angleOf", name).name),
    /** `<member>.center` and `<member>.rim` (on the pitch circle, turned by its angle), an axis per member, a line between them. */
    handleInfo() {
      const points = {}, axes = {};
      for (const q of [input, output]) {
        points[`${q.name}.center`] = json3(q.center);
        points[`${q.name}.rim`] = json3(onCircle(q.center, q.frame, q.radius + rope.d / 2, angles.get(q.name)));
        axes[q.name] = { origin: json3(q.center), direction: json3(q.axis) };
      }
      return { kind: "partforge.points", points, axes, lines: [[`${input.name}.center`, `${output.name}.center`]] };
    },
    /** The rope's centreline at this pose, plain JSON: one open line, output to drum to output. */
    lineInfo() {
      const pts = [...halves[0].points, ...halves[1].points.slice(1)].map((q) => json3(q.map(r3)));
      return { kind: "partforge.lines", lines: { rope: { mode: "taut", d: rope.d, closed: false, points: pts } } };
    },
    /** What the rope is doing at this pose, plain JSON (a probe can return it unchanged). */
    report,
    /** A solid built about +Z through the origin, turned to the member's angle and set at its centre. */
    place: (name, solid) => {
      const q = who("place", name);
      return placeIn(solid, q.frame, angles.get(q.name), q.center);
    },
  };
}

// A reader for exactly the SVG subset export/svg.js writes — no more — so the kit's SVG
// tests can assert physical geometry (mm size, arc centres, region areas) instead of
// string shapes. Absolute M/L/A/C/Z only; anything else throws, because a writer that
// starts emitting relative commands or transforms has left the subset the laser
// importers were checked against (design spec D.6).
//
// Coordinates come back in SVG's frame (y down). `arcGeometry` and `ringArea` un-flip
// with the document height, so tests compare against the Drawing's y-up numbers.

const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

export function parseSvg(text) {
  const root = text.match(/<svg\b([^>]*)>/);
  if (!root) throw new Error("svg-subset: no <svg> root");
  const rootAttrs = attrsOf(root[1]);
  const title = text.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? null;
  const groups = [...text.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/g)].map((m) => ({
    attrs: attrsOf(m[1]),
    paths: [...m[2].matchAll(/<path\b([^>]*)\/>/g)].map((p) => {
      const attrs = attrsOf(p[1]);
      return { attrs, subpaths: parsePathData(attrs.d) };
    }),
  }));
  return { rootAttrs, title, groups, height: Number(rootAttrs.viewBox.split(/\s+/)[3]) };
}

// "M x y L x y A r r 0 f f x y C … Z" → [{ start, segs: [{ cmd, … }], closed }]
export function parsePathData(d) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out = [];
  let i = 0, cur = null;
  const num = () => { const v = Number(tokens[i++]); if (!Number.isFinite(v)) throw new Error(`svg-subset: bad number near token ${i}`); return v; };
  const pt = () => [num(), num()];
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") { cur = { start: pt(), segs: [], closed: false }; out.push(cur); }
    else if (cmd === "L") cur.segs.push({ cmd, to: pt() });
    else if (cmd === "C") cur.segs.push({ cmd, c1: pt(), c2: pt(), to: pt() });
    else if (cmd === "A") {
      const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
      cur.segs.push({ cmd, rx, ry, rot, large, sweep, to: pt() });
    } else if (cmd === "Z") cur.closed = true;
    else throw new Error(`svg-subset: command "${cmd}" is outside the writer's subset`);
  }
  return out;
}

// SVG endpoint arc → centre form (SVG 1.1 F.6.5, rx = ry, no rotation), then un-flipped:
// { center: [x, y] in the y-up frame, r, dA } with dA signed CCW-positive in that frame.
export function arcGeometry(from, seg, height) {
  let r = seg.rx;
  const [x1, y1] = from, [x2, y2] = seg.to;
  const hx = (x1 - x2) / 2, hy = (y1 - y2) / 2;
  const lambda = (hx * hx + hy * hy) / (r * r);
  if (lambda > 1) r *= Math.sqrt(lambda);
  const num = r * r * r * r - r * r * hy * hy - r * r * hx * hx;
  const den = r * r * hy * hy + r * r * hx * hx;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (seg.large === seg.sweep) coef = -coef;
  const cxp = coef * hy, cyp = -coef * hx;
  const cx = cxp + (x1 + x2) / 2, cy = cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  let dt = angle((hx - cxp) / r, (hy - cyp) / r, (-hx - cxp) / r, (-hy - cyp) / r);
  if (seg.sweep === 0 && dt > 0) dt -= 2 * Math.PI;
  else if (seg.sweep === 1 && dt < 0) dt += 2 * Math.PI;
  return { center: [cx, height - cy], r, dA: -dt };   // the y flip mirrors the sweep
}

// Signed area of one closed subpath in the y-up frame: shoelace over its vertices, plus
// each arc's circular segment r²/2·(θ − sin θ), plus cubics sampled at 64 steps.
export function ringArea(sub, height) {
  const up = ([x, y]) => [x, height - y];
  const pts = [up(sub.start)];
  let extra = 0;
  let from = sub.start;
  for (const s of sub.segs) {
    if (s.cmd === "C") {
      for (let k = 1; k <= 64; k++) {
        const t = k / 64, u = 1 - t;
        const x = u * u * u * from[0] + 3 * u * u * t * s.c1[0] + 3 * u * t * t * s.c2[0] + t * t * t * s.to[0];
        const y = u * u * u * from[1] + 3 * u * u * t * s.c1[1] + 3 * u * t * t * s.c2[1] + t * t * t * s.to[1];
        pts.push(up([x, y]));
      }
    } else {
      if (s.cmd === "A") { const g = arcGeometry(from, s, height); extra += (g.r * g.r / 2) * (g.dA - Math.sin(g.dA)); }
      pts.push(up(s.to));
    }
    from = s.to;
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2 + extra;
}

// A reader for exactly the R12 DXF subset export/dxf.js writes: the HEADER variables,
// the LAYER table, and LINE / CIRCLE / POLYLINE-VERTEX-SEQEND entities. Anything else in
// ENTITIES throws — a writer that starts emitting LWPOLYLINE or SPLINE has left R12,
// which is what cutting services were checked against (design spec D.7).

export function parseDxf(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length % 2 !== 0) throw new Error("dxf-subset: odd number of lines — group codes and values must pair");
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) pairs.push([Number(lines[i].trim()), lines[i + 1]]);
  const header = {}, layers = [], entities = [];
  let i = 0;
  const at = (code, value) => pairs[i] && pairs[i][0] === code && (value === undefined || pairs[i][1] === value);
  // collect group codes until the next 0 group
  const body = () => { const o = {}; while (i < pairs.length && pairs[i][0] !== 0) { o[pairs[i][0]] = pairs[i][1]; i++; } return o; };
  while (i < pairs.length) {
    if (at(0, "EOF")) return { header, layers, entities, eof: true };
    if (!at(0, "SECTION")) throw new Error(`dxf-subset: expected SECTION at pair ${i}, got ${pairs[i]}`);
    i++;
    const name = pairs[i++][1];
    if (name === "HEADER") {
      while (!at(0, "ENDSEC")) { const variable = pairs[i++][1]; header[variable] = pairs[i++][1]; }
    } else if (name === "TABLES") {
      while (!at(0, "ENDSEC")) {
        if (at(0, "LAYER")) { i++; const o = body(); layers.push({ name: o[2], color: Number(o[62]), linetype: o[6] }); }
        else i++;
      }
    } else if (name === "ENTITIES") {
      while (!at(0, "ENDSEC")) {
        const type = pairs[i++][1];
        const o = body();
        if (type === "LINE") entities.push({ type, layer: o[8], a: [Number(o[10]), Number(o[20])], b: [Number(o[11]), Number(o[21])] });
        else if (type === "CIRCLE") entities.push({ type, layer: o[8], center: [Number(o[10]), Number(o[20])], r: Number(o[40]) });
        else if (type === "POLYLINE") {
          const poly = { type, layer: o[8], closed: (Number(o[70]) & 1) === 1, vertices: [] };
          if (o[66] !== "1") throw new Error("dxf-subset: POLYLINE without 66 1");
          while (at(0, "VERTEX")) { i++; const v = body(); poly.vertices.push({ at: [Number(v[10]), Number(v[20])], bulge: Number(v[42] ?? 0), layer: v[8] }); }
          if (!at(0, "SEQEND")) throw new Error("dxf-subset: POLYLINE not ended by SEQEND");
          i++; body();
          entities.push(poly);
        } else throw new Error(`dxf-subset: entity ${type} is outside the writer's subset`);
      }
    } else throw new Error(`dxf-subset: unexpected section ${name}`);
    i++;   // ENDSEC
  }
  return { header, layers, entities, eof: false };
}

// The arc a bulge draws from a to b: θ = 4·atan(bulge) (CCW positive), r = chord / (2·|sin(θ/2)|).
export function bulgeArc(a, b, bulge) {
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
  // centre: from the chord midpoint along its left normal (right for a CW bulge) by r·cos(θ/2)
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const ux = (b[0] - a[0]) / chord, uy = (b[1] - a[1]) / chord;
  const h = r * Math.cos(theta / 2) * Math.sign(theta);
  return { theta, r, center: [mx - uy * h, my + ux * h] };
}

// Signed area of a closed POLYLINE: shoelace over the vertices plus each bulge's circular
// segment r²/2·(θ − sin θ).
export function polylineArea(poly) {
  const v = poly.vertices;
  let a = 0, extra = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i].at, q = v[(i + 1) % v.length].at;
    a += p[0] * q[1] - q[0] * p[1];
    if (v[i].bulge !== 0) { const g = bulgeArc(p, q, v[i].bulge); extra += (g.r * g.r / 2) * (g.theta - Math.sin(g.theta)); }
  }
  return a / 2 + extra;
}

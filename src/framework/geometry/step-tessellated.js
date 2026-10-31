// Tessellated bodies in a STEP file OCCT wrote. OCCT 7.6 (the replicad build) cannot write
// AP242's tessellated geometry, so a mesh body reaches the file as a stand-in: OCCT writes a
// small B-rep solid with the body's name and colour, and this rewrites it in place.
//
// OCCT writes each body as its own product, ending in
//   #rep = ADVANCED_BREP_SHAPE_REPRESENTATION('', (#axis, #solid), #ctx)
//   #solid = MANIFOLD_SOLID_BREP(...)
// with the body's colour a STYLED_ITEM that points at #solid. The splice keeps every id
// that matters: #rep becomes a TESSELLATED_SHAPE_REPRESENTATION over the same items,
// #solid becomes a TESSELLATED_SOLID of one TRIANGULATED_FACE over a COORDINATES_LIST
// (both appended), and the stand-in's B-rep entities, now unreferenced, are dropped. So
// the product, its name, its placement and its colour are OCCT's own.
//
// Bodies are found by WRITE ORDER (the n-th SHAPE_DEFINITION_REPRESENTATION is the n-th
// body toSTEP was given), never by reading a name back: OCCT escapes names, and two
// bodies may share one. Pure JS, no kernel: test/step-tessellated.test.js.

const fail = (msg) => { throw new Error(`STEP splice: ${msg}`); };

/**
 * The DATA section as entities, each with the exact source range it came from, so an
 * entity the splice does not touch is copied byte for byte. Quoted strings are respected
 * ('' is an escaped quote).
 */
function parseData(text) {
  const start = text.indexOf("DATA;");
  const end = text.lastIndexOf("ENDSEC;");
  if (start < 0 || end < start) fail("no DATA section");
  const entities = new Map();
  let segStart = start + 5, inString = false;
  for (let i = segStart; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 39 /* ' */) {
      if (inString && text.charCodeAt(i + 1) === 39) { i++; continue; }
      inString = !inString;
    } else if (!inString && c === 59 /* ; */) {
      let segEnd = i + 1;
      while (segEnd < end && (text[segEnd] === "\n" || text[segEnd] === "\r")) segEnd++;
      const raw = text.slice(segStart, i);
      const m = /^\s*#(\d+)\s*=\s*([\s\S]*)$/.exec(raw);
      if (!m) fail(`unreadable entity near "${raw.trim().slice(0, 40)}"`);
      entities.set(Number(m[1]), { from: segStart, to: segEnd, body: m[2] });
      segStart = segEnd;
    }
  }
  return { entities, dataStart: start + 5, dataEnd: end };
}

const typeOf = (body) => /^\(?\s*([A-Z0-9_]+)/.exec(body)?.[1];
const refsOf = (body) => {
  const out = [];
  for (const m of body.replace(/'(?:[^']|'')*'/g, "''").matchAll(/#(\d+)/g)) out.push(Number(m[1]));
  return out;
};

/** A float32 coordinate as the shortest STEP REAL that reads back to the same float32. */
export function stepReal(v) {
  const f = Math.fround(v);
  let t = "";
  for (let p = 1; p <= 9; p++) { t = f.toPrecision(p); if (Math.fround(+t) === f) break; }
  const [mant, exp] = String(+t).toUpperCase().split("E");
  const m = mant.includes(".") ? mant : `${mant}.`;
  return exp === undefined ? m : `${m}E${exp}`;
}

/**
 * Rewrite the given bodies of an OCCT STEP file as tessellated solids.
 * bodies: [{ index, positions, indices }] — `index` is the body's 0-based write order;
 * positions are xyz triples, indices 0-based triangle corners. Returns the file's bytes.
 */
export function spliceTessellated(text, bodies) {
  const { entities, dataStart, dataEnd } = parseData(text);
  const sdrs = [...entities].filter(([, e]) => typeOf(e.body) === "SHAPE_DEFINITION_REPRESENTATION").map(([id]) => id).sort((a, b) => a - b);
  const replaced = new Map();   // id → new body
  const removable = new Set();  // the stand-ins' B-rep entities, before the sweep
  const appended = [];          // [id, body]
  let nextId = Math.max(...entities.keys()) + 1;

  for (const { index, positions, indices } of bodies) {
    if (!(index >= 0 && index < sdrs.length)) fail(`body ${index} is not in the file (it has ${sdrs.length})`);
    if (positions.length % 3 || indices.length % 3 || indices.length === 0) fail(`body ${index}'s mesh is not whole triangles`);
    const repId = refsOf(entities.get(sdrs[index]).body)[1];
    const rep = entities.get(repId);
    if (typeOf(rep?.body) !== "ADVANCED_BREP_SHAPE_REPRESENTATION") fail(`body ${index}'s representation is ${typeOf(rep?.body)}, not a B-rep stand-in`);
    const solidId = refsOf(rep.body).find((r) => typeOf(entities.get(r)?.body) === "MANIFOLD_SOLID_BREP");
    if (solidId === undefined) fail(`body ${index} has no MANIFOLD_SOLID_BREP`);

    // Everything under the stand-in solid is a sweep candidate; the solid itself is kept.
    const stack = refsOf(entities.get(solidId).body);
    while (stack.length) {
      const id = stack.pop();
      if (removable.has(id)) continue;
      removable.add(id);
      stack.push(...refsOf(entities.get(id)?.body ?? ""));
    }

    const npoints = positions.length / 3;
    const coords = new Array(npoints);
    for (let i = 0; i < npoints; i++) coords[i] = `(${stepReal(positions[3 * i])},${stepReal(positions[3 * i + 1])},${stepReal(positions[3 * i + 2])})`;
    const tris = new Array(indices.length / 3);
    for (let t = 0; t < tris.length; t++) {
      const a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
      if (a >= npoints || b >= npoints || c >= npoints) fail(`body ${index} has a triangle index past its ${npoints} points`);
      tris[t] = `(${a + 1},${b + 1},${c + 1})`;
    }
    const coordsId = nextId++, faceId = nextId++;
    appended.push([coordsId, `COORDINATES_LIST('',${npoints},(${coords.join(",")}))`]);
    appended.push([faceId, `TRIANGULATED_FACE('',#${coordsId},${npoints},(),$,(),(${tris.join(",")}))`]);
    replaced.set(solidId, `TESSELLATED_SOLID('',(#${faceId}),$)`);
    replaced.set(repId, rep.body.replace(/^\s*ADVANCED_BREP_SHAPE_REPRESENTATION/, "TESSELLATED_SHAPE_REPRESENTATION"));
  }

  // Sweep: a candidate stays if anything outside the candidates (as rewritten) still
  // reaches it — a shared placement or context, say.
  const bodyOf = (id) => replaced.get(id) ?? entities.get(id).body;
  const kept = new Set();
  const stack = [];
  for (const id of entities.keys()) if (!removable.has(id)) stack.push(...refsOf(bodyOf(id)));
  while (stack.length) {
    const id = stack.pop();
    if (!removable.has(id) || kept.has(id)) continue;
    kept.add(id);
    stack.push(...refsOf(bodyOf(id)));
  }

  const chunks = [text.slice(0, dataStart)];
  let cursor = dataStart;
  for (const [id, e] of [...entities].sort((a, b) => a[1].from - b[1].from)) {
    if (e.from > cursor) chunks.push(text.slice(cursor, e.from));
    cursor = e.to;
    if (removable.has(id) && !kept.has(id)) continue;
    chunks.push(replaced.has(id) ? `#${id} = ${replaced.get(id)};\n` : text.slice(e.from, e.to));
  }
  if (cursor < dataEnd) chunks.push(text.slice(cursor, dataEnd));
  for (const [id, body] of appended) chunks.push(`#${id} = ${body};\n`);
  chunks.push(text.slice(dataEnd));
  return new TextEncoder().encode(chunks.join(""));
}

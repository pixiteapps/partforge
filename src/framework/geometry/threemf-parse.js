// Minimal 3MF reader, the read twin of threemf.js's writer. 3MF is an OPC
// package (a zip) holding one or more XML model parts; unzip (fflate), find the
// ROOT model part, extract vertices/triangles, resolve <components> and per-item
// transforms, and merge every build item into one soup-free indexed mesh in
// millimetres.
//
// Slicer project files (Bambu Studio, Orca, PrusaSlicer) keep no mesh in the
// root part at all: its objects are <components> pointing, through the
// Production extension's `p:path`, at meshes in other parts
// (3D/Objects/object_1.model). Reading only one part — or only top-level
// <object><mesh> — finds nothing in exactly the files people export most.
//
// Regex-based extraction, NOT a DOM parse — workers have no DOMParser and the
// worker graph must stay DOM-free (test/worker-layering.test.js enforces
// this transitively). Scope: geometry only — materials, colors and beam
// lattices are ignored.
import { unzipSync } from "fflate";

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const MAX_COMPONENT_DEPTH = 32;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

// Part names are compared without a leading slash and case-insensitively: OPC
// names are case-insensitive, and references carry a leading "/" that zip
// entry names do not.
const partKey = (name) => name.replace(/^\/+/, "").toLowerCase();

// Transforms are 12 numbers, row-major 4x3 with the translation in the last
// row, per the 3MF core spec (applied to a row vector: v' = v*M, i.e.
// x' = x*m00 + y*m10 + z*m20 + m30). The translation is in the units of the
// part that holds the transform, so it is scaled to mm on read; the linear
// part is unitless.
function readTransform(tag, scale) {
  const raw = tag.match(/\btransform="([^"]+)"/)?.[1];
  if (!raw) return IDENTITY;
  const t = raw.trim().split(/\s+/).map(Number);
  if (t.length !== 12 || t.some((n) => !Number.isFinite(n))) return IDENTITY;
  return [...t.slice(0, 9), t[9] * scale, t[10] * scale, t[11] * scale];
}

// Child first, then parent: v * C * P.
function compose(c, p) {
  const r = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      r[row * 3 + col] =
        c[row * 3] * p[col] + c[row * 3 + 1] * p[3 + col] + c[row * 3 + 2] * p[6 + col] + (row === 3 ? p[9 + col] : 0);
    }
  }
  return r;
}

// The OPC/Production-extension `path` attribute, whatever its namespace prefix.
const readPath = (tag) => tag.match(/\s(?:[\w.-]+:)?path="([^"]+)"/)?.[1] ?? null;

function rootModelPath(files, keys) {
  const rels = files.get("_rels/.rels");
  if (rels) {
    const xml = new TextDecoder().decode(rels);
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const type = m[0].match(/\bType="([^"]+)"/)?.[1] ?? "";
      const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
      if (target && /\/3dmodel$/i.test(type) && files.has(partKey(target))) return partKey(target);
    }
  }
  if (files.has("3d/3dmodel.model")) return "3d/3dmodel.model";
  return keys.find((k) => k.endsWith(".model")) ?? null;
}

function parseModelPart(xml, key) {
  const unit = xml.match(/<model\b[^>]*\bunit="([^"]+)"/)?.[1] ?? "millimeter";
  const scale = UNIT_MM[unit];
  if (!scale) throw new Error(`3mf import: unknown unit "${unit}"`);

  // objects: id -> { type, mesh: {P (mm), I} | null, components: [{key, id, t}] }
  const objects = new Map();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  for (let m; (m = objRe.exec(xml)); ) {
    const [, attrs, body] = m;
    const id = attrs.match(/\bid="(\d+)"/)?.[1];
    if (!id) continue;
    const type = attrs.match(/\btype="([^"]+)"/)?.[1] ?? "model";
    const P = [], I = [];
    const vRe = /<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g;
    for (let v; (v = vRe.exec(body)); ) P.push(+v[1] * scale, +v[2] * scale, +v[3] * scale);
    const tRe = /<triangle\b[^>]*\bv1="(\d+)"[^>]*\bv2="(\d+)"[^>]*\bv3="(\d+)"/g;
    for (let t; (t = tRe.exec(body)); ) I.push(+t[1], +t[2], +t[3]);
    const components = [];
    for (const c of body.matchAll(/<component\b[^>]*>/g)) {
      const cid = c[0].match(/\bobjectid="(\d+)"/)?.[1];
      if (!cid) continue;
      const path = readPath(c[0]);
      components.push({ key: path ? partKey(path) : key, id: cid, t: readTransform(c[0], scale) });
    }
    objects.set(id, { type, mesh: I.length ? { P, I } : null, components });
  }

  // Build items. Attributes are pulled independently from each <item> tag
  // (rather than in one fixed-order regex) because `objectid` and `transform`
  // can appear in either order and a single ordered pattern with an optional
  // middle group can match the tag while silently leaving `transform`
  // uncaptured. Items may be self-closing or carry children (metadata).
  const items = [];
  const build = xml.match(/<build\b[^>]*>([\s\S]*?)<\/build>/)?.[1] ?? "";
  for (const m of build.matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bobjectid="(\d+)"/)?.[1];
    if (!id) continue;
    const path = readPath(m[0]);
    items.push({ key: path ? partKey(path) : key, id, t: readTransform(m[0], scale) });
  }
  return { objects, items };
}

export function parse3MF(bytes) {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let raw;
  try {
    raw = unzipSync(u8);
  } catch (e) {
    throw new Error(`3mf import: not a readable zip archive (${e?.message || e})`, { cause: e });
  }
  const files = new Map(Object.entries(raw).map(([name, data]) => [partKey(name), data]));
  const root = rootModelPath(files, [...files.keys()]);
  if (!root) throw new Error("3mf import: archive has no 3D model part (*.model)");

  const parts = new Map();
  const partFor = (key) => {
    if (!parts.has(key)) {
      const data = files.get(key);
      if (!data) throw new Error(`3mf import: a component references a missing model part (/${key})`);
      parts.set(key, parseModelPart(new TextDecoder().decode(data), key));
    }
    return parts.get(key);
  };

  const V = [], Tr = [];
  const emit = ({ P, I }, t) => {
    const base = V.length / 3;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      V.push(
        t[0] * x + t[3] * y + t[6] * z + t[9],
        t[1] * x + t[4] * y + t[7] * z + t[10],
        t[2] * x + t[5] * y + t[8] * z + t[11],
      );
    }
    for (const idx of I) Tr.push(base + idx);
  };
  const place = (key, id, t, stack) => {
    const ref = `${key}#${id}`;
    if (stack.includes(ref) || stack.length > MAX_COMPONENT_DEPTH) {
      throw new Error("3mf import: components reference each other in a loop");
    }
    const o = partFor(key).objects.get(id);
    if (!o) return;
    // Support and "other" objects are not part of the printed shape.
    if (o.type === "support" || o.type === "other") return;
    if (o.mesh) emit(o.mesh, t);
    for (const c of o.components) place(c.key, c.id, compose(c.t, t), [...stack, ref]);
  };

  // No <build> items: every object in the root part that no component uses,
  // at identity.
  const rootPart = partFor(root);
  let items = rootPart.items;
  if (!items.length) {
    const used = new Set();
    for (const o of rootPart.objects.values()) for (const c of o.components) if (c.key === root) used.add(c.id);
    items = [...rootPart.objects.keys()].filter((id) => !used.has(id)).map((id) => ({ key: root, id, t: IDENTITY }));
  }
  for (const { key, id, t } of items) place(key, id, t, []);

  if (Tr.length === 0) throw new Error("3mf import: model contains no mesh geometry");
  return { positions: Float32Array.from(V), indices: Uint32Array.from(Tr) };
}

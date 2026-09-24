// src/framework/materials/print-bed.js
// The print-bed environment's ground: not a disc fading into the backdrop but
// a real build plate — a rounded, square PEI sheet of a standard size, cut out
// of nothing, with white markings printed on it: a millimetre ruler along the
// left and back edges, the partforge wordmark in the front-left corner, the
// plate's own size in the front-right, and a lift tab with diagonal sides off
// the middle of the front edge. Like the disc, it comes to the
// part (centred under its footprint) and never moves it.
import * as THREE from "three";

// Common square bed sizes, smallest first; a footprint past the last rounds up
// to the next 50 mm.
export const BED_SIZES_MM = [180, 220, 256, 350];
const MARGIN_MM = 16; // clear plate kept around the footprint when picking a size
const THICKNESS_MM = 2.5;
const CORNER_MM = 6;
// The lift tab on the front edge: wide where it meets the plate, narrower at
// its tip, so its two sides run diagonally.
const TAB_BASE_MM = 44;
const TAB_TIP_MM = 26;
const TAB_DEPTH_MM = 9;

export function bedSizeFor(footprintMm) {
  const need = footprintMm + MARGIN_MM * 2;
  return BED_SIZES_MM.find((s) => s >= need) ?? Math.ceil(need / 50) * 50;
}

function plateGeometry(size) {
  const h = size / 2, r = CORNER_MM;
  const shape = new THREE.Shape();
  // Shape y = -h is the FRONT edge (it lands at +Z once laid flat), and the
  // lift tab sticks out of its middle: a trapezoid with diagonal sides.
  const tb = TAB_BASE_MM / 2, tt = TAB_TIP_MM / 2, td = TAB_DEPTH_MM;
  shape.moveTo(-h + r, -h);
  shape.lineTo(-tb, -h); shape.lineTo(-tt, -h - td); shape.lineTo(tt, -h - td); shape.lineTo(tb, -h);
  shape.lineTo(h - r, -h); shape.quadraticCurveTo(h, -h, h, -h + r);
  shape.lineTo(h, h - r); shape.quadraticCurveTo(h, h, h - r, h);
  shape.lineTo(-h + r, h); shape.quadraticCurveTo(-h, h, -h, h - r);
  shape.lineTo(-h, -h + r); shape.quadraticCurveTo(-h, -h, -h + r, -h);
  // Extruded along +Z then laid flat: the top cap ends up at y = 0, the plate
  // hangs below it, and the caps' UVs are shape coordinates — millimetres.
  const g = new THREE.ExtrudeGeometry(shape, { depth: THICKNESS_MM, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -THICKNESS_MM, 0);
  return g;
}

function defaultCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") return Object.assign(document.createElement("canvas"), { width: w, height: h });
  return null;
}

// Draws the markings for a plate `size` mm square onto a transparent canvas
// (top of the canvas = back of the bed). Returns null where there is no 2D
// canvas (tests, a worker): the plate is then just unmarked PEI.
export function drawBedMarkings(size, createCanvas = defaultCanvas) {
  const px = 2048;
  const canvas = createCanvas(px, px);
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) return null;
  const k = px / size; // pixels per millimetre
  const ink = "rgba(255,255,255,0.88)";
  const mono = (mm, weight = 600) => `${weight} ${Math.round(mm * k)}px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.clearRect(0, 0, px, px);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = "round";

  // Printable-area outline, inset from the edge.
  const inset = 5;
  ctx.lineWidth = 0.35 * k;
  ctx.beginPath();
  ctx.roundRect(inset * k, inset * k, (size - inset * 2) * k, (size - inset * 2) * k, (CORNER_MM - 2) * k);
  ctx.stroke();

  // Ruler: a tick every 10 mm, a longer numbered one every 50 mm, along the
  // back edge (left to right) and the left edge (front to back), measured
  // from the front-left corner the way a slicer's bed is.
  const ruler = inset + 1;
  ctx.font = mono(3.2, 500);
  for (let mm = 10; mm < size - inset; mm += 10) {
    const major = mm % 50 === 0;
    const len = (major ? 4 : 2) * k;
    ctx.lineWidth = (major ? 0.45 : 0.3) * k;
    ctx.beginPath(); // back edge: x = mm
    ctx.moveTo(mm * k, ruler * k); ctx.lineTo(mm * k, ruler * k + len);
    ctx.stroke();
    ctx.beginPath(); // left edge: z = mm from the front
    ctx.moveTo(ruler * k, (size - mm) * k); ctx.lineTo(ruler * k + len, (size - mm) * k);
    ctx.stroke();
    if (!major) continue;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(String(mm), mm * k, ruler * k + len + 1 * k);
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(String(mm), ruler * k + len + 1 * k, (size - mm) * k);
  }

  // A small centre cross.
  ctx.lineWidth = 0.35 * k;
  const c = (size / 2) * k, arm = 3 * k;
  ctx.beginPath();
  ctx.moveTo(c - arm, c); ctx.lineTo(c + arm, c);
  ctx.moveTo(c, c - arm); ctx.lineTo(c, c + arm);
  ctx.stroke();

  // Front strip: the wordmark in the left corner, the plate's size in the
  // right, leaving the middle clear for the lift tab.
  const front = (size - inset - 7) * k;
  ctx.textBaseline = "middle";
  ctx.font = mono(Math.min(8, size * 0.03));
  ctx.textAlign = "left";
  ctx.fillText("partforge", (inset + 5) * k, front);
  ctx.textAlign = "right";
  ctx.font = mono(Math.min(5, size * 0.02), 500);
  ctx.fillText(`${size} × ${size} mm`, (size - inset - 5) * k, front);
  return canvas;
}

// `pei` is the plate's surface material (the PEI colour + roughness maps with
// UVs in millimetres, repeat 1/tileMm); the rest is built and owned here.
export function createPrintBed({ pei, tileMm, createCanvas }) {
  const group = new THREE.Group();
  const edge = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, metalness: 0.6, roughness: 0.45 });
  const plate = new THREE.Mesh(new THREE.BufferGeometry(), [pei, edge]);
  const inkMat = new THREE.MeshStandardMaterial({
    transparent: true, roughness: 0.6, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const ink = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), inkMat);
  ink.visible = false;
  group.add(plate, ink);
  group.renderOrder = -1;
  let size = 0;
  let inkTex = null;

  function setSize(next) {
    if (next === size) return;
    size = next;
    plate.geometry.dispose();
    plate.geometry = plateGeometry(size);
    for (const t of [pei.map, pei.roughnessMap]) t?.repeat.set(1 / tileMm, 1 / tileMm);
    inkTex?.dispose();
    inkTex = null;
    const canvas = drawBedMarkings(size, createCanvas);
    if (canvas) {
      inkTex = new THREE.CanvasTexture(canvas);
      inkTex.colorSpace = THREE.SRGBColorSpace;
      inkTex.anisotropy = 8;
    }
    inkMat.map = inkTex;
    inkMat.needsUpdate = true;
    ink.visible = !!inkTex;
    ink.scale.set(size, 1, size);
  }

  return {
    object: group,
    get sizeMm() { return size; },
    place({ y, centerX = 0, centerZ = 0, footprintMm }) {
      setSize(bedSizeFor(footprintMm));
      group.position.set(centerX, y - 0.01, centerZ);
    },
    dispose() {
      plate.geometry.dispose(); ink.geometry.dispose();
      edge.dispose(); inkMat.dispose(); inkTex?.dispose();
    },
  };
}
